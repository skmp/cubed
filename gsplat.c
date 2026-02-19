/*
 * gsplat.c - Gaussian Splat renderer for MiSTer DE10-Nano
 *
 * Optimized for Cortex-A9 @ 800MHz:
 *   - NEON SIMD for Gaussian evaluation (4 pixels/cycle)
 *   - Tile-based rasterization (working set in L1 cache)
 *   - exp() lookup table (avoids libm expf in inner loop)
 *   - Radix sort instead of qsort
 *
 * Build on MiSTer:
 *   gcc -O2 -mfpu=neon -mfloat-abi=hard -mcpu=cortex-a9 \
 *       -o gsplat gsplat.c main.c -lm
 */

#include "gsplat.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <linux/fb.h>
#include <termios.h>

/* ================================================================
 * GAUSSIAN LUT (fixed-point, u0.16 output)
 *
 * 2048 entries covering d² in [0, 8).  Each entry i represents
 * exp(-0.5 * i/256) as a u0.16 value (0..65535).
 *
 * Index = d² * 256.  From the fixed-point d² accumulator
 * (which is in *2^18 scaling), index = d2_sum >> 10.
 *
 * Cutoff at d² >= 8 (index >= 2048).  exp(-4) = 0.018,
 * negligible contribution.
 * ================================================================ */

#define GAUSS_LUT_SIZE  2048
#define GAUSS_LUT_D2_CUTOFF_FP  (8 << 18)   /* d² >= 8 in u4.18 */

static uint16_t gauss_lut[GAUSS_LUT_SIZE];

static void init_gauss_lut(void)
{
    for (int i = 0; i < GAUSS_LUT_SIZE; i++) {
        float d2 = (float)i / 256.0f;
        gauss_lut[i] = (uint16_t)(expf(-0.5f * d2) * 65535.0f + 0.5f);
    }
}

/* ================================================================
 * FRAMEBUFFER - MiSTer /dev/fb0
 *
 * MiSTer's Linux framebuffer is typically set up by the MiSTer
 * binary. We query it and render at the native resolution
 * (rounded down to tile-aligned).
 * ================================================================ */

int fb_init(framebuf_t *fb)
{
    struct fb_var_screeninfo vinfo;
    struct fb_fix_screeninfo finfo;

    memset(fb, 0, sizeof(*fb));

    fb->fd = open("/dev/fb0", O_RDWR);
    if (fb->fd < 0) {
        perror("open /dev/fb0");
        fprintf(stderr, "No framebuffer - will dump PPM files\n");
        fb->fd = -1;
        fb->width = DEFAULT_W;
        fb->height = DEFAULT_H;
        fb->bpp = 32;
        fb->stride = fb->width * 4;
        fb->mmap_size = fb->stride * fb->height;
        fb->tiles_x = fb->width / TILE_W;
        fb->tiles_y = fb->height / TILE_H;
        fb->pixels = calloc(1, fb->mmap_size);
        init_gauss_lut();
        return 0;
    }

    ioctl(fb->fd, FBIOGET_VSCREENINFO, &vinfo);
    ioctl(fb->fd, FBIOGET_FSCREENINFO, &finfo);

    fb->bpp = vinfo.bits_per_pixel;
    /* Round down to tile-aligned resolution */
    fb->width = (vinfo.xres / TILE_W) * TILE_W;
    fb->height = (vinfo.yres / TILE_H) * TILE_H;
    fb->tiles_x = fb->width / TILE_W;
    fb->tiles_y = fb->height / TILE_H;

    fprintf(stderr, "MiSTer FB: %dx%d @ %d bpp, stride=%d (render %dx%d)\n",
            vinfo.xres, vinfo.yres, fb->bpp, finfo.line_length,
            fb->width, fb->height);

    if (fb->bpp != 16 && fb->bpp != 32) {
        fprintf(stderr, "ERROR: unsupported %d bpp (need 16 or 32)\n", fb->bpp);
        close(fb->fd);
        fb->fd = -1;
        return -1;
    }

    fb->stride = finfo.line_length;
    fb->mmap_size = finfo.line_length * vinfo.yres;
    fb->pixels = mmap(NULL, fb->mmap_size,
                       PROT_READ | PROT_WRITE,
                       MAP_SHARED, fb->fd, 0);
    if (fb->pixels == MAP_FAILED) {
        perror("mmap fb");
        close(fb->fd);
        fb->fd = -1;
        return -1;
    }

    /* Clear screen */
    memset(fb->pixels, 0, fb->mmap_size);

    init_gauss_lut();
    return 0;
}

void fb_close(framebuf_t *fb)
{
    if (fb->fd >= 0) {
        memset(fb->pixels, 0, fb->mmap_size);
        munmap((void *)fb->pixels, fb->mmap_size);
        close(fb->fd);
    } else {
        free(fb->pixels);
    }
}

/* ================================================================
 * TILE RASTERIZER
 *
 * Process the frame in 32x32 tiles. For each tile:
 *   1. Clear tile_buf (16KB RGBA float, fits in L1)
 *   2. For each splat whose bbox overlaps this tile, evaluate
 *      the Gaussian and blend into tile_buf
 *   3. Convert tile_buf to RGB565/ARGB8888 and write to framebuffer
 *
 * This avoids DDR3 read-modify-write per pixel per splat.
 * L1 cache on A9 is 32KB data, so 8KB tile + working regs fits.
 * ================================================================ */

void tile_clear(framebuf_t *fb)
{
    memset(fb->tile_buf, 0, sizeof(fb->tile_buf));
}

/* Convert u0.10 fixed-point RGBA tile to framebuffer pixels and blit.
 * Tile buffer values [0, 1023] where 1020 ~ 1.0 (from color << 2).
 * Simple right-shifts convert to output bit depths. */
