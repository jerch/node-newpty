#include "nan.h"
#include <termios.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdlib.h>
#include <fcntl.h>
#include <utmp.h>
#include <poll.h>
#if defined(__APPLE__) && defined(__MACH__)
#include <util.h>
#endif

// typical OS defines: https://sourceforge.net/p/predef/wiki/OperatingSystems/

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


/**
 *  POSIX OS primitives
 *  TODO: maybe move to a separate module?
 */

NAN_METHOD(js_fork) {
    info.GetReturnValue().Set(Nan::New<Number>(fork()));
}

// exec* family
NAN_METHOD(js_execl) {
    int length = info.Length();
    char *argv[length+1];
    argv[length] = nullptr;
    for (int i=0; i<length; ++i)
        argv[i] = strdup(*Nan::Utf8String(info[i]->ToString()));
    execv(argv[0], &argv[1]);
    std::string error(strerror(errno));
    for (int i=0; i<length; ++i)
        free(argv[i]);
    info.GetReturnValue().Set(
        Nan::New<String>((std::string("execl failed - ") + error).c_str()).ToLocalChecked());
}
NAN_METHOD(js_execlp) {
    int length = info.Length();
    char *argv[length+1];
    argv[length] = nullptr;
    for (int i=0; i<length; ++i)
        argv[i] = strdup(*Nan::Utf8String(info[i]->ToString()));
    execvp(argv[0], &argv[1]);
    std::string error(strerror(errno));
    for (int i=0; i<length; ++i)
        free(argv[i]);
    info.GetReturnValue().Set(
        Nan::New<String>((std::string("execlp failed - ") + error).c_str()).ToLocalChecked());
}
NAN_METHOD(js_execle) {
    int length = info.Length();
    if (!info[length-1]->IsObject())
        return Nan::ThrowError("usage: pty.execle(path, arg1, ..., env)");
    char *argv[length];
    argv[length-1] = nullptr;
    for (int i=0; i<length-1; ++i)
        argv[i] = strdup(*Nan::Utf8String(info[i]->ToString()));
    Local<Object> js_env = info[length-1]->ToObject();
    Local<Array> env_keys = js_env->GetOwnPropertyNames();
    char buf[4096];
    char *env[env_keys->Length()];
    env[env_keys->Length()-1] = nullptr;
    for (unsigned int i=0; i<env_keys->Length(); ++i) {
        Local<Value> key = env_keys->Get(i);
        Local<Value> value = js_env->Get(key);
        String::Utf8Value utf8_key(key);
        String::Utf8Value utf8_value(value);
        int res = snprintf(buf, 4096, "%s=%s", *utf8_key, *utf8_value);
        assert(res < 4096);  // TODO: make size dynamic
        env[i] = strdup(buf);
    }
    execve(argv[0], &argv[1], env);
    std::string error(strerror(errno));
    for (int i=0; i<length; ++i)
        free(argv[i]);
    for (unsigned int i=0; i<env_keys->Length(); ++i)
        free(env[i]);
    info.GetReturnValue().Set(
        Nan::New<String>((std::string("execle failed - ") + error).c_str()).ToLocalChecked());
}
NAN_METHOD(js_execv) {
    if (info.Length() != 2
            || !info[0]->IsString()
            || !info[1]->IsArray())
        return Nan::ThrowError("usage: pty.execv(path, argv)");
    Local<Array> js_argv = Local<Array>::Cast(info[1]);
    char *argv[js_argv->Length()+2];
    argv[js_argv->Length()+1] = nullptr;
    argv[0] = strdup(*Nan::Utf8String(info[0]->ToString()));
    for (unsigned int i=0; i<js_argv->Length(); ++i)
        argv[i+1] = strdup(*Nan::Utf8String(js_argv->Get(i)));
    execv(argv[0], &argv[1]);
    std::string error(strerror(errno));
    for (unsigned int i=0; i<js_argv->Length()+1; ++i)
        free(argv[i]);
    info.GetReturnValue().Set(
        Nan::New<String>((std::string("execv failed - ") + error).c_str()).ToLocalChecked());
}
NAN_METHOD(js_execvp) {
    if (info.Length() != 2
            || !info[0]->IsString()
            || !info[1]->IsArray())
        return Nan::ThrowError("usage: pty.execvp(file, argv)");
    Local<Array> js_argv = Local<Array>::Cast(info[1]);
    char *argv[js_argv->Length()+2];
    argv[js_argv->Length()+1] = nullptr;
    argv[0] = strdup(*Nan::Utf8String(info[0]->ToString()));
    for (unsigned int i=0; i<js_argv->Length(); ++i)
        argv[i+1] = strdup(*Nan::Utf8String(js_argv->Get(i)));
    execvp(argv[0], &argv[1]);
    std::string error(strerror(errno));
    for (unsigned int i=0; i<js_argv->Length()+1; ++i)
        free(argv[i]);
    info.GetReturnValue().Set(
        Nan::New<String>((std::string("execvp failed - ") + error).c_str()).ToLocalChecked());
}
NAN_METHOD(js_execve) {
    if (info.Length() != 3
            || !info[0]->IsString()
            || !info[1]->IsArray()
            || !info[2]->IsObject())
        return Nan::ThrowError("usage: pty.execve(path, argv, env)");
    Local<Array> js_argv = Local<Array>::Cast(info[1]);
    char *argv[js_argv->Length()+2];
    argv[js_argv->Length()+1] = nullptr;
    argv[0] = strdup(*Nan::Utf8String(info[0]->ToString()));
    for (unsigned int i=0; i<js_argv->Length(); ++i)
        argv[i+1] = strdup(*Nan::Utf8String(js_argv->Get(i)));
    Local<Object> js_env = info[2]->ToObject();
    Local<Array> env_keys = js_env->GetOwnPropertyNames();
    char buf[4096];
    char *env[env_keys->Length()];
    env[env_keys->Length()-1] = nullptr;
    for (unsigned int i=0; i<env_keys->Length(); ++i) {
        Local<Value> key = env_keys->Get(i);
        Local<Value> value = js_env->Get(key);
        String::Utf8Value utf8_key(key);
        String::Utf8Value utf8_value(value);
        int res = snprintf(buf, 4096, "%s=%s", *utf8_key, *utf8_value);
        assert(res < 4096);  // TODO: make size dynamic
        env[i] = strdup(buf);
    }
    execve(argv[0], &argv[1], env);
    std::string error(strerror(errno));
    for (unsigned int i=0; i<js_argv->Length()+1; ++i)
        free(argv[i]);
    for (unsigned int i=0; i<env_keys->Length(); ++i)
            free(env[i]);
    info.GetReturnValue().Set(
        Nan::New<String>((std::string("execve failed - ") + error).c_str()).ToLocalChecked());
}
NAN_METHOD(js_execvpe) {
    if (info.Length() != 3
            || !info[0]->IsString()
            || !info[1]->IsArray()
            || !info[2]->IsObject())
        return Nan::ThrowError("usage: pty.execvpe(file, argv, env)");
    Local<Array> js_argv = Local<Array>::Cast(info[1]);
    char *argv[js_argv->Length()+2];
    argv[js_argv->Length()+1] = nullptr;
    argv[0] = strdup(*Nan::Utf8String(info[0]->ToString()));
    for (unsigned int i=0; i<js_argv->Length(); ++i)
        argv[i+1] = strdup(*Nan::Utf8String(js_argv->Get(i)));
    Local<Object> js_env = info[2]->ToObject();
    Local<Array> env_keys = js_env->GetOwnPropertyNames();
    char buf[4096];
    char *env[env_keys->Length()];
    env[env_keys->Length()-1] = nullptr;
    for (unsigned int i=0; i<env_keys->Length(); ++i) {
        Local<Value> key = env_keys->Get(i);
        Local<Value> value = js_env->Get(key);
        String::Utf8Value utf8_key(key);
        String::Utf8Value utf8_value(value);
        int res = snprintf(buf, 4096, "%s=%s", *utf8_key, *utf8_value);
        assert(res < 4096);  // TODO: make size dynamic
        env[i] = strdup(buf);
    }
#if defined(__APPLE__) && defined(__MACH__)
    execve(argv[0], &argv[1], env);  // FIXME: no execvpe on BSDs
#else
    execvpe(argv[0], &argv[1], env);
#endif
    std::string error(strerror(errno));
    for (unsigned int i=0; i<js_argv->Length()+1; ++i)
        free(argv[i]);
    for (unsigned int i=0; i<env_keys->Length(); ++i)
            free(env[i]);
    info.GetReturnValue().Set(
        Nan::New<String>((std::string("execvpe failed - ") + error).c_str()).ToLocalChecked());
}


