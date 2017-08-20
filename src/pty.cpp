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
#include <sys/select.h>
#include <chrono>
#include <thread>
#include <atomic>
#include <unordered_map>

#include <iostream>

// macro for object attributes
#define SET(obj, name, symbol)                                                \
obj->Set(Nan::New<String>(name).ToLocalChecked(), symbol)

using namespace node;
using namespace v8;

static int nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int block(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) return -1;
  return fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
}

struct PipeFd {
    int read;
    int write;
};

#include <poll.h>
// wait free poller
class Poller {
public:
    Poller(size_t size) :
        m_pollfds(std::vector<std::atomic_int>(size)),
        m_threads(std::vector<std::thread *>(size)),
        m_size(size)
    {
        for (size_t i=0; i<m_size; ++i) {
            m_pollfds[i].store(-1);
            m_threads[i] = nullptr;
        }
    }
    ~Poller() {}
    PipeFd add(int master_fd)
    {
        int read_fds[2];
        int write_fds[2];
        int empty;
        if (pipe(read_fds))
            return (PipeFd) {-1, -1};
        nonblock(read_fds[0]);
        nonblock(read_fds[1]);
        if (pipe(write_fds)) {
            close(read_fds[0]);
            close(read_fds[1]);
            return (PipeFd) {-1, -1};
        }
        nonblock(write_fds[0]);
        nonblock(write_fds[1]);
        for (size_t i=0; i<m_size; ++i) {
            empty = -1;
            if (m_pollfds[i].compare_exchange_weak(empty, -2)) {
                m_pipes[master_fd][0] = (PipeFd) {write_fds[0], read_fds[1]};
                m_pipes[master_fd][1] = (PipeFd) {read_fds[0], write_fds[1]};
                std::cout << write_fds[0] << read_fds[1] << read_fds[0] << write_fds[1] << std::endl;
                m_pollfds[i].store(master_fd);
                start(i, master_fd);
                return (PipeFd) {read_fds[0], write_fds[1]};
            }
        }
        close(read_fds[0]);
        close(read_fds[1]);
        close(write_fds[0]);
        close(write_fds[1]);
        return (PipeFd) {-1, -1};
    }
    bool remove(int master_fd)
    {
        int target;
        for (size_t i=0; i<m_size; ++i) {
            target = master_fd;
            if (m_pollfds[i].compare_exchange_weak(target, -2)) {
                close(m_pipes[i][0].read);
                close(m_pipes[i][0].write);
                m_pollfds[i].store(-1);
                return true;
            }
        }
        return false;
    }
    void _poll(size_t idx, int master)
    {
        PipeFd pipe;
        int target = master;
        int count = 0;

        // load pipe fds
        if (m_pollfds[idx].compare_exchange_weak(target, -2)) {
            pipe = m_pipes[master][0];
            m_pollfds[idx].store(master);
        } else {
            return;  // idx got changed from outside
        }

        char buf[4096];

        for (;;) {
            struct pollfd ufd[] = {
                {master, POLLIN, 0},
                {pipe.read, POLLIN, 0}
            };
            int res = poll(ufd, 2, 1000);
            if (res == -1) {
                printf("\nPOLL FAILED!\n");
                return;
            }
            /*
            switch(ufd[0].revents & (POLLIN|POLLHUP)) {
                case POLLIN: printf("POLLIN 0\n"); break;
                case POLLHUP: printf("POLLHUP 0\n"); break;
                case POLLIN|POLLHUP: printf("\n\n\n\nPOLLIN|POLLHUP 0\n"); break;
                case POLLERR: printf("POLLERR 0\n"); break;
                default: printf("something: %#x 0\n", (unsigned)ufd[0].revents); break;
            }
            */

            if (ufd[0].revents & POLLIN) {
                int r = read(master, buf, 4096);

                /*
                struct pollfd wfd = {pipe.write, POLLOUT};
                int wres = poll(&wfd, 1, -1);
                if (res == -1) {
                    printf("\nPOLL FAILED!\n");
                    return;
                }
                printf("wfd: %#x\n", wfd.revents);
                */

                int w = write(pipe.write, buf, r);
                while (w == -1) {
                    perror("\n\nW:");
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                    w = write(pipe.write, buf, r);
                }

                count += w;
                printf("%d %d %d\n", r, w, count);
                assert(r == w);
            }
            if (ufd[0].revents & POLLHUP) {
                if (ufd[0].revents & POLLIN) {
                    continue;
                } else {
                    close(pipe.write);
                    close(pipe.read);
                    break;
                }
            }
            //if (ufd[0].revents == 0x20)
            //    break;
            /*
            switch(ufd[1].revents & (POLLIN|POLLHUP)) {
                case POLLIN: printf("POLLIN 1\n"); break;
                case POLLHUP: printf("POLLHUP 1\n"); break;
                case POLLIN|POLLHUP: printf("\n\n\n\nPOLLIN|POLLHUP 1\n"); break;
                case POLLERR: printf("POLLERR 1\n"); break;
                default: printf("something: %#x 1\n", (unsigned)ufd[1].revents); break;
            }
            */
            if (ufd[1].revents == 0x20)
                break;
        }
    }
    void start(size_t idx, int fd)
    {
        if (m_threads[idx]) {
            //m_threads[idx]->join();
            delete m_threads[idx];
        }
        m_threads[idx] = new std::thread(&Poller::_poll, this,  idx, fd);
        //m_threads[idx]->detach();
    }
    void stopAll()
    {
        // TODO
    }
//private:
    std::vector<std::atomic_int> m_pollfds;
    std::vector<std::thread *> m_threads;
    size_t m_size;
    std::unordered_map<int, PipeFd[2]> m_pipes;
};