void tile_flush(framebuf_t *fb, int tile_x, int tile_y)
{
    int x0 = tile_x * TILE_W;
    int y0 = tile_y * TILE_H;
    int screen_h = fb->height;

    if (fb->bpp == 32) {
        /* ---- ARGB8888 (32bpp) path ---- */
        int stride_pixels = fb->stride / 4;

        for (int ty = 0; ty < TILE_H; ty++) {
            int sy = y0 + ty;
            if (sy >= screen_h) break;

            uint32_t *dst = (uint32_t *)fb->pixels + sy * stride_pixels + x0;
            uint16_t *src = &fb->tile_buf[(ty * TILE_W) * 4];

            for (int tx = 0; tx < TILE_W; tx++) {
                /* u0.10 >> 2 = u0.8 [0, 255] */
                uint32_t r8 = src[0] >> 2;
                uint32_t g8 = src[1] >> 2;
                uint32_t b8 = src[2] >> 2;
                if (r8 > 255) r8 = 255;
                if (g8 > 255) g8 = 255;
                if (b8 > 255) b8 = 255;
                dst[tx] = 0xFF000000 | (r8 << 16) | (g8 << 8) | b8;
                src += 4;
            }
        }
    } else {
        /* ---- RGB565 (16bpp) path ---- */
        int stride_pixels = fb->stride / 2;

        for (int ty = 0; ty < TILE_H; ty++) {
            int sy = y0 + ty;
            if (sy >= screen_h) break;

            uint16_t *dst = (uint16_t *)fb->pixels + sy * stride_pixels + x0;
            uint16_t *src = &fb->tile_buf[(ty * TILE_W) * 4];

            for (int tx = 0; tx < TILE_W; tx++) {
                /* u0.10 >> 5 = u0.5 [0, 31] for R/B */
                /* u0.10 >> 4 = u0.6 [0, 63] for G */
                uint32_t r5 = src[0] >> 5;
                uint32_t g6 = src[1] >> 4;
                uint32_t b5 = src[2] >> 5;
                if (r5 > 31) r5 = 31;
                if (g6 > 63) g6 = 63;
                if (b5 > 31) b5 = 31;
                dst[tx] = (uint16_t)((r5 << 11) | (g6 << 5) | b5);
                src += 4;
            }
        }
    }
}

/* PPM dump for headless testing */
void fb_dump_ppm(framebuf_t *fb, const char *path)
{
    FILE *f = fopen(path, "wb");
    if (!f) return;
    fprintf(f, "P6\n%d %d\n255\n", fb->width, fb->height);

    if (fb->bpp == 32) {
        int stride_pixels = fb->stride / 4;
        for (int y = 0; y < fb->height; y++) {
            for (int x = 0; x < fb->width; x++) {
                uint32_t p = ((uint32_t *)fb->pixels)[y * stride_pixels + x];
                uint8_t rgb[3] = {
                    (uint8_t)((p >> 16) & 0xFF),
                    (uint8_t)((p >> 8)  & 0xFF),
                    (uint8_t)( p        & 0xFF),
                };
                fwrite(rgb, 1, 3, f);
            }
        }
    } else {
        int stride_pixels = fb->stride / 2;
        for (int y = 0; y < fb->height; y++) {
            for (int x = 0; x < fb->width; x++) {
                uint16_t p = ((uint16_t *)fb->pixels)[y * stride_pixels + x];
                uint8_t rgb[3] = {
                    (uint8_t)(((p >> 11) & 0x1F) * 255 / 31),
                    (uint8_t)(((p >> 5)  & 0x3F) * 255 / 63),
                    (uint8_t)(( p        & 0x1F) * 255 / 31),
                };
                fwrite(rgb, 1, 3, f);
            }
        }
    }
    fclose(f);
}

/* ================================================================
 * SPLAT STORE
 * ================================================================ */

void store_init(splat_store_t *store)
{
    store->count = 0;
}

int store_add(splat_store_t *store, const splat_3d_t *splat)
{
    if (store->count >= MAX_SPLATS) return -1;
    store->splats_3d[store->count] = *splat;
    store->count++;
    return 0;
}

/* ================================================================
 * CAMERA
 * ================================================================ */

void cam_init(camera_t *cam, float fov_deg, int width, int height)
{
    float fov_rad = fov_deg * (float)(M_PI / 180.0);
    cam->fy = (height / 2.0f) / tanf(fov_rad / 2.0f);
    cam->fx = cam->fy;
    cam->cx = width / 2.0f;
    cam->cy = height / 2.0f;

    memset(cam->view, 0, sizeof(cam->view));
    cam->view[0] = cam->view[5] = cam->view[10] = cam->view[15] = 1.0f;
    memset(cam->pos, 0, sizeof(cam->pos));
}