/**
 *  Waitpid implementation
 *
 *  Runs `waitpid` in async mode and calls the callback function
 *  once a process fullfills the wait conditions. This is a full clone
 *  of the C waitpid function to be used in Javascript.
 *  See `man waitpid` for a detailed explanation of the C version.
 *  Call it from Javascript as `waitpid(pid, options, callback)`.
 *  `pid` can be:
 *      <-1         wait for any child process whose process group ID
 *                  is equal to the absolute value of pid
 *      -1          wait for any child process
 *      0           wait for any child process whose process group ID
 *                  is equal to that of the calling process
 *      >0          wait for the child whose process ID is equal to the value of pid
 *  `options` can be an OR mask of the following:
 *      0           grab all process exits
 *      WNOHANG     return immediately (non-blocking)
 *      WUNTRACED   return if a child has stopped
 *      WCONTINUED  return if a stopped child has been resumed by delivery of SIGCONT
 *      WEXITED     returns true if the child terminated normally
 *                  by calling exit or _exit, or by returning from main()
 *      WSTOPPED    process got stopped by delivery of a signal
 *      WNOWAIT     leave the child in a waitable state; a later wait call can be used
 *                  to retrieve the child status information again
 *      WTRAPPED    report the status of selected processes which are being traced (BSD only)
 *
 *  Once a process meets the wait conditions of `options`
 *  the callback gets called with the wait status as the first parameter:
 *      {
 *          pid:            pid of the process that fullfilled the wait condition
 *          WIFEXITED:      true if the process exited
 *          WEXITSTATUS:    exit code or -1
 *          WIFSIGNALED:    true if the process got signalled
 *          WTERMSIG:       signal code or -1
 *          WCOREDUMP:      true if core dumped upon a signal or -1 (not on AIX and SunOS)
 *          WIFSTOPPED:     true if the process got stopped
 *          WSTOPSIG:       stop signal code or -1 if not stopped
 *          WIFCONTINUED:   true if process got continued
 *      }
 */

