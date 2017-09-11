#include "nan.h"
#include <termios.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <stdlib.h>
#include <fcntl.h>
#include <poll.h>
#include <chrono>
#include <thread>

// some global settings
#define POLL_FIFOLENGTH 4       // poll fifo buffer length
#define POLL_BUFSIZE    16384   // poll fifo entry size
#define POLL_TIMEOUT    100     // poll timeout in msec


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
    if (fd < 0) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("posix_openpt failed - ") + error).c_str());
    }
    cloexec(fd);
    nonblock(fd);
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
        return Nan::ThrowError((std::string("set_size failed - ") + error).c_str());
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

typedef struct {
    int length;
    int written;
    char *data;
} FifoEntry;

/**
 * Special fifo class for read/write syscalls
 *
 * The class implements a ring buffer with special commit methods
 * to indicate successful read/write operations.
 * The data part of the entries is fixed and allocated upon initialization
 * to minimize malloc, free and memcpy invocations.
 */
class Fifo {
public:
    Fifo(int length, int datasize) :
      m_last(0),
      m_first(0),
      m_size(0),
      m_length(length) {
        m_entries = new FifoEntry[length]();
        m_data = new char[length * datasize]();
        for (int i=0; i<length; ++i)
            m_entries[i].data = &m_data[i * datasize + length];
    }
    ~Fifo() {
        delete[] m_data;
        delete[] m_entries;
    }
    FifoEntry* getPushEntry() {
        return (m_size == m_length) ? nullptr : &m_entries[m_last];
    }
    FifoEntry* getPopEntry() {
        return (m_size) ? &m_entries[m_first] : nullptr;
    }
    int size() {
        return m_size;
    }
    bool empty() {
        return (bool) !m_size;
    }
    bool full() {
        return (bool) (m_size == m_length);
    }
    void commitPush() {
        m_last++;
        m_last %= m_length;
        m_size++;
    }
    void commitPop() {
        m_first++;
        m_first %= m_length;
        m_size--;
    }
private:
    int m_last;
    int m_first;
    int m_size;
    int m_length;
    char *m_data;
    FifoEntry *m_entries;
};

struct Poll {
    int master;
    int read;
    int write;
    Fifo *lfifo;
    Fifo *rfifo;
    uv_async_t async;
    uv_thread_t tid;
    ~Poll() {
        delete lfifo;
        delete rfifo;
    }
};