static inline float v3_dot(const float *a, const float *b)
{
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

void cam_lookat(camera_t *cam, float *eye, float *target, float *up)
{
    float f[3], s[3], u[3];

    f[0] = target[0] - eye[0];
    f[1] = target[1] - eye[1];
    f[2] = target[2] - eye[2];
    float flen = sqrtf(v3_dot(f, f));
    f[0] /= flen; f[1] /= flen; f[2] /= flen;

    s[0] = f[1]*up[2] - f[2]*up[1];
    s[1] = f[2]*up[0] - f[0]*up[2];
    s[2] = f[0]*up[1] - f[1]*up[0];
    float slen = sqrtf(v3_dot(s, s));
    s[0] /= slen; s[1] /= slen; s[2] /= slen;

    u[0] = s[1]*f[2] - s[2]*f[1];
    u[1] = s[2]*f[0] - s[0]*f[2];
    u[2] = s[0]*f[1] - s[1]*f[0];

    cam->pos[0] = eye[0];
    cam->pos[1] = eye[1];
    cam->pos[2] = eye[2];

    float *m = cam->view;
    m[0]  =  s[0]; m[4]  =  s[1]; m[8]  =  s[2]; m[12] = -v3_dot(s, eye);
    m[1]  =  u[0]; m[5]  =  u[1]; m[9]  =  u[2]; m[13] = -v3_dot(u, eye);
    m[2]  = -f[0]; m[6]  = -f[1]; m[10] = -f[2]; m[14] =  v3_dot(f, eye);
    m[3]  =  0;    m[7]  =  0;    m[11] =  0;    m[15] =  1.0f;
}

/* ================================================================
 * PROJECTION (EWA splatting)
 * ================================================================ */

void project_splats(splat_store_t *store, const camera_t *cam, const framebuf_t *fb)
{
    const float *m = cam->view;
    int screen_w = fb->width;
    int screen_h = fb->height;

    for (int i = 0; i < store->count; i++) {
        splat_3d_t *s3 = &store->splats_3d[i];
        splat_2d_t *s2 = &store->splats_2d[i];

        /* Transform to camera space */
        float cx = m[0]*s3->x + m[4]*s3->y + m[8]*s3->z  + m[12];
        float cy = m[1]*s3->x + m[5]*s3->y + m[9]*s3->z  + m[13];
        float cz = m[2]*s3->x + m[6]*s3->y + m[10]*s3->z + m[14];

        if (cz >= -0.1f) {
            s2->depth = 1e30f;
            s2->bbox_x0 = s2->bbox_x1 = 0;
            s2->bbox_y0 = s2->bbox_y1 = 0;
            continue;
        }

        float iz = -1.0f / cz;

        float sx_f = cam->fx * cx * iz + cam->cx;
        float sy_f = cam->fy * cy * iz + cam->cy;
        s2->depth = -cz;

        /* Jacobian of perspective projection */
        float jx_z  = cam->fx * iz;
        float jy_z  = cam->fy * iz;
        float jx_zz = cam->fx * cx * iz * iz;
        float jy_zz = cam->fy * cy * iz * iz;

        float J[2][3] = {
            { jx_z,  0,     jx_zz },
            { 0,     jy_z,  jy_zz }
        };

        /* View rotation (upper-left 3x3) */
        float R[3][3] = {
            { m[0], m[4], m[8]  },
            { m[1], m[5], m[9]  },
            { m[2], m[6], m[10] }
        };

        /* W = J * R (2x3) */
        float W[2][3];
        for (int r = 0; r < 2; r++)
            for (int c = 0; c < 3; c++)
                W[r][c] = J[r][0]*R[0][c] + J[r][1]*R[1][c] + J[r][2]*R[2][c];

        /* Unpack symmetric 3x3 covariance */
        float S[3][3] = {
            { s3->cov[0], s3->cov[1], s3->cov[2] },
            { s3->cov[1], s3->cov[3], s3->cov[4] },
            { s3->cov[2], s3->cov[4], s3->cov[5] }
        };

        /* T = W * S (2x3) */
        float T[2][3];
        for (int r = 0; r < 2; r++)
            for (int c = 0; c < 3; c++)
                T[r][c] = W[r][0]*S[0][c] + W[r][1]*S[1][c] + W[r][2]*S[2][c];

        /* cov2d = T * Wᵀ (2x2 symmetric) */
        float ca = T[0][0]*W[0][0] + T[0][1]*W[0][1] + T[0][2]*W[0][2] + 0.3f;
        float cb = T[0][0]*W[1][0] + T[0][1]*W[1][1] + T[0][2]*W[1][2];
        float cc = T[1][0]*W[1][0] + T[1][1]*W[1][1] + T[1][2]*W[1][2] + 0.3f;

        float det = ca * cc - cb * cb;
        if (det < 1e-8f) {
            s2->depth = 1e30f;
            s2->bbox_x0 = s2->bbox_x1 = 0;
            s2->bbox_y0 = s2->bbox_y1 = 0;
            continue;
        }

        float inv_det = 1.0f / det;
        float inv_a =  cc * inv_det;
        float inv_b = -cb * inv_det;
        float inv_c =  ca * inv_det;

        /* Bounding box (3-sigma) */
        float rx = 3.0f * sqrtf(ca);
        float ry = 3.0f * sqrtf(cc);

        float bx0 = sx_f - rx;
        float by0 = sy_f - ry;
        float bx1 = sx_f + rx;
        float by1 = sy_f + ry;

        /* Skip splats entirely off-screen or with NaN coords */
        if (bx1 < 0 || by1 < 0 || bx0 >= screen_w || by0 >= screen_h
            || bx0 != bx0 || by0 != by0) {
            s2->depth = 1e30f;
            s2->bbox_x0 = s2->bbox_x1 = 0;
            s2->bbox_y0 = s2->bbox_y1 = 0;
            continue;
        }

        if (bx0 < 0) bx0 = 0;
        if (by0 < 0) by0 = 0;
        if (bx1 >= screen_w) bx1 = screen_w - 1;
        if (by1 >= screen_h) by1 = screen_h - 1;

        s2->bbox_x0 = (int16_t)bx0;
        s2->bbox_y0 = (int16_t)by0;
        s2->bbox_x1 = (int16_t)bx1;
        s2->bbox_y1 = (int16_t)by1;

        /* Convert screen position to s14.4 fixed-point */
        s2->sx_fp = (int32_t)(sx_f * 16.0f + 0.5f);
        s2->sy_fp = (int32_t)(sy_f * 16.0f + 0.5f);

        /* Convert inverse covariance to fixed-point u2.14 / s2.14 */
        if (inv_a > 3.999f) inv_a = 3.999f;
        if (inv_c > 3.999f) inv_c = 3.999f;
        float inv_b2 = 2.0f * inv_b;
        if (inv_b2 > 3.999f) inv_b2 = 3.999f;
        if (inv_b2 < -4.0f) inv_b2 = -4.0f;

        s2->cov_a_fp = (uint16_t)(inv_a * 16384.0f + 0.5f);
        s2->cov_b2_fp = (int32_t)(inv_b2 * 16384.0f);
        s2->cov_c_fp = (uint16_t)(inv_c * 16384.0f + 0.5f);

        /* Color and opacity stay as u0.8 integers */
        s2->r = s3->r;
        s2->g = s3->g;
        s2->b = s3->b;
        s2->opacity = s3->alpha;
    }
}

/* ================================================================
 * RADIX SORT (16-bit key from quantized depth)
 *
 * Much faster than qsort for large N on A9.
 * Two-pass 8-bit radix sort on a 16-bit depth key.
 * Back-to-front: larger depth values come first.
 * ================================================================ */

void sort_splats(splat_store_t *store)
{
    int n = store->count;
    if (n == 0) return;

    /* Find depth range for quantization */
    float dmin = 1e30f, dmax = 0;
    for (int i = 0; i < n; i++) {
        float d = store->splats_2d[i].depth;
        if (d < 1e20f) { /* skip culled splats */
            if (d < dmin) dmin = d;
            if (d > dmax) dmax = d;
        }
    }

    float range = dmax - dmin;
    if (range < 1e-6f) range = 1.0f;
    float scale = 65535.0f / range;

    /* Generate 16-bit sort keys (inverted for back-to-front) */
    static uint16_t keys[MAX_SPLATS];
    static uint32_t buf_idx[MAX_SPLATS];

    for (int i = 0; i < n; i++) {
        store->sort_idx[i] = i;
        float d = store->splats_2d[i].depth;
        if (d >= 1e20f)
            keys[i] = 0; /* culled splats sort to end (back) */
        else
            keys[i] = 65535 - (uint16_t)((d - dmin) * scale); /* invert for back-to-front */
    }

    /* Pass 1: sort by low byte */
    uint32_t count[256];
    memset(count, 0, sizeof(count));
    for (int i = 0; i < n; i++) count[keys[i] & 0xFF]++;

    uint32_t offset[256];
    offset[0] = 0;
    for (int i = 1; i < 256; i++) offset[i] = offset[i-1] + count[i-1];

    for (int i = 0; i < n; i++) {
        uint8_t k = keys[store->sort_idx[i]] & 0xFF;
        buf_idx[offset[k]++] = store->sort_idx[i];
    }

    /* Pass 2: sort by high byte */
    memset(count, 0, sizeof(count));
    for (int i = 0; i < n; i++) count[(keys[buf_idx[i]] >> 8) & 0xFF]++;

    offset[0] = 0;
    for (int i = 1; i < 256; i++) offset[i] = offset[i-1] + count[i-1];

    for (int i = 0; i < n; i++) {
        uint8_t k = (keys[buf_idx[i]] >> 8) & 0xFF;
        store->sort_idx[offset[k]++] = buf_idx[i];
    }
}

/* ================================================================
 * RASTERIZATION - Tile-based, back-to-front
 * ================================================================ */

/* Rasterize a single splat into the current tile buffer.
 *
 * Fully integer/fixed-point — no float. Designed to map directly
 * to FPGA pipeline with 18-bit DSP multiply blocks.
 *
 * Fixed-point chain:
 *   dx, dy:      s14.4 (18 bits)
 *   dx², dy²:    (dx*dx)>>4  ~17 bits unsigned
 *   dx*dy:       (dx*dy)>>4  ~18 bits signed
 *   a, c:        u2.14 (16 bits)
 *   2*b:         s2.14 (17 bits)
 *   d² sum:      u4.18 (~22 bits) = d²_float * 2^18
 *   gauss LUT:   u0.16 (16 bits)
 *   w:           u0.7  (0..128, where 128 = 1.0)
 *   tile_buf:    u0.10 per channel (0..1023)
 */
static inline void rasterize_splat_tile(
    uint16_t *tile_buf,
    const splat_2d_t *s,
    int tile_px, int tile_py)
{
    /* Clip splat bbox to tile */
    int x0 = s->bbox_x0 - tile_px;
    int y0 = s->bbox_y0 - tile_py;
    int x1 = s->bbox_x1 - tile_px;
    int y1 = s->bbox_y1 - tile_py;

    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= TILE_W) x1 = TILE_W - 1;
    if (y1 >= TILE_H) y1 = TILE_H - 1;
    if (x0 > x1 || y0 > y1) return;

    /* Load splat parameters (all integer) */
    int32_t a_fp  = s->cov_a_fp;     /* u2.14, 16 bits */
    int32_t b2_fp = s->cov_b2_fp;    /* s2.14, 17 bits (includes 2x factor) */
    int32_t c_fp  = s->cov_c_fp;     /* u2.14, 16 bits */
    int32_t sx_fp = s->sx_fp;        /* s14.4 */
    int32_t sy_fp = s->sy_fp;        /* s14.4 */

    /* Color scaled to u0.10: [0,255] -> [0,1020] */
    int32_t cr = ((int32_t)s->r) << 2;
    int32_t cg = ((int32_t)s->g) << 2;
    int32_t cb = ((int32_t)s->b) << 2;
    int32_t opacity = s->opacity;     /* u0.8 */

    for (int ty = y0; ty <= y1; ty++) {
        /* dy in s14.4: pixel center = (tile_py + ty) * 16 + 8 */
        int32_t dy_fp = ((tile_py + ty) * 16 + 8) - sy_fp;

        /* dy² >> 4 (row-invariant, unsigned, ~17 bits)
         * On FPGA: single 18x18 multiply, shift is free wiring */
        int32_t dy2_s = (int32_t)(((int64_t)dy_fp * dy_fp) >> 4);

        /* c * dy² term (row-invariant): u2.14 * u17 -> ~31 bits
         * Represents c * dy² * 2^18 */
        int64_t term_c = (int64_t)c_fp * dy2_s;

        uint16_t *row = &tile_buf[ty * TILE_W * 4];

        /* Initial dx in s14.4 */
        int32_t dx_fp = ((tile_px + x0) * 16 + 8) - sx_fp;

        /* Precompute initial dx² and dx*dy (raw, before >>4) */
        int32_t dx2_raw  = (int32_t)(((int64_t)dx_fp * dx_fp));
        int32_t dxdy_raw = (int32_t)(((int64_t)dx_fp * dy_fp));

        for (int tx = x0; tx <= x1; tx++) {
            /* Shifted products (>>4 = divide by 16, free in FPGA) */
            int32_t dx2_s  = dx2_raw >> 4;   /* unsigned, ~17 bits */
            int32_t dxdy_s = dxdy_raw >> 4;  /* signed, ~18 bits */

            /* d² = a*dx² + 2*b*dx*dy + c*dy²
             * Each product uses one 18x18 DSP block.
             * All terms in d² * 2^18 scaling. */
            int64_t term_a = (int64_t)a_fp * dx2_s;
            int64_t term_b = (int64_t)b2_fp * dxdy_s;

            int32_t d2_sum = (int32_t)(term_a + term_b + term_c);

            /* Cutoff: d² >= 8.0 (in u4.18: 8 << 18 = 2097152) */
            if (d2_sum < 0 || d2_sum >= GAUSS_LUT_D2_CUTOFF_FP) goto next_pixel;

            {
                /* LUT index: d2_sum is d²*2^18, want d²*256 = d2_sum>>10 */
                int32_t lut_idx = d2_sum >> 10;
                if (lut_idx >= GAUSS_LUT_SIZE) goto next_pixel;

                /* Gaussian value (u0.16) */
                uint32_t gauss = gauss_lut[lut_idx];

                /* Weight: gauss * opacity -> u0.16 * u0.8 = u0.24
                 * Scale to u0.7: >>17.  w range [0, 128] */
                int32_t w = (int32_t)((gauss * (uint32_t)opacity) >> 17);
                if (w <= 0) goto next_pixel;
                if (w > 128) w = 128;

                int32_t omw = 128 - w;

                /* Alpha blend: px_new = (color_10 * w + px_old * omw) >> 7
                 * color_10 (10 bits) * w (7 bits) = 17 bits -> fits 18x18
                 * px_old (10 bits) * omw (8 bits) = 18 bits -> fits 18x18 */
                uint16_t *px = &row[tx * 4];
                px[0] = (uint16_t)((cr * w + (int32_t)px[0] * omw) >> 7);
                px[1] = (uint16_t)((cg * w + (int32_t)px[1] * omw) >> 7);
                px[2] = (uint16_t)((cb * w + (int32_t)px[2] * omw) >> 7);
                px[3] = (uint16_t)((1020 * w + (int32_t)px[3] * omw) >> 7);
            }

        next_pixel:
            /* Incremental update for next pixel (dx increases by 16 in s14.4)
             * dx2_next = (dx+16)² = dx² + 32*dx + 256
             * dxdy_next = (dx+16)*dy = dx*dy + 16*dy
             * These replace two 18x18 multiplies with shifts + adds. */
            dx2_raw += (dx_fp << 5) + 256;
            dxdy_raw += (dy_fp << 4);
            dx_fp += 16;
        }
    }
}

