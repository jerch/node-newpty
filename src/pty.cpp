#include "nan.h"
#include <termios.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <stdlib.h>
#include <fcntl.h>
#include <poll.h>

// typical OS defines: https://sourceforge.net/p/predef/wiki/OperatingSystems/

#if defined(sun) || defined(__sun)
# if defined(__SVR4) || defined(__svr4__)
#define SOLARIS 1
# else
// SunOS - not supported
# endif
#endif

#if defined(SOLARIS)
#include <stropts.h>
#endif

// macro for object attributes
#define SET(obj, name, symbol)                                                \
obj->Set(Nan::New<String>(name).ToLocalChecked(), symbol)

#define POLL_BUFSIZE 16384  // poll thread buffer size
#define POLL_TIMEOUT 10     // poll timeout in msec

#ifndef TEMP_FAILURE_RETRY
#define TEMP_FAILURE_RETRY(exp)            \
  ({                                       \
    int _rc;                               \
    do {                                   \
      _rc = (exp);                         \
    } while (_rc == -1 && errno == EINTR); \
    _rc;                                   \
  })
#endif


using namespace node;
using namespace v8;


inline int nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags == -1)
        return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

inline int cloexec(int fd) {
    int flags = fcntl(fd, F_GETFD, 0);
    if (flags == -1)
        return -1;
    return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

/**
 * PTY and TTY primitives
 */

NAN_METHOD(js_posix_openpt) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: posix_openpt(flags)");
    int fd = posix_openpt(info[0]->IntegerValue());
    cloexec(fd);
    nonblock(fd);
    if (fd < 0) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("posix_openpt failed - ") + error).c_str());
    }
    info.GetReturnValue().Set(Nan::New<Number>(fd));
}

NAN_METHOD(js_grantpt) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: grantpt(fd)");
    // TODO: disable SIGCHLD
    if (grantpt(info[0]->IntegerValue())) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("grantpt failed - ") + error).c_str());
    }
    info.GetReturnValue().SetUndefined();
}

NAN_METHOD(js_unlockpt) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: grantpt(fd)");
    if (unlockpt(info[0]->IntegerValue())) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("unlockpt failed - ") + error).c_str());
    }
    info.GetReturnValue().SetUndefined();
}

NAN_METHOD(js_ptsname) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: ptsname(fd)");
    char *slavename = ptsname(info[0]->IntegerValue());
    if (!slavename) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("ptsname failed - ") + error).c_str());
    }
    info.GetReturnValue().Set(Nan::New<String>(slavename).ToLocalChecked());
}

NAN_METHOD(js_pty_get_size) {
    if (info.Length() != 1 || !info[0]->IsNumber())
        return Nan::ThrowError("usage: pty.get_size(fd)");

    struct winsize winp = winsize();
    int res = ioctl(info[0]->IntegerValue(), TIOCGWINSZ, &winp);
    if (res == -1) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("get_size failed - ") + error).c_str());
    }
    Local<Object> obj = Nan::New<Object>();
    SET(obj, "cols", Nan::New<Number>(winp.ws_col));
    SET(obj, "rows", Nan::New<Number>(winp.ws_row));
    info.GetReturnValue().Set(obj);
}

NAN_METHOD(js_pty_set_size) {
    if (info.Length() != 3
            || !info[0]->IsNumber()
            || !info[1]->IsNumber()
            || !info[2]->IsNumber())
        return Nan::ThrowError("usage: pty.set_size(fd, columns, rows)");

    struct winsize winp = winsize();
    winp.ws_col = info[1]->IntegerValue();
    winp.ws_row =  info[2]->IntegerValue();
    int res = ioctl(info[0]->IntegerValue(), TIOCSWINSZ, &winp);
    if (res == -1) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("get_size failed - ") + error).c_str());
    }
    Local<Object> obj = Nan::New<Object>();
    SET(obj, "cols", Nan::New<Number>(winp.ws_col));
    SET(obj, "rows", Nan::New<Number>(winp.ws_row));
    info.GetReturnValue().Set(obj);
}


