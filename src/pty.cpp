#include "nan.h"
#include "CTermios.h"
#include <termios.h>
#include <pty.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdlib.h>
#include <fcntl.h>
#include <utmp.h>
#include <poll.h>

// macro for object attributes
#define SET(obj, name, symbol)                                                \
obj->Set(Nan::New<String>(name).ToLocalChecked(), symbol)

// poll thread buffer size
#define POLL_BUFSIZE 16384
// poll timeout in msec
#define POLL_TIMEOUT 10

using namespace node;
using namespace v8;


// replacements of pty primitives
// forkpty --> #openpty, fork, login_tty
// openpty --> posix_openpt, grantpt, unlockpt
// login_tty --> setsid(); ioctl(0, TIOCSCTTY, 1); dup2(slave_fd, 0);  // TODO: check if available


NAN_METHOD(c_posix_openpt) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: posix_openpt(flags)");
    int fd = posix_openpt(info[0]->IntegerValue());
    if (fd < 0) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("posix_openpt failed - ") + error).c_str());
    }
    info.GetReturnValue().Set(Nan::New<Number>(fd));
}

NAN_METHOD(c_grantpt) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: grantpt(master_fd)");
    // TODO: disable SIGCHLD
    if (grantpt(info[0]->IntegerValue())) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("grantpt failed - ") + error).c_str());
    }
    info.GetReturnValue().SetUndefined();
}

NAN_METHOD(c_unlockpt) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: grantpt(master_fd)");
    if (unlockpt(info[0]->IntegerValue())) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("unlockpt failed - ") + error).c_str());
    }
    info.GetReturnValue().SetUndefined();
}

NAN_METHOD(c_ptsname) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: ptsname(master_fd)");
    char *slavename = ptsname(info[0]->IntegerValue());
    if (!slavename) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("ptsname failed - ") + error).c_str());
    }
    info.GetReturnValue().Set(Nan::New<String>(slavename).ToLocalChecked());
}

NAN_METHOD(c_login_tty) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: login_tty(slave_fd)");
    if (login_tty(info[0]->IntegerValue())) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("login_tty failed - ") + error).c_str());
    }
    info.GetReturnValue().SetUndefined();
}

NAN_METHOD(c_fork) {
    info.GetReturnValue().Set(Nan::New<Number>(fork()));
}

NAN_METHOD(c_get_size) {
    if (info.Length() != 1 || !info[0]->IsNumber())
        return Nan::ThrowError("usage: pty.get_size(fd)");

    struct winsize winp = winsize();
    int res = ioctl(info[0]->IntegerValue(), TIOCGWINSZ, &winp);
    if (res == -1) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("get_size failed - ") + error).c_str());
    }
    Local<Object> obj = Nan::New<Object>();
    SET(obj, "columns", Nan::New<Number>(winp.ws_col));
    SET(obj, "rows", Nan::New<Number>(winp.ws_row));
    info.GetReturnValue().Set(obj);
}

NAN_METHOD(c_set_size) {
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
    SET(obj, "columns", Nan::New<Number>(winp.ws_col));
    SET(obj, "rows", Nan::New<Number>(winp.ws_row));
    info.GetReturnValue().Set(obj);
}

NAN_METHOD(c_exec) {  // TODO: implement all exec* functions
    Nan::HandleScope scope;
    //execle("/bin/ls", "/bin/ls", "-lR", "--color=tty", "/usr/lib", NULL, environ);
    execle("/bin/bash", "/bin/bash", "-l", NULL, environ);
    printf("should not appear\n");
    info.GetReturnValue().SetUndefined();
}

struct Wait {
    Nan::Persistent<v8::Function> cb;
    pid_t pid;
    int options;
    uv_async_t async;
    uv_thread_t tid;
};

static void wait_runner(void *data) {
    Wait *baton = static_cast<Wait*>(data);
    int wstatus;
    pid_t res = waitpid(baton->pid, &wstatus, baton->options);
    baton->pid = res;
    baton->options = wstatus;
    uv_async_send(&baton->async);
}

static void close_wait_runner(uv_handle_t *handle) {
    uv_async_t *async = (uv_async_t *) handle;
    Wait *baton = static_cast<Wait*>(async->data);
    delete baton;
}