void rasterize_splats(const splat_store_t *store, framebuf_t *fb)
{
    for (int tile_y = 0; tile_y < fb->tiles_y; tile_y++) {
        int tpy = tile_y * TILE_H;

        for (int tile_x = 0; tile_x < fb->tiles_x; tile_x++) {
            int tpx = tile_x * TILE_W;

            /* Clear tile */
            tile_clear(fb);

            /* Rasterize all overlapping splats into this tile */
            for (int si = 0; si < store->count; si++) {
                uint32_t idx = store->sort_idx[si];
                const splat_2d_t *s = &store->splats_2d[idx];

                /* Quick reject: does splat bbox overlap this tile? */
                if (s->bbox_x1 < tpx || s->bbox_x0 >= tpx + TILE_W) continue;
                if (s->bbox_y1 < tpy || s->bbox_y0 >= tpy + TILE_H) continue;

                rasterize_splat_tile(fb->tile_buf, s, tpx, tpy);
            }

            /* Flush tile to framebuffer */
            tile_flush(fb, tile_x, tile_y);
        }
    }
}

/* ================================================================
 * SerDes / GA144 INPUT
 *
 * GA144 has 18-bit words. Proposed wire format over async serial:
 *
 *   Byte protocol (8N1 UART, wrapping 18-bit data):
 *   Each 18-bit word sent as 3 bytes: [5:0][11:6][17:12]
 *   (little-endian, 6 bits per byte, top 2 bits = framing)
 *
 *   Frame format:
 *     0x3FFFF  - sync word
 *     N        - splat count
 *     Per splat (11 words = 33 bytes):
 *       X, Y, Z     - 18-bit signed fixed-point (s1.16)
 *       COV[6]      - 18-bit unsigned fixed-point (0.18)
 *       RGB_packed   - 18 bits: R[17:12] G[11:6] B[5:0]
 *       ALPHA        - 18 bits (use low 8)
 *
 * MiSTer UART: accessible via GPIO header on DE10-Nano.
 *   - UART0: /dev/ttyS0 (directly on HPS)
 *   - USB serial: /dev/ttyUSB0 or /dev/ttyACM0
 *   - For highest speed, use HPS SPI or GPIO bitbang for
 *     the GA144's synchronous serial
 * ================================================================ */

