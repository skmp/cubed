/*
 * main.c - Gaussian Splat renderer for MiSTer DE10-Nano
 *
 * Usage:
 *   ./gsplat                      # test, 10K splats, orbit camera
 *   ./gsplat -n 5000              # test, 5K splats
 *   ./gsplat -s /dev/ttyS0        # GA144 via HPS UART
 *   ./gsplat -s /dev/ttyUSB0      # GA144 via USB serial
 *   ./gsplat -i splats.png         # load splats from packed PNG
 *   ./gsplat -fpga                # offload rasterization to FPGA
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

volatile int running = 1;

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
        "  -i FILE     Load splats from PNG file\n"
        "  -packed     Interpret PNG as 18-byte packed binary splats\n"
        "  -s DEVICE   GA144 serial device (e.g. /dev/ttyS0)\n"
        "  -fpga       Offload rasterization to FPGA fabric\n"
        "  -seed N     Animation seed (default: random)\n"
        "  -v          Verbose output\n"
        "  -frames N   Render N frames then exit\n"
        "  -ppm        Dump PPM files (for headless testing)\n"
        "  -bench      Benchmark: 100 frames, print stats, exit\n"
        "  -h          This help\n",
        prog);
}

/* Harmonic animation parameters derived from seed.
 * Each oscillator has a frequency and phase offset, producing
 * complex non-repeating motion from incommensurate frequencies. */
typedef struct {
    float freq[8];   /* 8 oscillator frequencies */
    float phase[8];  /* 8 oscillator phase offsets */
} anim_params_t;

static void anim_init(anim_params_t *ap, uint32_t seed)
{
    /* Use seed to generate pseudo-random but deterministic frequencies.
     * Golden-ratio-based frequencies ensure non-repeating patterns. */
    uint32_t s = seed;
    for (int i = 0; i < 8; i++) {
        /* xorshift32 */
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        ap->freq[i] = 0.003f + (s & 0xFFFF) / 65536.0f * 0.012f;
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        ap->phase[i] = (s & 0xFFFF) / 65536.0f * 2.0f * (float)M_PI;
    }
}