/**
 *  Pty poll implementation
 *
 *  The implementation uses a libuv thread to do the polling on
 *  IO channels as following:
 *
 *   KERNEL           UV THREAD             MAIN THREAD
 *
 *                    +------+  read pipe
 *        +---------> |      | +----------> stdout
 *    PTY    master   | poll |              JAVASCRIPT
 *        <---------+ |      | <----------+ stdin
 *                    +------+  write pipe
 *
 *  For a pty master fd a single poll thread will be started by
 *  calling `get_io_channels`. The read and write pipes are nonblocking
 *  and can be accessed with `net.Socket` from Javascript.
 *  A final hangup on the slave side of the pty device will not be propagated
 *  to the right side until all pending data got consumed.
 */

struct Poll {
    int master;
    int read;
    int write;
    uv_async_t async;
    uv_thread_t tid;
};

inline void poll_thread(void *data) {
    Poll *poller = static_cast<Poll *>(data);

    // file descriptors
    int master = poller->master;  // pty master
    int reader = poller->read;    // read pipe
    int writer = poller->write;   // write pipe

    // "left side" data: master --> buf --> writer
    char l_buf[POLL_BUFSIZE];
    bool l_pending_write = false;
    int l_written = 0;
    int l_read = 0;

    // "right side" data: master <-- buf <-- reader
    char r_buf[POLL_BUFSIZE];
    bool r_pending_write = false;
    int r_written = 0;
    int r_read = 0;

    struct pollfd fds[] = {
        // master is a duplex pipe --> POLLOUT | POLLIN
        // NOTE: POLLHUP get always delivered, we dont have to register it
        {master, POLLOUT | POLLIN, 0},
        // writer is only writable --> POLLOUT
        {writer, POLLOUT, 0},
        // reader is only readable --> POLLIN
        {reader, POLLIN, 0}
    };
    int result;

    for (;;) {
        // reset struct pollfd
        fds[0].revents = 0;
        fds[1].revents = 0;
        fds[2].revents = 0;
        // query POLLOUT only if data needs to be written
        // to avoid 100% CPU usage on empty write pipes
        fds[0].events = (r_pending_write) ? POLLOUT | POLLIN : POLLIN;
        fds[1].events = (l_pending_write) ? POLLOUT : 0;

        TEMP_FAILURE_RETRY(result = poll(fds, 3, POLL_TIMEOUT));
        if (result == -1) {
            // something unexpected happened
            break;
        }

        // result denotes the number of file descriptors with poll events
        if (result) {
            // master write
            if (r_pending_write && fds[0].revents & POLLOUT) {
                int w = write(master, r_buf+r_written, r_read);
                if (w == -1)
                    break;
                if (w == r_read) {
                    r_pending_write = false;
                    r_written = 0;
                } else {
                    r_written += w;
                }
            }
            // writer write
            if (l_pending_write && fds[1].revents & POLLOUT) {
                int w = write(writer, l_buf+l_written, l_read);
                if (w == -1)
                    break;
                if (w == l_read) {
                    l_pending_write = false;
                    l_written = 0;
                } else {
                    l_written += w;
                }
            }
            // reader read
            if (!r_pending_write && fds[2].revents & POLLIN) {
                r_read = read(reader, r_buf, POLL_BUFSIZE);
                if (r_read == -1)
                    break;
                // OSX 10.10 & Solaris: on broken pipe POLLIN is set
                // and read returns 0 --> EOF
                if (!r_read)
                    break;
                r_pending_write = true;
            } else if (fds[2].revents & POLLHUP)
                break;
            // master read
            if (!l_pending_write && fds[0].revents & POLLIN) {
                l_read = read(master, l_buf, POLL_BUFSIZE);
                if (l_read == -1)
                    break;
                // OSX 10.10 & Solaris: if slave hang up poll returns with POLLIN
                // and read returns 0 --> EOF
                if (!l_read)
                    break;
                l_pending_write = true;
            } else if (fds[0].revents & POLLHUP) {
                // we got a POLLHUP (all slaves hang up and the pty got useless)
                // special case here: don't propagate hang up until we have written
                // all pending read data (no POLLIN anymore) --> fixes #85
                if (fds[0].revents & POLLIN)
                    continue;
                break;
            }
            // error on fds: POLLERR, POLLNVAL
            if(fds[0].revents & POLLERR || fds[0].revents & POLLNVAL)
                break;
            if(fds[1].revents & POLLERR || fds[1].revents & POLLNVAL)
                break;
            if(fds[2].revents & POLLERR || fds[2].revents & POLLNVAL)
                break;
        }
    }
    close(writer);
    close(reader);
    uv_async_send(&poller->async);
}