struct Wait {
    Nan::Persistent<Function> cb;
    pid_t pid;
    int options;
    uv_async_t async;
    uv_thread_t tid;
};

inline void wait_thread(void *data) {
    Wait *waiter = static_cast<Wait *>(data);
    int wstatus;
    pid_t res = waitpid(waiter->pid, &wstatus, waiter->options);
    waiter->pid = res;
    waiter->options = wstatus;
    uv_async_send(&waiter->async);
}

inline void close_wait_thread(uv_handle_t *handle) {
    uv_async_t *async = (uv_async_t *) handle;
    Wait *waiter = static_cast<Wait *>(async->data);
    delete waiter;
}

inline void after_wait_thread(uv_async_t *async) {
    Nan::HandleScope scope;
    Wait *waiter = static_cast<Wait *>(async->data);

    int wstatus = waiter->options;
    pid_t pid = waiter->pid;
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
    Local<Function> cb = Nan::New<Function>(waiter->cb);
    waiter->cb.Reset();
    Nan::Callback(cb).Call(Nan::GetCurrentContext()->Global(), 1, argv);
    uv_close((uv_handle_t *)async, close_wait_thread);
}

NAN_METHOD(js_waitpid) {
    if (info.Length() != 3
            || !info[0]->IsNumber()
            || !info[1]->IsNumber()
            || !info[2]->IsFunction())
        return Nan::ThrowError("usage: pty.waitpid(pid, options, callback)");

    pid_t pid = info[0]->IntegerValue();
    int options = info[1]->IntegerValue();

    Wait *waiter = new Wait();
    waiter->pid = pid;
    waiter->options = options;
    waiter->cb.Reset(Local<Function>::Cast(info[2]));
    waiter->async.data = waiter;

    uv_async_init(uv_default_loop(), &waiter->async, after_wait_thread);
    uv_thread_create(&waiter->tid, wait_thread, static_cast<void *>(waiter));

    return info.GetReturnValue().SetUndefined();
}


