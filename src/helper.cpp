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
#include <stropts.h>
#endif

int main(int argc, char *argv[]) {
#if defined(TIOCSCTTY)
    if (ioctl(STDIN_FILENO, TIOCSCTTY, NULL) == -1)
        return -1;
#elif defined(I_PUSH) && defined(I_FIND)
        if (ioctl(STDIN_FILENO, I_FIND, "ptem") == 0) {
                ioctl(STDIN_FILENO, I_PUSH, "ptem");
        }
        if (ioctl(STDIN_FILENO, I_FIND, "ldterm") == 0) {
                ioctl(STDIN_FILENO, I_PUSH, "ldterm");
        }
#endif
    execvp(argv[1], &argv[1]);
    return errno;
}
