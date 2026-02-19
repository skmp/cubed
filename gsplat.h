#ifndef GSPLAT_H
#define GSPLAT_H

#include <stdint.h>

/*
 * Gaussian Splat Renderer - MiSTer DE10-Nano
 * Target: ARM Cortex-A9 dual-core @ 800MHz, NEON FPU
 * Display: /dev/fb0 (typically 720x480 or 640x480)
 * Shell: /bin/sh (BusyBox ash) or /usr/bin/bash
 *
 * Data flow:
 *   GA144 (SerDes) -> splat_store -> project -> sort -> rasterize -> /dev/fb0
 */

#define DEFAULT_W  640
#define DEFAULT_H  480
#define MAX_SPLATS 50000

/* Tile-based rasterizer settings.
 * Tiles let us keep a working buffer in L1 cache (32KB on A9)
 * instead of thrashing DDR3 on every pixel blend. */
#define TILE_W    32
#define TILE_H    32

/* ---- Raw splat as stored / received from GA144 ---- */
typedef struct {
    float x, y, z;
    float cov[6]; /* symmetric 3x3: xx, xy, xz, yy, yz, zz */
    uint8_t r, g, b;
    uint8_t alpha;
} splat_3d_t;

/* ---- Projected 2D splat, ready for rasterization ----
 *
 * All rasterizer-facing fields are fixed-point integer for FPGA
 * compatibility (18-bit DSP multiply blocks).
 *
 * Fixed-point formats:
 *   sx_fp, sy_fp: s14.4 (18 meaningful bits in int32_t)
 *   cov_a_fp, cov_c_fp: u2.14 (16 bits, stored in uint16_t)
 *   cov_b2_fp: s2.14 (2*b, 17 bits signed, stored in int32_t)
 *   d² = cov_a * dx² + cov_b2 * dx*dy + cov_c * dy²
 */
typedef struct {
    int32_t sx_fp, sy_fp;     /* screen position, s14.4 */
    float depth;              /* for sorting only (CPU-side, stays float) */

    /* Inverse 2D covariance, fixed-point */
    uint16_t cov_a_fp;        /* u2.14: inv_cov[0] (a) */
    uint16_t cov_c_fp;        /* u2.14: inv_cov[2] (c) */
    int32_t  cov_b2_fp;       /* s2.14: 2 * inv_cov[1] (2*b) */

    /* Color as u0.8 integers */
    uint8_t r, g, b;
    uint8_t opacity;          /* alpha, u0.8 */

    /* Screen-space bounding box */
    int16_t bbox_x0, bbox_y0, bbox_x1, bbox_y1;
} splat_2d_t;

/* ---- Camera ---- */
typedef struct {
    float pos[3];
    float view[16];  /* 4x4 column-major */
    float fx, fy;
    float cx, cy;
} camera_t;

/* ---- Framebuffer ---- */
typedef struct {
    /* mmap'd /dev/fb0 - RGB565 (16bpp) or ARGB8888 (32bpp) */
    void     *pixels;
    int       width;    /* render width in pixels */
    int       height;   /* render height in pixels */
    int       tiles_x;  /* width / TILE_W */
    int       tiles_y;  /* height / TILE_H */
    int       stride;   /* bytes per line (from fix_screeninfo) */
    int       bpp;      /* bits per pixel: 16 or 32 */
    int       fd;
    uint32_t  mmap_size;

    /* Tile accumulation buffer - fixed-point u0.10 per channel
     * 32x32 * 4 channels * 2 bytes (uint16_t) = 8KB (fits in L1) */
    uint16_t tile_buf[TILE_H * TILE_W * 4] __attribute__((aligned(16)));
} framebuf_t;

/* ---- Splat store ---- */
typedef struct {
    splat_3d_t splats_3d[MAX_SPLATS];
    splat_2d_t splats_2d[MAX_SPLATS];
    uint32_t   sort_idx[MAX_SPLATS];
    int        count;
} splat_store_t;

/* ---- API ---- */

/* Framebuffer */
int  fb_init(framebuf_t *fb);
void fb_close(framebuf_t *fb);

/* Tile rasterizer */
void tile_clear(framebuf_t *fb);
void tile_flush(framebuf_t *fb, int tile_x, int tile_y);

/* Splat store */
void store_init(splat_store_t *store);
int  store_add(splat_store_t *store, const splat_3d_t *splat);

/* Pipeline */
void project_splats(splat_store_t *store, const camera_t *cam, const framebuf_t *fb);
void sort_splats(splat_store_t *store);
void rasterize_splats(const splat_store_t *store, framebuf_t *fb);

/* SerDes / GA144 input */
int  serdes_init(const char *dev_path);
int  serdes_recv_splats(int fd, splat_store_t *store);
void serdes_close(int fd);

/* Camera helpers */
void cam_init(camera_t *cam, float fov_deg, int width, int height);
void cam_lookat(camera_t *cam, float *eye, float *target, float *up);

/* PNG splat loading */
int  load_splats_png(const char *path, splat_store_t *store);

/* FPGA offload - rasterization via FPGA fabric over DDR3 shared memory */
typedef struct {
    volatile uint32_t *ctrl;    /* control block (splat_count, frame_req, frame_done) */
    splat_2d_t       *splats;   /* sorted splat array in DDR3 */
    int               mem_fd;
    void             *ctrl_map;
    void             *splat_map;
} fpga_ctx_t;

int  fpga_init(fpga_ctx_t *ctx);
void fpga_close(fpga_ctx_t *ctx);
void fpga_rasterize(fpga_ctx_t *ctx, const splat_store_t *store);

/* Test / debug */
void generate_test_splats(splat_store_t *store, int count);
void fb_dump_ppm(framebuf_t *fb, const char *path);

#endif /* GSPLAT_H */