int serdes_init(const char *dev_path)
{
    int fd = open(dev_path, O_RDWR | O_NOCTTY);
    if (fd < 0) {
        perror("open serial");
        return -1;
    }

    struct termios tty;
    memset(&tty, 0, sizeof(tty));
    tcgetattr(fd, &tty);

    /* 115200 for initial testing. GA144 async serial is typically
     * much slower, but you might use SPI for real throughput. */
    cfsetispeed(&tty, B115200);
    cfsetospeed(&tty, B115200);

    cfmakeraw(&tty);
    tty.c_cflag = CS8 | CREAD | CLOCAL;
    tty.c_cc[VMIN]  = 0;
    tty.c_cc[VTIME] = 5; /* 500ms timeout */

    tcsetattr(fd, TCSANOW, &tty);
    tcflush(fd, TCIOFLUSH);

    fprintf(stderr, "GA144 SerDes opened on %s @ 115200\n", dev_path);
    return fd;
}

/* Read exactly n bytes from serial (with retry) */
static int serial_read_exact(int fd, uint8_t *buf, int n)
{
    int total = 0;
    while (total < n) {
        int r = read(fd, buf + total, n - total);
        if (r <= 0) return -1;
        total += r;
    }
    return total;
}

/* Unpack 3 bytes -> 18-bit word (little-endian, 6 bits/byte) */
static inline uint32_t unpack18(const uint8_t *p)
{
    return (p[0] & 0x3F) | ((p[1] & 0x3F) << 6) | ((p[2] & 0x3F) << 12);
}