/**
 * PTY and TTY primitives
 */

// replacements of pty primitives
// forkpty --> #openpty, #fork, #login_tty - done
// openpty --> posix_openpt, grantpt, unlockpt - done
// login_tty --> setsid(); ioctl(0, TIOCSCTTY, 1); dup2(slave_fd, 0);  // TODO: check if available

NAN_METHOD(js_posix_openpt) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: posix_openpt(flags)");
    int fd = posix_openpt(info[0]->IntegerValue());
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

NAN_METHOD(js_login_tty) {
    if (info.Length() != 1 || !(info[0]->IsNumber()))
        return Nan::ThrowError("usage: login_tty(fd)");
    if (login_tty(info[0]->IntegerValue())) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("login_tty failed - ") + error).c_str());
    }
    info.GetReturnValue().SetUndefined();
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
    SET(obj, "columns", Nan::New<Number>(winp.ws_col));
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
    SET(obj, "columns", Nan::New<Number>(winp.ws_col));
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
                // OSX 10.10: on broken pipe POLLIN is set
                // and read returns 0 --> EOF
                if (!r_read)
                    break;
                if (r_read == -1)
                    break;
                r_pending_write = true;
            } else if (fds[2].revents & POLLHUP)
                break;
            // master read
            if (!l_pending_write && fds[0].revents & POLLIN) {
                l_read = read(master, l_buf, POLL_BUFSIZE);
                if (l_read == -1)
                    break;
                // OSX 10.10: if slave hang up poll returns with POLLIN
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

inline int nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags == -1)
        return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
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

    uv_async_init(uv_default_loop(), &poller->async, after_poll_thread);
    uv_thread_create(&poller->tid, poll_thread, static_cast<void *>(poller));

    exit:
    Local<Object> obj = Nan::New<Object>();
    SET(obj, "read", Nan::New<Number>(pipes1[0]));
    SET(obj, "write", Nan::New<Number>(pipes2[1]));
    info.GetReturnValue().Set(obj);
}

/**
 * Exported symbols by the module
 */
NAN_MODULE_INIT(init) {
    SET(target, "fork", Nan::New<FunctionTemplate>(js_fork)->GetFunction());
    SET(target, "execl", Nan::New<FunctionTemplate>(js_execl)->GetFunction());
    SET(target, "execlp", Nan::New<FunctionTemplate>(js_execlp)->GetFunction());
    SET(target, "execle", Nan::New<FunctionTemplate>(js_execle)->GetFunction());
    SET(target, "execv", Nan::New<FunctionTemplate>(js_execv)->GetFunction());
    SET(target, "execvp", Nan::New<FunctionTemplate>(js_execvp)->GetFunction());
    SET(target, "execve", Nan::New<FunctionTemplate>(js_execve)->GetFunction());
    SET(target, "execvpe", Nan::New<FunctionTemplate>(js_execvpe)->GetFunction());
    SET(target, "waitpid", Nan::New<FunctionTemplate>(js_waitpid)->GetFunction());
    SET(target, "openpt", Nan::New<FunctionTemplate>(js_posix_openpt)->GetFunction());
    SET(target, "grantpt", Nan::New<FunctionTemplate>(js_grantpt)->GetFunction());
    SET(target, "unlockpt", Nan::New<FunctionTemplate>(js_unlockpt)->GetFunction());
    SET(target, "ptsname", Nan::New<FunctionTemplate>(js_ptsname)->GetFunction());
    SET(target, "login_tty", Nan::New<FunctionTemplate>(js_login_tty)->GetFunction());
    SET(target, "get_size", Nan::New<FunctionTemplate>(js_pty_get_size)->GetFunction());
    SET(target, "set_size", Nan::New<FunctionTemplate>(js_pty_set_size)->GetFunction());
    SET(target, "get_io_channels", Nan::New<FunctionTemplate>(get_io_channels)->GetFunction());

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
}

NODE_MODULE(pty, init)
