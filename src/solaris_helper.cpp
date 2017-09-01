#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>

int main(int argc, char *argv[]) {
    if (argc != 2)
        return 1;
    int hold_slave = open(argv[1], O_RDONLY);
    for (;;)
        sleep(10);
    close(hold_slave);
    return 0;
}