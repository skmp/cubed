/*
 * main.c - Gaussian Splat renderer for MiSTer DE10-Nano
 *
 * Usage:
 *   ./gsplat                      # test, 10K splats, orbit camera
 *   ./gsplat -n 5000              # test, 5K splats
 *   ./gsplat -s /dev/ttyS0        # GA144 via HPS UART
 *   ./gsplat -s /dev/ttyUSB0      # GA144 via USB serial
 *   ./gsplat -ppm                 # dump PPM frames (headless debug)
 *   ./gsplat -bench               # benchmark mode, no display loop
 */

#include "gsplat.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <signal.h>
#include <termios.h>

static volatile int running = 1;

static void sigint_handler(int sig)
{
    (void)sig;
    running = 0;
}

static double now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static void usage(const char *prog)
{
    fprintf(stderr,
        "Usage: %s [options]\n"
        "  -n COUNT    Number of test splats (default 10000)\n"
        "  -s DEVICE   GA144 serial device (e.g. /dev/ttyS0)\n"
        "  -frames N   Render N frames then exit\n"
        "  -ppm        Dump PPM files (for headless testing)\n"
        "  -bench      Benchmark: 100 frames, print stats, exit\n"
        "  -h          This help\n",
        prog);
}

int main(int argc, char **argv)
{
    int splat_count = 10000;
    const char *serial_dev = NULL;
    int max_frames = 0;
    int dump_ppm = 0;
    int bench = 0;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-n") && i + 1 < argc)
            splat_count = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-s") && i + 1 < argc)
            serial_dev = argv[++i];
        else if (!strcmp(argv[i], "-frames") && i + 1 < argc)
            max_frames = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-ppm"))
            dump_ppm = 1;
        else if (!strcmp(argv[i], "-bench")) {
            bench = 1;
            max_frames = 100;
        }
        else if (!strcmp(argv[i], "-h")) {
            usage(argv[0]);
            return 0;
        }
        else {
            fprintf(stderr, "Unknown option: %s\n", argv[i]);
            usage(argv[0]);
            return 1;
        }
    }

    signal(SIGINT, sigint_handler);

    /* ---- Init ---- */
    framebuf_t fb;
    if (fb_init(&fb) < 0) return 1;

    splat_store_t *store = (splat_store_t *)malloc(sizeof(splat_store_t));
    if (!store) {
        fprintf(stderr, "OOM: splat_store is %zuMB\n",
                sizeof(splat_store_t) / (1024 * 1024));
        return 1;
    }
    store_init(store);

    camera_t cam;
    cam_init(&cam, 60.0f, fb.width, fb.height);

    /* ---- Load data ---- */
    int serdes_fd = -1;

    if (serial_dev) {
        serdes_fd = serdes_init(serial_dev);
        if (serdes_fd >= 0) {
            fprintf(stderr, "Waiting for GA144 data on %s...\n", serial_dev);
            if (serdes_recv_splats(serdes_fd, store) < 0) {
                fprintf(stderr, "No GA144 data, using test splats\n");
                generate_test_splats(store, splat_count);
            }
        } else {
            generate_test_splats(store, splat_count);
        }
    } else {
        generate_test_splats(store, splat_count);
    }

    fprintf(stderr, "%d splats, %dx%d, tiles %dx%d (%dx%d px)\n",
            store->count, fb.width, fb.height,
            fb.tiles_x, fb.tiles_y, TILE_W, TILE_H);

    /* ---- Render loop ---- */
    int frame = 0;
    double t_proj_sum = 0, t_sort_sum = 0, t_rast_sum = 0, t_total_sum = 0;
    int stats_interval = bench ? max_frames : 30;

    while (running) {
        double t0 = now_ms();

        /* Orbit camera */
        float angle = frame * 0.02f;
        float dist = 5.0f;
        float eye[3]    = { dist * cosf(angle), 1.0f, dist * sinf(angle) };
        float target[3] = { 0, 0, 0 };
        float up[3]     = { 0, 1, 0 };
        cam_lookat(&cam, eye, target, up);

        /* Check for updated GA144 data (non-blocking) */
        /* TODO: poll serdes_fd and double-buffer store */

        double t1 = now_ms();
        project_splats(store, &cam, &fb);
        double t2 = now_ms();
        sort_splats(store);
        double t3 = now_ms();
        rasterize_splats(store, &fb);
        double t4 = now_ms();

        t_proj_sum += (t2 - t1);
        t_sort_sum += (t3 - t2);
        t_rast_sum += (t4 - t3);
        t_total_sum += (t4 - t0);

        /* Dump PPM if requested or headless */
        if (dump_ppm || fb.fd < 0) {
            char path[64];
            snprintf(path, sizeof(path), "frame_%04d.ppm", frame);
            fb_dump_ppm(&fb, path);
        }

        frame++;

        /* Stats */
        if (frame % stats_interval == 0) {
            double n = stats_interval;
            fprintf(stderr,
                "[%d] proj=%.1f sort=%.1f rast=%.1f total=%.1f ms (%.1f fps)\n",
                frame,
                t_proj_sum / n, t_sort_sum / n,
                t_rast_sum / n, t_total_sum / n,
                n * 1000.0 / t_total_sum);
            t_proj_sum = t_sort_sum = t_rast_sum = t_total_sum = 0;
        }

        if (fb.fd < 0 && max_frames == 0) max_frames = 5;
        if (max_frames > 0 && frame >= max_frames) break;
    }

    fprintf(stderr, "Done. %d frames rendered.\n", frame);

    if (serdes_fd >= 0) serdes_close(serdes_fd);
    fb_close(&fb);
    free(store);
    return 0;
}