inline void close_poll_thread(uv_handle_t *handle) {
    uv_async_t *async = (uv_async_t *) handle;
    Poll *poller = static_cast<Poll *>(async->data);
    delete poller;
}

inline void after_poll_thread(uv_async_t *async) {
    uv_close((uv_handle_t *) async, close_poll_thread);
}

NAN_METHOD(get_io_channels) {
    if (info.Length() != 1 || !info[0]->IsNumber())
        return Nan::ThrowError("usage: pty.get_io_channels(fd)");

    Poll *poller = nullptr;

    // create pipes for reading and writing
    int pipes1[2] = {-1, -1};
    int pipes2[2] = {-1, -1};
    if (pipe(pipes1))
        goto exit;
    nonblock(pipes1[0]);
    cloexec(pipes1[0]);
    nonblock(pipes1[1]);
    cloexec(pipes1[1]);
    if (pipe(pipes2)) {
        close(pipes1[0]);
        close(pipes1[1]);
        pipes1[0] = -1;
        pipes1[1] = -1;
        goto exit;
    }
    nonblock(pipes2[0]);
    cloexec(pipes2[0]);
    nonblock(pipes2[1]);
    cloexec(pipes2[1]);

    // setup polling thread
    poller = new Poll();
    poller->master = info[0]->IntegerValue();
    poller->read = pipes2[0];
    poller->write = pipes1[1];
    poller->async.data = poller;

    uv_async_init(uv_default_loop(), &poller->async, after_poll_thread);
    uv_thread_create(&poller->tid, poll_thread, static_cast<void *>(poller));

    exit:
    Local<Object> obj = Nan::New<Object>();
    SET(obj, "read", Nan::New<Number>(pipes1[0]));
    SET(obj, "write", Nan::New<Number>(pipes2[1]));
    info.GetReturnValue().Set(obj);
}

NAN_METHOD(load_driver) {
#ifdef SOLARIS
    if (info.Length() != 1 || !info[0]->IsNumber())
        return Nan::ThrowError("usage: pty.load_driver(fd)");
    int slave = info[0]->IntegerValue();
    ioctl(slave, I_PUSH, "ptem");
    ioctl(slave, I_PUSH, "ldterm");
    ioctl(slave, I_PUSH, "ttcompat");  // TODO: do we need BSD compat mode?
#endif
}

/**
 * Exported symbols by the module
 */
NAN_MODULE_INIT(init) {
    SET(target, "openpt", Nan::New<FunctionTemplate>(js_posix_openpt)->GetFunction());
    SET(target, "grantpt", Nan::New<FunctionTemplate>(js_grantpt)->GetFunction());
    SET(target, "unlockpt", Nan::New<FunctionTemplate>(js_unlockpt)->GetFunction());
    SET(target, "ptsname", Nan::New<FunctionTemplate>(js_ptsname)->GetFunction());
    SET(target, "get_size", Nan::New<FunctionTemplate>(js_pty_get_size)->GetFunction());
    SET(target, "set_size", Nan::New<FunctionTemplate>(js_pty_set_size)->GetFunction());
    SET(target, "get_io_channels", Nan::New<FunctionTemplate>(get_io_channels)->GetFunction());
    SET(target, "load_driver", Nan::New<FunctionTemplate>(load_driver)->GetFunction());

    // needed fd flags
    Local<Object> fdflags = Nan::New<Object>();
    SET(fdflags, "O_RDONLY", Nan::New<Number>(O_RDONLY));
    SET(fdflags, "O_WRONLY", Nan::New<Number>(O_WRONLY));
    SET(fdflags, "O_RDWR", Nan::New<Number>(O_RDWR));
    SET(fdflags, "O_NOCTTY", Nan::New<Number>(O_NOCTTY));
    SET(fdflags, "O_NONBLOCK", Nan::New<Number>(O_NONBLOCK));
    SET(target, "FD_FLAGS", fdflags);
}

NODE_MODULE(pty, init)
