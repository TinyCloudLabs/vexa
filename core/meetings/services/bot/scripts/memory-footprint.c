/* macOS probe helper: kernel accounting without suspending the audio process.
 * Build: cc -O2 memory-footprint.c -o /tmp/vexa-memory-footprint
 * Usage: /tmp/vexa-memory-footprint <browser-pid> [<child-pid> ...]
 * Physical footprint includes compressed memory; RSS alone does not.
 */
#include <inttypes.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    char *end;
    long pid = strtol(argv[i], &end, 10);
    if (*end || pid <= 0 || pid > INT32_MAX) return 2;
    struct rusage_info_v4 usage = {0};
    if (proc_pid_rusage((int)pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage)) continue;
    printf("{\"pid\":%ld,\"resident_bytes\":%" PRIu64
           ",\"physical_footprint\":%" PRIu64
           ",\"peak_physical_footprint\":%" PRIu64 "}\n",
           pid, usage.ri_resident_size, usage.ri_phys_footprint,
           usage.ri_lifetime_max_phys_footprint);
  }
  return 0;
}
