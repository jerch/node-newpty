#include <unistd.h>
#include <sys/ioctl.h>
#include <errno.h>

#if defined(sun) || defined(__sun)
# if defined(__SVR4) || defined(__svr4__)
#define SOLARIS 1
# else
// SunOS - not supported
# endif
#endif

#if defined(SOLARIS)
#include <termios.h>
#endif

int main(int argc, char *argv[]) {
    if (argc < 2)
        return 1;
#if defined(TIOCSCTTY)
    if (ioctl(STDIN_FILENO, TIOCSCTTY, NULL) == -1)
        return -1;
#endif
    execvp(argv[1], &argv[1]);
    return errno;
}
