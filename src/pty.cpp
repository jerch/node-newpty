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

#define POLL_BUFSIZE 4096

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
    execle("/bin/ls", "/bin/ls", "-lR", "--color=tty", "/usr/lib", NULL, environ);
    //execle("/bin/bash", "/bin/bash", "-l", NULL, environ);
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
    // TODO: read/write backwards; exit on fd failure (closed from outside)

    Poll *poller = static_cast<Poll *>(data);

    int master = poller->master;
    int reader = poller->read;
    int writer = poller->write;
    char buf[POLL_BUFSIZE];
    struct pollfd readfd = {master, POLLIN | POLLHUP, 0};
    struct pollfd writefd = {writer, POLLOUT, 0};
    bool pending_write = false;
    int written = 0;
    int readed = 0;

    for (;;) {
        if (pending_write) {
            writefd.revents = 0;
            int res = poll(&writefd, 1, 10);
            if (res == -1) {
                perror("Error reading master:");
                uv_async_send(&poller->async);
                return;
            }
            int w = write(writer, buf+written, readed);
            if (w == readed) {
                pending_write = false;
                written = 0;
            } else {
                written += w;
                continue;
            }
        }

        readfd.revents = 0;
        int res = poll(&readfd, 1, 10);
        if (res == -1) {
            perror("Error reading master:");
            uv_async_send(&poller->async);
            return;
        }

        if (readfd.revents & POLLIN) {
            readed = read(master, buf, POLL_BUFSIZE);
            pending_write = true;
        } else if (readfd.revents & POLLHUP) {
            close(writer);
            close(reader);
            uv_async_send(&poller->async);
            return;
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

NAN_METHOD(get_fds) {
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
    SET(target, "get_fds", Nan::New<FunctionTemplate>(get_fds)->GetFunction());
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