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

/* ---- Projected 2D splat, ready for rasterization ---- */
typedef struct {
    float sx, sy;
    float depth;

    /* 2D covariance inverse (symmetric 2x2): a, b, c
     * d² = a*dx² + 2*b*dx*dy + c*dy² */
    float cov2d_inv[3];

    /* Color as float [0..1] for NEON vectorization */
    float rf, gf, bf;
    float opacity; /* alpha/255 */

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

    /* Tile accumulation buffer - fits in L1 cache
     * 32x32 * 4 floats (RGBA) * 4 bytes = 16KB */
    float tile_buf[TILE_H * TILE_W * 4] __attribute__((aligned(16)));
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

/* Test / debug */
void generate_test_splats(splat_store_t *store, int count);
void fb_dump_ppm(framebuf_t *fb, const char *path);

#endif /* GSPLAT_H */