/* Convert 18-bit signed fixed-point s1.16 to float */
static inline float s1_16_to_float(uint32_t v)
{
    int32_t sv = (v & 0x20000) ? (int32_t)(v | 0xFFFC0000) : (int32_t)v;
    return sv / 65536.0f;
}

/* Convert 18-bit unsigned fixed-point 0.18 to float */
static inline float u0_18_to_float(uint32_t v)
{
    return v / 262144.0f;
}

int serdes_recv_splats(int fd, splat_store_t *store)
{
    uint8_t sync_buf[3];
    uint32_t sync_word;

    /* Hunt for sync */
    int attempts = 0;
    do {
        if (serial_read_exact(fd, sync_buf, 3) < 0) return -1;
        sync_word = unpack18(sync_buf);
        if (++attempts > 1000) {
            fprintf(stderr, "GA144: no sync after 1000 attempts\n");
            return -1;
        }
    } while (sync_word != 0x3FFFF);

    /* Read count */
    uint8_t cnt_buf[3];
    if (serial_read_exact(fd, cnt_buf, 3) < 0) return -1;
    int count = (int)unpack18(cnt_buf);

    if (count <= 0 || count > MAX_SPLATS) {
        fprintf(stderr, "GA144: bad splat count %d\n", count);
        return -1;
    }

    fprintf(stderr, "GA144: receiving %d splats...\n", count);
    store_init(store);

    uint8_t pkt[33]; /* 11 words * 3 bytes */
    for (int i = 0; i < count; i++) {
        if (serial_read_exact(fd, pkt, 33) < 0) {
            fprintf(stderr, "GA144: read error at splat %d\n", i);
            return -1;
        }

        splat_3d_t s;
        s.x = s1_16_to_float(unpack18(&pkt[0]));
        s.y = s1_16_to_float(unpack18(&pkt[3]));
        s.z = s1_16_to_float(unpack18(&pkt[6]));

        for (int j = 0; j < 6; j++)
            s.cov[j] = u0_18_to_float(unpack18(&pkt[9 + j * 3]));

        uint32_t rgb = unpack18(&pkt[27]);
        s.r = (rgb >> 12) & 0x3F;
        s.g = (rgb >> 6)  & 0x3F;
        s.b =  rgb        & 0x3F;
        /* Scale 6-bit color to 8-bit */
        s.r = (s.r << 2) | (s.r >> 4);
        s.g = (s.g << 2) | (s.g >> 4);
        s.b = (s.b << 2) | (s.b >> 4);

        s.alpha = unpack18(&pkt[30]) & 0xFF;

        store_add(store, &s);
    }

    fprintf(stderr, "GA144: received %d splats\n", store->count);
    return store->count;
}

void serdes_close(int fd)
{
    if (fd >= 0) close(fd);
}

/* ================================================================
 * TEST DATA
 * ================================================================ */

void generate_test_splats(splat_store_t *store, int count)
{
    srand(42);

    for (int i = 0; i < count && i < MAX_SPLATS; i++) {
        splat_3d_t s;

        float u = (float)rand() / RAND_MAX;
        float v = (float)rand() / RAND_MAX;
        float w = (float)rand() / RAND_MAX;

        float theta = 2.0f * (float)M_PI * u;
        float phi = acosf(2.0f * v - 1.0f);
        float r = 2.0f * cbrtf(w);

        s.x = r * sinf(phi) * cosf(theta);
        s.y = r * sinf(phi) * sinf(theta);
        s.z = r * cosf(phi);

        float variance = 0.005f + 0.02f * ((float)rand() / RAND_MAX);
        s.cov[0] = variance;
        s.cov[1] = 0;
        s.cov[2] = 0;
        s.cov[3] = variance;
        s.cov[4] = 0;
        s.cov[5] = variance;

        s.r = (uint8_t)(128 + 60 * s.x);
        s.g = (uint8_t)(128 + 60 * s.y);
        s.b = (uint8_t)(128 + 60 * s.z);
        s.alpha = 180 + (rand() % 75);

        store_add(store, &s);
    }

    fprintf(stderr, "Generated %d test splats\n", store->count);
}

/* ================================================================
 * PNG SPLAT LOADING
 *
 * Packed format in a 640x480 RGB PNG (921,600 bytes):
 *
 *   Header (first 6 bytes = pixels [0,0]..[1,0]):
 *     Bytes 0-1: splat count (uint16 little-endian)
 *     Bytes 2-5: reserved (zero)
 *
 *   Per splat (18 bytes = 6 consecutive RGB pixels):
 *     Bytes  0-1:  X position, int16 LE, s7.8 fixed-point (range ~[-128,+128])
 *     Bytes  2-3:  Y position, int16 LE, s7.8 fixed-point
 *     Bytes  4-5:  Z position, int16 LE, s7.8 fixed-point
 *     Bytes  6-11: cov[0..5], uint8 each, 0.8 fixed-point (range [0,1))
 *     Bytes 12-14: R, G, B (uint8)
 *     Bytes 15:    alpha (uint8)
 *     Bytes 16-17: reserved
 *
 *   Splats start at byte offset 18 (pixel 6).
 *   Max splats: (640*480*3 - 18) / 18 = 51,199
 * ================================================================ */

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_NO_LINEAR
#define STBI_NO_HDR
#include "stb_image.h"