static void after_wait_runner(uv_async_t *async) {
    Nan::HandleScope scope;
    Wait *baton = static_cast<Wait*>(async->data);

    int wstatus = baton->options;
    pid_t pid = baton->pid;
    Local<Object> obj = Nan::New<Object>();
    SET(obj, "pid", Nan::New<Number>(pid));
    SET(obj, "WIFEXITED", Nan::New<Boolean>(WIFEXITED(wstatus)));
    SET(obj, "WEXITSTATUS", Nan::New<Number>(WIFEXITED(wstatus) ? WEXITSTATUS(wstatus): -1));
    SET(obj, "WIFSIGNALED", Nan::New<Boolean>(WIFSIGNALED(wstatus)));
    SET(obj, "WTERMSIG", Nan::New<Number>(WIFSIGNALED(wstatus) ? WTERMSIG(wstatus): -1));
#ifdef WCOREDUMP  // not on AIX, SunOS
    SET(obj, "WCOREDUMP", Nan::New<Boolean>(WIFSIGNALED(wstatus) ? WCOREDUMP(wstatus): -1));
#endif
    SET(obj, "WIFSTOPPED", Nan::New<Boolean>(WIFSTOPPED(wstatus)));
    SET(obj, "WSTOPSIG", Nan::New<Number>(WIFSTOPPED(wstatus) ? WSTOPSIG(wstatus): -1));
    SET(obj, "WIFCONTINUED", Nan::New<Boolean>(WIFCONTINUED(wstatus)));

    Local<Value> argv[] = {obj};
    Local<Function> cb = Nan::New<v8::Function>(baton->cb);
    baton->cb.Reset();
    Nan::Callback(cb).Call(Nan::GetCurrentContext()->Global(), 1, argv);
    uv_close((uv_handle_t *)async, close_wait_runner);
}

NAN_METHOD(c_waitpid) {
    if (info.Length() != 3
            || !info[0]->IsNumber()
            || !info[1]->IsNumber()
            || !info[2]->IsFunction())
        return Nan::ThrowError("usage: pty.waitpid(pid, options, cb)");

    pid_t pid = info[0]->IntegerValue();
    int options = info[1]->IntegerValue();

    Wait *baton = new Wait();
    baton->pid = pid;
    baton->options = options;
    baton->cb.Reset(v8::Local<v8::Function>::Cast(info[2]));
    baton->async.data = baton;

    uv_async_init(uv_default_loop(), &baton->async, after_wait_runner);
    uv_thread_create(&baton->tid, wait_runner, static_cast<void*>(baton));

    return info.GetReturnValue().SetUndefined();
}

struct Poll {
    int master;
    int read;
    int write;
    uv_async_t async;
    uv_thread_t tid;
};

static void poll_runner(void *data) {
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

    // "right side" data: reader --> buf --> master
    char r_buf[POLL_BUFSIZE];
    bool r_pending_write = false;
    int r_written = 0;
    int r_read = 0;
    int res;

    struct pollfd fds[] = {
        {master, POLLOUT | POLLIN | POLLHUP, 0},
        {writer, POLLOUT, 0},
        {reader, POLLIN, 0}
    };

    for (;;) {
        fds[0].revents = 0;
        fds[1].revents = 0;
        fds[2].revents = 0;
        fds[0].events = (r_pending_write) ? POLLOUT | POLLIN | POLLHUP : POLLIN | POLLHUP;
        fds[1].events = (l_pending_write) ? POLLOUT : 0;
        TEMP_FAILURE_RETRY(res = poll(fds, 3, POLL_TIMEOUT));  // handles EINTR, TODO: check portability
        if (res == -1) {
            // FIXME: something unexpected happened, how to deal with it?
            perror("poll error");
            break;
        }
        if (res) {
            // master write
            if (r_pending_write && fds[0].revents & POLLOUT) {
                int w = write(master, r_buf+r_written, r_read);
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
                r_pending_write = true;
            } else if (fds[2].revents & POLLHUP) {
                // FIXME: Do we need handle this case as well?
                close(writer);
                close(reader);
                break;
            }
            // master read
            if (!l_pending_write && fds[0].revents & POLLIN) {
                l_read = read(master, l_buf, POLL_BUFSIZE);
                l_pending_write = true;
            } else if (fds[0].revents & POLLHUP) {
                // we got a POLLHUP (all slaves hang up and the pty got useless)
                // special case here: don't propagate hang up until we have written
                // all pending read data (no POLLIN anymore) --> fixes #85
                if (fds[0].revents & POLLIN)
                    continue;
                // no pending data anymore, close pipes to JS
                close(writer);
                close(reader);
                break;
            }
        }
    }
    uv_async_send(&poller->async);
}