static Poller poller(10);

struct PollerThread {
    Poller *poller;
    uv_async_t async;
    uv_thread_t tid;
};

static void close_join_runner(uv_handle_t *handle) {
    uv_async_t *async = (uv_async_t *) handle;
    PollerThread *pt = static_cast<PollerThread*>(async->data);
    delete pt;
    std::cout << "JOINER end.close" << std::endl;
}

static void after_join_runner(uv_async_t *async) {
    //Nan::HandleScope scope;
    PollerThread *pt = static_cast<PollerThread*>(async->data);
    std::cout << "JOINER end.after" << std::endl;

    //Local<Function> cb = Nan::New<v8::Function>(drain->cb);
    //drain->cb.Reset();
    //Nan::Callback(cb).Call(Nan::GetCurrentContext()->Global(), 0, NULL);
    uv_close((uv_handle_t *)async, close_join_runner);
}

static void joinAll(void *data) {
    PollerThread *pt = static_cast<PollerThread *>(data);
    for (int i=0; i<pt->poller->m_size; ++i) {
        std::cout << "TRY JOIN: " << i << std::endl;
        if (pt->poller->m_threads[i]) {
            pt->poller->m_threads[i]->join();
            delete pt->poller->m_threads[i];
            pt->poller->m_threads[i] = nullptr;
            std::cout << "JOINED: " << i << std::endl;
        }
    }
    std::cout << "JOINER end." << std::endl;
    uv_async_send(&pt->async);
}

NAN_METHOD(join_all) {
    PollerThread *pt = new PollerThread();
    pt->poller = &poller;
    pt->async.data = pt;
    uv_async_init(uv_default_loop(), &pt->async, after_join_runner);
    uv_thread_create(&pt->tid, joinAll, static_cast<void*>(pt));
    info.GetReturnValue().SetUndefined();
}

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
    //std::this_thread::sleep_for(std::chrono::milliseconds(3000));
    execle("/bin/ls", "/bin/ls", "-lR", "--color=tty", "/usr/lib", NULL, environ);
    //execle("/bin/bash", "/bin/bash", "-l", NULL, environ);
    printf("should not appear\n");
    info.GetReturnValue().SetUndefined();
}

struct pty_drain {
    Nan::Persistent<v8::Function> cb;
    int fd;
    long timeout;
    uv_async_t async;
    uv_thread_t tid;
};

/*
#include <unistd.h>
#include <stdio.h>
#include <poll.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>

int main(void)
{
    int p[2];
    struct pollfd ufd;

    if (pipe(p) < 0) {
        perror("pipe");
        return EXIT_FAILURE;
    }
    if (close(p[1]) < 0) { // close the write fd
        perror("close");
        return EXIT_FAILURE;
    }

    memset(&ufd, 0, sizeof ufd);
    ufd.fd = p[0]; // poll the read fd after the write fd is closed
    ufd.events = POLLIN;
    if (poll(&ufd, 1, 1000) < 0) {
        perror("poll");
        return EXIT_FAILURE;
    }

    switch(ufd.revents & (POLLIN|POLLHUP)) {
        case POLLIN: printf("POLLIN\n"); break;
        case POLLHUP: printf("POLLHUP\n"); break;
        case POLLIN|POLLHUP: printf("POLLIN|POLLHUP\n"); break;
        case POLLERR: printf("POLLERR\n"); break;
        default: printf("%#x\n", (unsigned)ufd.revents); break;
    }

    return EXIT_SUCCESS;
}
*/
#include <poll.h>