#include <ctime>
inline void poll_thread(void *data) {
    Poll *poller = static_cast<Poll *>(data);

    // file descriptors and fifos
    int master = poller->master;    // pty master
    int reader = poller->read;      // read pipe
    int writer = poller->write;     // write pipe
    Fifo *lfifo = poller->lfifo;    // master --> writer
    Fifo *rfifo = poller->rfifo;    // master <-- reader

    FifoEntry *entry;
    int r_bytes, w_bytes;
    bool read_master_block = false;
    bool read_reader_block = false;
    bool write_master_block = false;
    bool write_writer_block = false;
    bool read_master_exit = false;
    bool read_reader_exit = false;
    bool write_master_exit = false;
    bool write_writer_exit = false;

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
    //int counter = 0;
    //std::clock_t start;
    //start = std::clock();


    // poll loop
    for (;;) {
        //counter++;
        // exit: no more data can be written
        // NOTE: read_master_exit also covers write_master_exit
        if (write_writer_exit && read_master_exit)
            break;

        // exit: all slave hung up, master and fifo is drained
        if (read_master_exit && lfifo->empty())
            break;

        // no js consumer anymore and rfifo empty, should we close master here?
        if (read_reader_exit && rfifo->empty() && write_writer_exit)
            break;

        // reset struct pollfd
        fds[0].revents = 0;
        fds[1].revents = 0;
        fds[2].revents = 0;

        // adjust fds in poll struct
        if (read_master_exit)   // master has finally died (read dies after write)
            fds[0].fd = -1;
        else
            // need to remove master from fds under linux if already hung up
            // and pending data cant be read (fifo full) to avoid busy polling with POLLHUP
            fds[0].fd = (lfifo->full() && write_master_exit) ? -1 : master;
        if (write_writer_exit)  // writer has died
            fds[1].fd = -1;
        if (read_reader_exit)   // reader has died
            fds[2].fd = -1;

        // poll query
        // POLLOUT only if data needs to be written
        // POLLIN only if data can be stored
        fds[0].events = (rfifo->empty())
            ? (lfifo->full() ? 0 : POLLIN)
            : POLLOUT | (lfifo->full() ? 0 : POLLIN);
        fds[1].events = (lfifo->empty()) ? 0 : POLLOUT;
        fds[2].events = (rfifo->full()) ? 0 : POLLIN;

        // finally poll
        TEMP_FAILURE_RETRY(result = poll(fds, 3, POLL_TIMEOUT));
        if (result == -1)
            break;  // something unexpected happened, exit poll thread
        if (!result)
            continue;

        // POLLHUP conditions
#if defined(__linux__)
        // special case linux
        // ignore POLLHUP until no more data can be read on master and reader
        if(fds[0].revents & POLLHUP) {
            write_master_exit = true;
            if ((fds[0].events & POLLIN) && !(fds[0].revents & POLLIN))
                read_master_exit = true;
        }
        if (fds[1].revents & POLLHUP)
            write_writer_exit = true;
        if(fds[2].revents & POLLHUP) {
            if ((fds[2].events & POLLIN) && !(fds[2].revents & POLLIN))
                read_reader_exit = true;
        }
#else
        if(fds[0].revents & POLLHUP)
            write_master_exit = true;
        if(fds[1].revents & POLLHUP)
            write_writer_exit = true;
        if(fds[2].revents & POLLHUP)
            read_reader_exit = true;
#endif

        // exit on fd error: POLLERR, POLLNVAL
        if(fds[0].revents & POLLERR || fds[0].revents & POLLNVAL)
            break;
        if(fds[1].revents & POLLERR || fds[1].revents & POLLNVAL)
            break;
        if(fds[2].revents & POLLERR || fds[2].revents & POLLNVAL)
            break;

        // unlock working channels
        if (fds[0].revents & POLLIN)
            read_master_block = false;
        if (fds[0].revents & POLLOUT)
            write_master_block = false;
        if (fds[1].revents & POLLOUT)
            write_writer_block = false;
        if (fds[2].revents & POLLIN)
            read_reader_block = false;

        // set max inner loop runs before repolling
        int repoll = POLL_FIFOLENGTH * 2;

        // inner busy read/write loop
        for (;;) {

            // read master
            if (!read_master_exit && !read_master_block) {
                entry = lfifo->getPushEntry();
                if (entry) {
                    TEMP_FAILURE_RETRY(r_bytes = read(master, entry->data, POLL_BUFSIZE));
                    if (r_bytes == -1) {
                        if (errno == EAGAIN) {
                            read_master_block = true;
                        } else {
                            read_master_exit = true;
                            read_master_block = true;
                        }
                    } else {
                        if (!r_bytes) {
                            read_master_exit = true;
                            read_master_block = true;
                        } else {
                            entry->length = r_bytes;
                            entry->written = 0;
                            lfifo->commitPush();
                        }
                    }
                }
            }

            // write writer
            if (!write_writer_exit && !write_writer_block) {
                entry = lfifo->getPopEntry();
                if (entry) {
                    TEMP_FAILURE_RETRY(w_bytes = write(writer, entry->data + entry->written, entry->length));
                    if (w_bytes == -1) {
                        if (errno == EAGAIN) {
                            write_writer_block = true;
                        } else {
                            write_writer_exit = true;
                            write_writer_block = true;
                        }
                    } else if (w_bytes == entry->length) {
                        lfifo->commitPop();
                    } else {
                        entry->written += w_bytes;
                        entry->length -= w_bytes;
                        write_writer_block = true;
                    }
                }
            }

            // read reader
            if (!read_reader_exit && !read_reader_block) {
                entry = rfifo->getPushEntry();
                if (entry) {
                    TEMP_FAILURE_RETRY(r_bytes = read(reader, entry->data, POLL_BUFSIZE));
                    if (r_bytes == -1) {
                        if (errno == EAGAIN) {
                            read_reader_block = true;
                        } else {
                            read_reader_exit = true;
                            read_reader_block = true;
                        }
                    } else {
                        if (!r_bytes) {
                            read_reader_exit = true;
                            read_reader_block = true;
                        } else {
                            entry->length = r_bytes;
                            entry->written = 0;
                            rfifo->commitPush();
                        }
                    }
                }
            }

            // write master
            if (!write_master_exit && !write_master_block) {
                entry = rfifo->getPopEntry();
                if (entry) {
                    TEMP_FAILURE_RETRY(w_bytes = write(master, entry->data + entry->written, entry->length));
                    if (w_bytes == -1) {
                        if (errno == EAGAIN) {
                            write_master_block = true;
                        } else {
                            write_master_exit = true;
                            write_master_block = true;
                        }
                    } else if (w_bytes == entry->length) {
                        rfifo->commitPop();
                    } else {
                        entry->written += w_bytes;
                        entry->length -= w_bytes;
                        write_master_block = true;
                    }
                }
            }

            // exit busy loop to reevaluate blocking channels in poll
            if (!repoll--)
                break;

            // master can be read and written to lfifo
            if (!read_master_block && !lfifo->full())
                continue;
            // lfifo can write to writer
            if (!lfifo->empty() && !write_writer_block)
                continue;
            // reader can be read and written to rfifo
            if (!read_reader_block && !rfifo->full())
                continue;
            // rfifo can write to master
            if (!rfifo->empty() && !write_master_block)
                continue;
            break;
        }
        //printf("mr %d mw %d rr %d ww %d\n", read_master_exit, write_master_exit, read_reader_exit, write_writer_exit);
        //printf("mr %d mw %d rr %d ww %d\n", read_master_block, write_master_block, read_reader_block, write_writer_block);
        //printf("fifos size: %d %d\n", lfifo->size(), rfifo->size());
        //printf("fds %d %d %d\n", fds[0].fd, fds[1].fd, fds[2].fd);
        //printf("events:  %d %d\n", fds[0].events % POLLIN, fds[0].events % POLLOUT);
        //printf("revents: %d %d %d\n", fds[0].revents % POLLIN, fds[0].revents % POLLOUT, fds[0].revents % POLLHUP);
    }
    //printf("runs: %d %f ms\n", counter, (std::clock() - start) / (double)(CLOCKS_PER_SEC / 1000));
    //printf("fifos size: %d %d\n", lfifo->size(), rfifo->size());
    uv_async_send(&poller->async);
}