static void close_poll_runner(uv_handle_t *handle) {
    uv_async_t *async = (uv_async_t *) handle;
    Poll *poller = static_cast<Poll*>(async->data);
    delete poller;
}

static void after_poll_runner(uv_async_t *async) {
    Nan::HandleScope scope;
    uv_close((uv_handle_t *)async, close_poll_runner);
}

static int nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags == -1)
        return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

NAN_METHOD(get_io_channels) {
    if (info.Length() != 1
        || !info[0]->IsNumber())
    return Nan::ThrowError("usage: pty.get_fds(master_fd)");

    // create pipes for reading and writing
    int pipes1[2] = {-1, -1};
    int pipes2[2] = {-1, -1};
    Poll *poller = nullptr;
    if (pipe(pipes1))
        goto exit;
    nonblock(pipes1[0]);
    nonblock(pipes1[1]);
    if (pipe(pipes2)) {
        close(pipes1[0]);
        close(pipes1[1]);
        pipes1[0] = -1;
        pipes1[1] = -1;
        goto exit;
    }
    nonblock(pipes2[0]);
    nonblock(pipes2[1]);

    // setup polling thread
    poller = new Poll();
    poller->master = info[0]->IntegerValue();
    poller->read = pipes2[0];
    poller->write = pipes1[1];
    poller->async.data = poller;

    uv_async_init(uv_default_loop(), &poller->async, after_poll_runner);
    uv_thread_create(&poller->tid, poll_runner, static_cast<void*>(poller));

    exit:
    Local<Object> obj = Nan::New<Object>();
    SET(obj, "read", Nan::New<Number>(pipes1[0]));
    SET(obj, "write", Nan::New<Number>(pipes2[1]));
    info.GetReturnValue().Set(obj);
}


NAN_MODULE_INIT(init) {
    Nan::HandleScope scope;
    SET(target, "get_io_channels", Nan::New<FunctionTemplate>(get_io_channels)->GetFunction());
    SET(target, "openpt", Nan::New<FunctionTemplate>(c_posix_openpt)->GetFunction());
    SET(target, "grantpt", Nan::New<FunctionTemplate>(c_grantpt)->GetFunction());
    SET(target, "unlockpt", Nan::New<FunctionTemplate>(c_unlockpt)->GetFunction());
    SET(target, "ptsname", Nan::New<FunctionTemplate>(c_ptsname)->GetFunction());
    SET(target, "login_tty", Nan::New<FunctionTemplate>(c_login_tty)->GetFunction());
    SET(target, "fork", Nan::New<FunctionTemplate>(c_fork)->GetFunction());
    SET(target, "waitpid", Nan::New<FunctionTemplate>(c_waitpid)->GetFunction());
    SET(target, "get_size", Nan::New<FunctionTemplate>(c_get_size)->GetFunction());
    SET(target, "set_size", Nan::New<FunctionTemplate>(c_set_size)->GetFunction());

    // waitpid symbols
    SET(target, "WNOHANG", Nan::New<Number>(WNOHANG));
    SET(target, "WUNTRACED", Nan::New<Number>(WUNTRACED));
    SET(target, "WCONTINUED", Nan::New<Number>(WCONTINUED));
    SET(target, "WEXITED", Nan::New<Number>(WEXITED));
    SET(target, "WSTOPPED", Nan::New<Number>(WSTOPPED));
    SET(target, "WNOWAIT", Nan::New<Number>(WNOWAIT));
#ifdef WTRAPPED  // BSD only?
    SET(target, "WTRAPPED", Nan::New<Number>(WTRAPPED));
#endif

    // TODO: exec* functions
    SET(target, "exec", Nan::New<FunctionTemplate>(c_exec)->GetFunction());
}

NODE_MODULE(psutil, init)