static void drain_runner(void *data) {
    pty_drain *drain = static_cast<pty_drain *>(data);

    int slave_holder = 0;

    char buf[1024] = {0};

    for (;;) {
        struct pollfd ufd;
        memset(&ufd, 0, sizeof ufd);
        ufd.fd = drain->fd;
        ufd.events = POLLIN;
        poll(&ufd, 1, 1000);
        switch(ufd.revents & (POLLIN|POLLHUP)) {
            case POLLIN: printf("POLLIN\n"); break;
            case POLLHUP: printf("POLLHUP\n"); break;
            case POLLIN|POLLHUP: printf("\n\n\n\nPOLLIN|POLLHUP\n"); break;
            case POLLERR: printf("POLLERR\n"); break;
            default: printf("bla %#x\n", (unsigned)ufd.revents); break;
        }
        //break;
        if (ufd.revents == 0x20)
            break;
        if (ufd.revents & (POLLIN|POLLHUP)) {
            //slave_holder = open(ptsname(drain->fd), O_RDWR | O_NOCTTY);
            int c=0;
            while (read(drain->fd, &buf, 100)>0) {
                printf("\n\n%d drainer: %s\n\n", c, buf);
                memset(buf, 0, 1024);
                c++;
            }
        }
        if (slave_holder && ufd.revents==0) {
            printf("geh heim mann...\n");
            //close(slave_holder);
            //close(drain->fd);
            break;
        }
    }

/*
    // drain all reading data before sending exit
    // polls master every 10 ms
    int fd = drain->fd;
    fd_set rfds;
    struct timeval tv;
    for (;;) {
        FD_ZERO(&rfds);
        FD_SET(fd, &rfds);
        tv.tv_sec = 0;
        tv.tv_usec = 10;
        if (select(fd+1, &rfds, NULL, NULL, &tv) < 1)
            break;
        std::this_thread::sleep_for(std::chrono::microseconds(90));
    }
*/
    uv_async_send(&drain->async);
}

static void close_drain_runner(uv_handle_t *handle) {
    uv_async_t *async = (uv_async_t *) handle;
    pty_drain *drain = static_cast<pty_drain*>(async->data);
    delete drain;
}

static void after_drain_runner(uv_async_t *async) {
    Nan::HandleScope scope;
    pty_drain *drain = static_cast<pty_drain*>(async->data);

    Local<Function> cb = Nan::New<v8::Function>(drain->cb);
    drain->cb.Reset();
    Nan::Callback(cb).Call(Nan::GetCurrentContext()->Global(), 0, NULL);
    uv_close((uv_handle_t *)async, close_drain_runner);
}

NAN_METHOD(c_drain_fd) {
    if (info.Length() != 2
            || !info[0]->IsNumber()
            || !info[1]->IsFunction())
        return Nan::ThrowError("usage: pty.wait_on_drain(fd, cb)");

    pty_drain *drain = new pty_drain();
    drain->fd = info[0]->IntegerValue();
    drain->cb.Reset(v8::Local<v8::Function>::Cast(info[1]));
    drain->async.data = drain;

    uv_async_init(uv_default_loop(), &drain->async, after_drain_runner);
    uv_thread_create(&drain->tid, drain_runner, static_cast<void*>(drain));

    return info.GetReturnValue().SetUndefined();
}

struct pty_baton {
    Nan::Persistent<v8::Function> cb;
    pid_t pid;
    int options;
    uv_async_t async;
    uv_thread_t tid;
    int master;
    int slave;
};

static void thread_runner(void *data) {
    pty_baton *baton = static_cast<pty_baton*>(data);
    int wstatus;
    pid_t res = waitpid(baton->pid, &wstatus, baton->options);
    baton->pid = res;
    baton->options = wstatus;

    uv_async_send(&baton->async);
}

