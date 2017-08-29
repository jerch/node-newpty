#include <unistd.h>
#include <sys/ioctl.h>
#include <errno.h>

int main(int argc, char *argv[]) {
    if (ioctl(STDIN_FILENO, TIOCSCTTY, NULL) == -1)
        return -1;
    execvp(argv[1], &argv[1]);
    return errno;
}