int main(int argc, char **argv)
{
    int splat_count = 10000;
    const char *serial_dev = NULL;
    const char *png_path = NULL;
    int packed_png = 0;
    int max_frames = 0;
    int dump_ppm = 0;
    int bench = 0;
    int use_fpga = 0;
    int verbose = 0;
    uint32_t anim_seed = 0;
    int seed_set = 0;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-n") && i + 1 < argc)
            splat_count = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-i") && i + 1 < argc)
            png_path = argv[++i];
        else if (!strcmp(argv[i], "-s") && i + 1 < argc)
            serial_dev = argv[++i];
        else if (!strcmp(argv[i], "-packed"))
            packed_png = 1;
        else if (!strcmp(argv[i], "-fpga"))
            use_fpga = 1;
        else if (!strcmp(argv[i], "-seed") && i + 1 < argc) {
            anim_seed = (uint32_t)strtoul(argv[++i], NULL, 0);
            seed_set = 1;
        }
        else if (!strcmp(argv[i], "-v"))
            verbose = 1;
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

    if (!seed_set) {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        anim_seed = (uint32_t)(ts.tv_sec ^ ts.tv_nsec);
    }
    fprintf(stderr, "Animation seed: %u\n", anim_seed);

    signal(SIGINT, sigint_handler);

    /* ---- Init ---- */
    framebuf_t fb;
    if (fb_init(&fb) < 0) return 1;

    /* When using FPGA, override resolution to match FPGA's 640x480.
     * The FPGA's MISTER_FB outputs tell the framework to use 640x480,
     * but /dev/fb0 may report the scaler's output resolution (e.g. 1920x1080).
     * The HPS projection must match the FPGA rasterizer's resolution. */
    if (use_fpga) {
        fb.width = 640;
        fb.height = 480;
        fb.tiles_x = fb.width / TILE_W;
        fb.tiles_y = fb.height / TILE_H;
    }

    splat_store_t *store = (splat_store_t *)malloc(sizeof(splat_store_t));
    if (!store) {
        fprintf(stderr, "OOM: splat_store is %zuMB\n",
                sizeof(splat_store_t) / (1024 * 1024));
        return 1;
    }
    store_init(store);

    camera_t cam;
    cam_init(&cam, 60.0f, fb.width, fb.height);

    /* ---- FPGA init ---- */
    fpga_ctx_t fpga;
    if (use_fpga) {
        if (fpga_init(&fpga) < 0) {
            fprintf(stderr, "FPGA init failed, falling back to CPU\n");
            use_fpga = 0;
        } else {
            fpga.verbose = verbose;
        }
    }

    /* ---- Load data ---- */
    int serdes_fd = -1;

    if (png_path) {
        int rc = packed_png ? load_splats_png_packed(png_path, store)
                            : load_splats_png(png_path, store);
        if (rc < 0) {
            fprintf(stderr, "Failed to load %s, using test splats\n", png_path);
            generate_test_splats(store, splat_count);
        }
    } else if (serial_dev) {
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

    fprintf(stderr, "%d splats, %dx%d, tiles %dx%d (%dx%d px)%s\n",
            store->count, fb.width, fb.height,
            fb.tiles_x, fb.tiles_y, TILE_W, TILE_H,
            use_fpga ? " [FPGA]" : "");

    /* ---- Animation init ---- */
    anim_params_t anim;
    anim_init(&anim, anim_seed);

    /* ---- Render loop ---- */
    int frame = 0;
    double t_proj_sum = 0, t_sort_sum = 0, t_rast_sum = 0, t_total_sum = 0;
    int stats_interval = bench ? max_frames : 30;

    while (running) {
        double t0 = now_ms();

        /* Rotozoomer camera: harmonic oscillators for distance and rotation.
         * Distance zooms from close (0.1x) up to full view, modulated by
         * layered sinusoids. Rotation uses incommensurate frequencies for
         * complex non-repeating orbits. */
        float t = (float)frame;

        /* Distance: base zoom-in ramp + harmonic oscillations */
        float zoom_ramp = 1.0f - 0.9f * expf(-t * 0.005f);  /* 0.1 -> 1.0 */
        float dist_mod = 0.3f * sinf(t * anim.freq[0] + anim.phase[0])
                       + 0.15f * sinf(t * anim.freq[1] + anim.phase[1])
                       + 0.08f * sinf(t * anim.freq[2] + anim.phase[2]);
        float dist = (10.0f + dist_mod * 10.0f) * zoom_ramp;
        if (dist < 2.0f) dist = 2.0f;

        /* Orbit angle: primary rotation + harmonic wobbles */
        float angle = t * anim.freq[3] + anim.phase[3]
                    + 0.5f * sinf(t * anim.freq[4] + anim.phase[4])
                    + 0.3f * sinf(t * anim.freq[5] + anim.phase[5]);

        /* Elevation: gentle up/down drift */
        float elev = 0.4f * sinf(t * anim.freq[6] + anim.phase[6])
                   + 0.2f * sinf(t * anim.freq[7] + anim.phase[7]);

        float eye[3] = {
            dist * cosf(angle) * cosf(elev),
            dist * sinf(elev),
            dist * sinf(angle) * cosf(elev)
        };
        float target[3] = { 0, 0, 0 };

        /* Up vector: rotate around view axis for rotozoomer effect */
        float roll = 0.3f * sinf(t * anim.freq[2] * 0.7f + anim.phase[5])
                   + 0.15f * sinf(t * anim.freq[0] * 1.3f + anim.phase[7]);
        float up[3] = { sinf(roll), cosf(roll), 0.0f };
        cam_lookat(&cam, eye, target, up);

        double t1 = now_ms();
        project_splats(store, &cam, &fb);
        double t2 = now_ms();
        sort_splats(store);
        double t3 = now_ms();

        if (use_fpga) {
            fpga_rasterize(&fpga, store, &fb);
        } else {
            rasterize_splats(store, &fb);
        }
        double t4 = now_ms();

        t_proj_sum += (t2 - t1);
        t_sort_sum += (t3 - t2);
        t_rast_sum += (t4 - t3);
        t_total_sum += (t4 - t0);

        /* Dump PPM if requested or headless (CPU mode only) */
        if (!use_fpga && (dump_ppm || fb.fd < 0)) {
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

        if (!use_fpga && fb.fd < 0 && max_frames == 0) max_frames = 5;
        if (max_frames > 0 && frame >= max_frames) break;
    }

    fprintf(stderr, "Done. %d frames rendered.\n", frame);

    if (use_fpga) fpga_close(&fpga);
    if (serdes_fd >= 0) serdes_close(serdes_fd);
    fb_close(&fb);
    free(store);
    return 0;
}
