#include <unistd.h>
#include <stdio.h>

int main(int argc, char *argv[]) {
    if (isatty(STDERR_FILENO))
        return 1;
    // test write to stdout and stderr
    fprintf(stdout, "Hello stdout.");
    fprintf(stderr, "Hello stderr.");
    return 0;
}