int load_splats_png(const char *path, splat_store_t *store)
{
    int w, h, channels;
    uint8_t *img = stbi_load(path, &w, &h, &channels, 3);
    if (!img) {
        fprintf(stderr, "Failed to load PNG: %s\n", stbi_failure_reason());
        return -1;
    }

    int total_bytes = w * h * 3;
    if (total_bytes < 18) {
        fprintf(stderr, "PNG too small: %dx%d\n", w, h);
        stbi_image_free(img);
        return -1;
    }

    /* Read header */
    uint8_t *p = img;
    int count = p[0] | (p[1] << 8);

    int max_splats = (total_bytes - 18) / 18;
    if (count > max_splats) count = max_splats;
    if (count > MAX_SPLATS) count = MAX_SPLATS;

    fprintf(stderr, "PNG %dx%d, loading %d splats\n", w, h, count);

    store_init(store);

    for (int i = 0; i < count; i++) {
        uint8_t *sp = img + 18 + i * 18;
        splat_3d_t s;

        /* Position: int16 LE s7.8 fixed-point */
        int16_t ix = (int16_t)(sp[0] | (sp[1] << 8));
        int16_t iy = (int16_t)(sp[2] | (sp[3] << 8));
        int16_t iz = (int16_t)(sp[4] | (sp[5] << 8));
        s.x = ix / 256.0f;
        s.y = iy / 256.0f;
        s.z = iz / 256.0f;

        /* Covariance: uint8 0.8 fixed-point, scaled to reasonable range */
        for (int j = 0; j < 6; j++)
            s.cov[j] = sp[6 + j] / 256.0f;

        /* Color */
        s.r = sp[12];
        s.g = sp[13];
        s.b = sp[14];
        s.alpha = sp[15];

        store_add(store, &s);
    }

    stbi_image_free(img);
    fprintf(stderr, "Loaded %d splats from %s\n", store->count, path);
    return store->count;
}

/* ================================================================
 * FPGA OFFLOAD
 *
 * The FPGA reads sorted splat_2d_t data from DDR3 and rasterizes
 * tiles directly, writing the result to the DDR3 framebuffer.
 * The MiSTer framework handles video scan-out from DDR3.
 *
 * DDR3 shared memory layout:
 *   0x30000000  Framebuffer (640x480x4 = 1.2MB) - FPGA writes
 *   0x30200000  Splat array (MAX_SPLATS * 32B)   - HPS writes
 *   0x30400000  Control block (64B)               - shared
 *
 * Control block layout:
 *   [0]  uint32_t splat_count     HPS writes
 *   [1]  uint32_t frame_request   HPS writes 1, FPGA clears
 *   [2]  uint32_t frame_done      FPGA writes 1, HPS reads+clears
 *   [3]  uint32_t frame_number    FPGA increments
 * ================================================================ */

#define FPGA_FB_BASE     0x30000000
/* FB_A at 0x30000000, FB_B at 0x30200000 (dual buffering handled by FPGA) */
#define FPGA_CTRL_BASE   0x30400000
#define FPGA_DESC_BASE   0x30400100          /* after 256-byte control block */
#define FPGA_DESC_MMAP   0x30400000          /* page-aligned base for mmap */
#define FPGA_DESC_OFFSET 0x100               /* offset within mapped page */
#define FPGA_DESC_SIZE   (30 * 1024 * 1024)  /* 30MB for tile descriptors */
#define FPGA_CTRL_SIZE   64

int fpga_init(fpga_ctx_t *ctx)
{
    memset(ctx, 0, sizeof(*ctx));
    ctx->mem_fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (ctx->mem_fd < 0) {
        perror("open /dev/mem");
        return -1;
    }

    ctx->ctrl_map = mmap(NULL, FPGA_CTRL_SIZE, PROT_READ | PROT_WRITE,
                         MAP_SHARED, ctx->mem_fd, FPGA_CTRL_BASE);
    if (ctx->ctrl_map == MAP_FAILED) {
        perror("mmap ctrl");
        close(ctx->mem_fd);
        return -1;
    }
    ctx->ctrl = (volatile uint32_t *)ctx->ctrl_map;

    ctx->desc_map = mmap(NULL, FPGA_DESC_SIZE + FPGA_DESC_OFFSET, PROT_READ | PROT_WRITE,
                          MAP_SHARED, ctx->mem_fd, FPGA_DESC_MMAP);
    if (ctx->desc_map == MAP_FAILED) {
        perror("mmap desc");
        munmap(ctx->ctrl_map, FPGA_CTRL_SIZE);
        close(ctx->mem_fd);
        return -1;
    }
    ctx->desc = (uint8_t *)ctx->desc_map + FPGA_DESC_OFFSET;

    /* Map framebuffer region for debug readback */
    #define FPGA_FB_SIZE (640 * 480 * 4)
    ctx->fb_map = mmap(NULL, FPGA_FB_SIZE, PROT_READ | PROT_WRITE,
                        MAP_SHARED, ctx->mem_fd, FPGA_FB_BASE);
    if (ctx->fb_map == MAP_FAILED) {
        fprintf(stderr, "mmap fb (non-fatal)\n");
        ctx->fb_map = NULL;
        ctx->fb = NULL;
    } else {
        ctx->fb = (volatile uint32_t *)ctx->fb_map;
    }

    /* Clear control block */
    ctx->ctrl[0] = 0;  /* splat_count */
    ctx->ctrl[1] = 0;  /* frame_request */
    ctx->ctrl[2] = 0;  /* frame_done */
    ctx->ctrl[3] = 0;  /* frame_number */
    __sync_synchronize();

    fprintf(stderr, "FPGA offload: ctrl@%p desc@%p\n",
            ctx->ctrl_map, ctx->desc_map);

    /* Verify DDR3 mapping: read back what we wrote */
    fprintf(stderr, "  ctrl readback: [0]=%u [1]=%u [2]=%u [3]=%u\n",
            ctx->ctrl[0], ctx->ctrl[1], ctx->ctrl[2], ctx->ctrl[3]);

    /* Test write/read to descriptor region */
    volatile uint32_t *test = (volatile uint32_t *)ctx->desc;
    test[0] = 0xDEADBEEF;
    __sync_synchronize();
    fprintf(stderr, "  desc region test: wrote 0xDEADBEEF, read 0x%08X\n", test[0]);
    test[0] = 0;

    return 0;
}