inline void close_poll_thread(uv_handle_t *handle) {
    Poll *poller = static_cast<Poll *>(handle->data);
    TEMP_FAILURE_RETRY(close(poller->write));
    TEMP_FAILURE_RETRY(close(poller->read));
    uv_thread_join(&poller->tid);
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
    poller->lfifo = new Fifo(POLL_FIFOLENGTH, POLL_BUFSIZE);   // master --> writer
    poller->rfifo = new Fifo(POLL_FIFOLENGTH, POLL_BUFSIZE);   // master <-- reader
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
    int setup;
    // check first if modules were autoloaded
    if ((setup = ioctl(slave, I_FIND, "ldterm")) < 0) {
        std::string error(strerror(errno));
        return Nan::ThrowError((std::string("load_driver failed - ") + error).c_str());
    }
    if (!setup) {
        if (ioctl(slave, I_PUSH, "ptem") < 0) {
            std::string error(strerror(errno));
            return Nan::ThrowError((std::string("load_driver ptem failed - ") + error).c_str());
        }
        if (ioctl(slave, I_PUSH, "ldterm") < 0) {
            std::string error(strerror(errno));
            return Nan::ThrowError((std::string("load_driver ldterm failed - ") + error).c_str());
        }
        if (ioctl(slave, I_PUSH, "ttcompat") < 0) {
            std::string error(strerror(errno));
            return Nan::ThrowError((std::string("load_driver ttcompat failed - ") + error).c_str());
        }
    }
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