static void close_thread_runner(uv_handle_t *handle) {
    uv_async_t *async = (uv_async_t *) handle;
    pty_baton *baton = static_cast<pty_baton*>(async->data);
    delete baton;
}

static void after_thread_runner(uv_async_t *async) {
    Nan::HandleScope scope;
    pty_baton *baton = static_cast<pty_baton*>(async->data);

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
    uv_close((uv_handle_t *)async, close_thread_runner);
}

NAN_METHOD(c_waitpid) {
    if (info.Length() != 5
            || !info[0]->IsNumber()
            || !info[1]->IsNumber()
            || !info[2]->IsFunction()
            || !info[3]->IsNumber()
            || !info[4]->IsNumber())
        return Nan::ThrowError("usage: pty.waitpid(pid, options, cb, master, slave)");

    pid_t pid = info[0]->IntegerValue();
    int options = info[1]->IntegerValue();
    int master = info[3]->IntegerValue();
    int slave = info[4]->IntegerValue();

    pty_baton *baton = new pty_baton();
    baton->pid = pid;
    baton->options = options;
    baton->cb.Reset(v8::Local<v8::Function>::Cast(info[2]));
    baton->async.data = baton;
    baton->master = master;
    baton->slave = slave;

    uv_async_init(uv_default_loop(), &baton->async, after_thread_runner);
    uv_thread_create(&baton->tid, thread_runner, static_cast<void*>(baton));

    return info.GetReturnValue().SetUndefined();
}

NAN_METHOD(c_waitpid_normal) {
    if (info.Length() != 3
            || !info[0]->IsNumber()
            || !info[1]->IsNumber()
            || !info[2]->IsFunction())
        return Nan::ThrowError("usage: pty.waitpid(pid, options, cb)");

    pid_t pid = info[0]->IntegerValue();
    int options = info[1]->IntegerValue();

    int wstatus;
    pid_t res = waitpid(pid, &wstatus, options);

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

    info.GetReturnValue().Set(obj);
}

NAN_METHOD(get_fds) {
    if (info.Length() != 1
        || !info[0]->IsNumber())
    return Nan::ThrowError("usage: pty.get_fds(master_fd)");

    PipeFd fds = poller.add(info[0]->IntegerValue());
    Local<Object> obj = Nan::New<Object>();
    SET(obj, "read", Nan::New<Number>(fds.read));
    SET(obj, "write", Nan::New<Number>(fds.write));

    info.GetReturnValue().Set(obj);
}


NAN_MODULE_INIT(init) {

/*
    for (int i=0; i<15; ++i) {
        PipeFd fds = poller.add(i);
        std::cout << "Pipes:" << i << ":" << fds.read << std::endl;
    }
    for (int i=0; i<15; ++i) {
        bool res = poller.remove(i);
        std::cout << "Pipes:" << i << ":" << res << std::endl;
    }
    for (int i=0; i<15; ++i) {
        PipeFd fds = poller.add(i);
        std::cout << "Pipes:" << i << ":" << fds.read << std::endl;
    }
*/


    Nan::HandleScope scope;
    SET(target, "joinAll", Nan::New<FunctionTemplate>(join_all)->GetFunction());
    SET(target, "get_fds", Nan::New<FunctionTemplate>(get_fds)->GetFunction());
    SET(target, "openpt", Nan::New<FunctionTemplate>(c_posix_openpt)->GetFunction());
    SET(target, "grantpt", Nan::New<FunctionTemplate>(c_grantpt)->GetFunction());
    SET(target, "unlockpt", Nan::New<FunctionTemplate>(c_unlockpt)->GetFunction());
    SET(target, "ptsname", Nan::New<FunctionTemplate>(c_ptsname)->GetFunction());
    SET(target, "login_tty", Nan::New<FunctionTemplate>(c_login_tty)->GetFunction());
    SET(target, "fork", Nan::New<FunctionTemplate>(c_fork)->GetFunction());
    SET(target, "waitpid", Nan::New<FunctionTemplate>(c_waitpid)->GetFunction());
    SET(target, "waitpid_n", Nan::New<FunctionTemplate>(c_waitpid_normal)->GetFunction());
    SET(target, "get_size", Nan::New<FunctionTemplate>(c_get_size)->GetFunction());
    SET(target, "set_size", Nan::New<FunctionTemplate>(c_set_size)->GetFunction());
    SET(target, "drain_fd", Nan::New<FunctionTemplate>(c_drain_fd)->GetFunction());

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