void fpga_close(fpga_ctx_t *ctx)
{
    if (ctx->fb_map && ctx->fb_map != MAP_FAILED)
        munmap(ctx->fb_map, FPGA_FB_SIZE);
    if (ctx->desc_map && ctx->desc_map != MAP_FAILED)
        munmap(ctx->desc_map, FPGA_DESC_SIZE + FPGA_DESC_OFFSET);
    if (ctx->ctrl_map && ctx->ctrl_map != MAP_FAILED)
        munmap(ctx->ctrl_map, FPGA_CTRL_SIZE);
    if (ctx->mem_fd >= 0)
        close(ctx->mem_fd);
}

void fpga_rasterize(fpga_ctx_t *ctx, const splat_store_t *store, const framebuf_t *fb)
{
    /* Build per-tile linked descriptors in DDR3.
     *
     * Each tile descriptor:
     *   Qword 0: [28:0]=fb_qaddr [60:32]=next_tile_qaddr (0=last)
     *   Qword 1: [15:0]=splat_count [31:16]=tile_px [47:32]=tile_py
     *   Qword 2..N+1: inline splat_2d_t data (N*4 qwords)
     */
    uint8_t *desc_base = (uint8_t *)ctx->desc;
    uint32_t desc_offset = 0;
    uint32_t prev_hdr_offset = 0;  /* byte offset of previous descriptor header */
    int has_prev = 0;
    uint32_t first_tile_qaddr = 0;

    for (int ty = 0; ty < fb->tiles_y; ty++) {
        int tpy = ty * TILE_H;
        for (int tx = 0; tx < fb->tiles_x; tx++) {
            int tpx = tx * TILE_W;

            /* Align to 8 bytes */
            desc_offset = (desc_offset + 7) & ~7;

            /* Check we don't overflow the descriptor region */
            if (desc_offset + 16 > FPGA_DESC_SIZE) {
                fprintf(stderr, "FPGA: descriptor overflow at tile %d,%d\n", tx, ty);
                goto done_building;
            }

            uint64_t *desc = (uint64_t *)(desc_base + desc_offset);
            uint32_t tile_qaddr = (FPGA_DESC_BASE + desc_offset) >> 3;

            if (!has_prev) first_tile_qaddr = tile_qaddr;

            /* Patch previous descriptor's next pointer */
            if (has_prev) {
                uint64_t *prev = (uint64_t *)(desc_base + prev_hdr_offset);
                prev[0] = (prev[0] & 0x1FFFFFFFULL) | ((uint64_t)tile_qaddr << 32);
            }

            /* Collect overlapping splats inline */
            int count = 0;
            uint64_t *splat_dst = &desc[2];

            for (int si = 0; si < store->count; si++) {
                uint32_t idx = store->sort_idx[si];
                const splat_2d_t *s = &store->splats_2d[idx];

                if (s->bbox_x1 < tpx || s->bbox_x0 >= tpx + TILE_W) continue;
                if (s->bbox_y1 < tpy || s->bbox_y0 >= tpy + TILE_H) continue;

                /* Check space for this splat (4 qwords = 32 bytes) */
                uint32_t needed = desc_offset + (2 + (count + 1) * 4) * 8;
                if (needed > FPGA_DESC_SIZE) {
                    fprintf(stderr, "FPGA: descriptor overflow at splat %d in tile %d,%d\n",
                            count, tx, ty);
                    break;
                }

                /* Copy 32 bytes (4 qwords) inline */
                memcpy(&splat_dst[count * 4], s, 32);
                count++;
            }

            /* Write header qword 0: fb_qaddr in [28:0], next=0 for now */
            uint32_t fb_qaddr = (FPGA_FB_BASE >> 3) +
                                (uint32_t)tpy * (640 * 4 / 8) +
                                (uint32_t)tpx / 2;
            desc[0] = (uint64_t)(fb_qaddr & 0x1FFFFFFF);  /* next=0 */

            /* Write header qword 1: count, tile_px, tile_py */
            desc[1] = (uint16_t)count |
                      ((uint32_t)tpx << 16) |
                      ((uint64_t)(uint16_t)tpy << 32);

            prev_hdr_offset = desc_offset;
            has_prev = 1;
            desc_offset += (2 + count * 4) * 8;
        }
    }

done_building:
    if (ctx->verbose)
        fprintf(stderr, "FPGA: built tile descriptors, %u bytes, first@0x%08X\n",
                desc_offset, first_tile_qaddr);

    /* Signal FPGA: ctrl[0] = first tile descriptor qword address */
    ctx->ctrl[0] = first_tile_qaddr;
    ctx->ctrl[2] = 0;   /* clear frame_done */
    __sync_synchronize();
    ctx->ctrl[1] = 1;   /* frame_request = 1 */

    /* Wait for FPGA to finish */
    int timeout = 0;
    while (ctx->ctrl[2] == 0) {
        usleep(10000);  /* 10ms sleep */
        timeout++;
        if (ctx->verbose && timeout % 100 == 0) {
            fprintf(stderr, "  waiting... ctrl: first=%u req=%u done=%u tiles=%u (%ds)\n",
                    ctx->ctrl[0], ctx->ctrl[1], ctx->ctrl[2], ctx->ctrl[3],
                    timeout / 100);
        }
        if (timeout > 12000) {  /* 120 second timeout */
            fprintf(stderr, "FPGA timeout! ctrl: first=%u req=%u done=%u tiles=%u\n",
                    ctx->ctrl[0], ctx->ctrl[1], ctx->ctrl[2], ctx->ctrl[3]);
            if (ctx->fb) {
                int nonzero = 0;
                for (int i = 0; i < 640*480 && nonzero < 5; i++) {
                    if (ctx->fb[i] != 0) {
                        if (nonzero == 0)
                            fprintf(stderr, "  FB has data! first pixels: ");
                        fprintf(stderr, "[%d]=0x%08X ", i, ctx->fb[i]);
                        nonzero++;
                    }
                }
                if (nonzero) fprintf(stderr, "\n");
                else fprintf(stderr, "  FB is all zeros\n");
            }
            break;
        }
    }
    if (ctx->ctrl[2] != 0 && ctx->verbose) {
        fprintf(stderr, "FPGA frame done! tiles=%u\n", ctx->ctrl[3]);
    }
}
