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

#ifdef __ARM_NEON
#include <arm_neon.h>
#endif

/* ================================================================
 * EXP() LOOKUP TABLE
 *
 * The Gaussian kernel exp(-0.5 * d²) dominates the inner loop.
 * On A9 without VFPv4, expf() is ~50 cycles. A 1024-entry LUT
 * with linear interpolation is ~5 cycles and accurate to <0.5%.
 *
 * Table covers d² in [0, 9] (3-sigma cutoff).
 * Index = d² * (LUT_SIZE / LUT_RANGE)
 * ================================================================ */

#define EXP_LUT_SIZE  1024
#define EXP_LUT_RANGE 9.0f
#define EXP_LUT_SCALE (EXP_LUT_SIZE / EXP_LUT_RANGE)

static float exp_lut[EXP_LUT_SIZE + 1]; /* +1 for interpolation */

static void init_exp_lut(void)
{
    for (int i = 0; i <= EXP_LUT_SIZE; i++) {
        float d2 = (float)i / EXP_LUT_SCALE;
        exp_lut[i] = expf(-0.5f * d2);
    }
}

static inline float fast_gauss(float d2)
{
    if (d2 >= EXP_LUT_RANGE) return 0.0f;
    float fi = d2 * EXP_LUT_SCALE;
    int idx = (int)fi;
    float frac = fi - idx;
    return exp_lut[idx] + frac * (exp_lut[idx + 1] - exp_lut[idx]);
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
        init_exp_lut();
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

    init_exp_lut();
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
 * L1 cache on A9 is 32KB data, so 16KB tile + working regs fits.
 * ================================================================ */

void tile_clear(framebuf_t *fb)
{
    memset(fb->tile_buf, 0, sizeof(fb->tile_buf));
}

/* Convert float RGBA tile to framebuffer pixels and blit */
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
            float *src = &fb->tile_buf[(ty * TILE_W) * 4];

#ifdef __ARM_NEON
            float32x4_t zero = vdupq_n_f32(0.0f);
            float32x4_t one  = vdupq_n_f32(1.0f);
            float32x4_t scale255 = vdupq_n_f32(255.0f);
            float32x4_t half = vdupq_n_f32(0.5f);

            for (int tx = 0; tx < TILE_W; tx += 4) {
                float32x4_t p0 = vminq_f32(vmaxq_f32(vld1q_f32(src + 0),  zero), one);
                float32x4_t p1 = vminq_f32(vmaxq_f32(vld1q_f32(src + 4),  zero), one);
                float32x4_t p2 = vminq_f32(vmaxq_f32(vld1q_f32(src + 8),  zero), one);
                float32x4_t p3 = vminq_f32(vmaxq_f32(vld1q_f32(src + 12), zero), one);

                p0 = vaddq_f32(vmulq_f32(p0, scale255), half);
                p1 = vaddq_f32(vmulq_f32(p1, scale255), half);
                p2 = vaddq_f32(vmulq_f32(p2, scale255), half);
                p3 = vaddq_f32(vmulq_f32(p3, scale255), half);

                uint32_t r0 = (uint32_t)vgetq_lane_f32(p0, 0);
                uint32_t g0 = (uint32_t)vgetq_lane_f32(p0, 1);
                uint32_t b0 = (uint32_t)vgetq_lane_f32(p0, 2);
                uint32_t r1 = (uint32_t)vgetq_lane_f32(p1, 0);
                uint32_t g1 = (uint32_t)vgetq_lane_f32(p1, 1);
                uint32_t b1 = (uint32_t)vgetq_lane_f32(p1, 2);
                uint32_t r2 = (uint32_t)vgetq_lane_f32(p2, 0);
                uint32_t g2 = (uint32_t)vgetq_lane_f32(p2, 1);
                uint32_t b2 = (uint32_t)vgetq_lane_f32(p2, 2);
                uint32_t r3 = (uint32_t)vgetq_lane_f32(p3, 0);
                uint32_t g3 = (uint32_t)vgetq_lane_f32(p3, 1);
                uint32_t b3 = (uint32_t)vgetq_lane_f32(p3, 2);

                dst[tx + 0] = 0xFF000000 | (r0 << 16) | (g0 << 8) | b0;
                dst[tx + 1] = 0xFF000000 | (r1 << 16) | (g1 << 8) | b1;
                dst[tx + 2] = 0xFF000000 | (r2 << 16) | (g2 << 8) | b2;
                dst[tx + 3] = 0xFF000000 | (r3 << 16) | (g3 << 8) | b3;

                src += 16;
            }
#else
            for (int tx = 0; tx < TILE_W; tx++) {
                float r = src[0], g = src[1], b = src[2];
                if (r > 1.0f) r = 1.0f; if (r < 0.0f) r = 0.0f;
                if (g > 1.0f) g = 1.0f; if (g < 0.0f) g = 0.0f;
                if (b > 1.0f) b = 1.0f; if (b < 0.0f) b = 0.0f;

                uint32_t r8 = (uint32_t)(r * 255.0f + 0.5f);
                uint32_t g8 = (uint32_t)(g * 255.0f + 0.5f);
                uint32_t b8 = (uint32_t)(b * 255.0f + 0.5f);
                dst[tx] = 0xFF000000 | (r8 << 16) | (g8 << 8) | b8;
                src += 4;
            }
#endif
        }
    } else {
        /* ---- RGB565 (16bpp) path ---- */
        int stride_pixels = fb->stride / 2;

        for (int ty = 0; ty < TILE_H; ty++) {
            int sy = y0 + ty;
            if (sy >= screen_h) break;

            uint16_t *dst = (uint16_t *)fb->pixels + sy * stride_pixels + x0;
            float *src = &fb->tile_buf[(ty * TILE_W) * 4];

#ifdef __ARM_NEON
            for (int tx = 0; tx < TILE_W; tx += 4) {
                float32x4_t p0 = vld1q_f32(src + 0);
                float32x4_t p1 = vld1q_f32(src + 4);
                float32x4_t p2 = vld1q_f32(src + 8);
                float32x4_t p3 = vld1q_f32(src + 12);

                float32x4_t zero = vdupq_n_f32(0.0f);
                float32x4_t one  = vdupq_n_f32(1.0f);
                p0 = vminq_f32(vmaxq_f32(p0, zero), one);
                p1 = vminq_f32(vmaxq_f32(p1, zero), one);
                p2 = vminq_f32(vmaxq_f32(p2, zero), one);
                p3 = vminq_f32(vmaxq_f32(p3, zero), one);

                float r0 = vgetq_lane_f32(p0, 0) * 31.0f + 0.5f;
                float g0 = vgetq_lane_f32(p0, 1) * 63.0f + 0.5f;
                float b0 = vgetq_lane_f32(p0, 2) * 31.0f + 0.5f;
                float r1 = vgetq_lane_f32(p1, 0) * 31.0f + 0.5f;
                float g1 = vgetq_lane_f32(p1, 1) * 63.0f + 0.5f;
                float b1 = vgetq_lane_f32(p1, 2) * 31.0f + 0.5f;
                float r2 = vgetq_lane_f32(p2, 0) * 31.0f + 0.5f;
                float g2 = vgetq_lane_f32(p2, 1) * 63.0f + 0.5f;
                float b2 = vgetq_lane_f32(p2, 2) * 31.0f + 0.5f;
                float r3 = vgetq_lane_f32(p3, 0) * 31.0f + 0.5f;
                float g3 = vgetq_lane_f32(p3, 1) * 63.0f + 0.5f;
                float b3 = vgetq_lane_f32(p3, 2) * 31.0f + 0.5f;

                dst[tx + 0] = ((uint16_t)r0 << 11) | ((uint16_t)g0 << 5) | (uint16_t)b0;
                dst[tx + 1] = ((uint16_t)r1 << 11) | ((uint16_t)g1 << 5) | (uint16_t)b1;
                dst[tx + 2] = ((uint16_t)r2 << 11) | ((uint16_t)g2 << 5) | (uint16_t)b2;
                dst[tx + 3] = ((uint16_t)r3 << 11) | ((uint16_t)g3 << 5) | (uint16_t)b3;

                src += 16;
            }
#else
            for (int tx = 0; tx < TILE_W; tx++) {
                float r = src[0], g = src[1], b = src[2];
                if (r > 1.0f) r = 1.0f; if (r < 0.0f) r = 0.0f;
                if (g > 1.0f) g = 1.0f; if (g < 0.0f) g = 0.0f;
                if (b > 1.0f) b = 1.0f; if (b < 0.0f) b = 0.0f;

                uint16_t r5 = (uint16_t)(r * 31.0f + 0.5f);
                uint16_t g6 = (uint16_t)(g * 63.0f + 0.5f);
                uint16_t b5 = (uint16_t)(b * 31.0f + 0.5f);
                dst[tx] = (r5 << 11) | (g6 << 5) | b5;
                src += 4;
            }
#endif
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

        s2->sx = cam->fx * cx * iz + cam->cx;
        s2->sy = cam->fy * cy * iz + cam->cy;
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
        s2->cov2d_inv[0] =  cc * inv_det;
        s2->cov2d_inv[1] = -cb * inv_det;
        s2->cov2d_inv[2] =  ca * inv_det;

        /* Bounding box (3-sigma) */
        float rx = 3.0f * sqrtf(ca);
        float ry = 3.0f * sqrtf(cc);

        s2->bbox_x0 = (int16_t)fmaxf(0, s2->sx - rx);
        s2->bbox_y0 = (int16_t)fmaxf(0, s2->sy - ry);
        s2->bbox_x1 = (int16_t)fminf(screen_w - 1, s2->sx + rx);
        s2->bbox_y1 = (int16_t)fminf(screen_h - 1, s2->sy + ry);

        /* Pre-convert color to float for blending */
        s2->rf = s3->r / 255.0f;
        s2->gf = s3->g / 255.0f;
        s2->bf = s3->b / 255.0f;
        s2->opacity = s3->alpha / 255.0f;
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

/* Rasterize a single splat into the current tile buffer */
static inline void rasterize_splat_tile(
    float *tile_buf,
    const splat_2d_t *s,
    int tile_px, int tile_py)  /* pixel origin of this tile */
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

    float inv_a = s->cov2d_inv[0];
    float inv_b = s->cov2d_inv[1];
    float inv_c = s->cov2d_inv[2];
    float sr = s->rf;
    float sg = s->gf;
    float sb = s->bf;
    float sa = s->opacity;
    float splat_sx = s->sx;
    float splat_sy = s->sy;

    for (int ty = y0; ty <= y1; ty++) {
        float dy = (tile_py + ty) + 0.5f - splat_sy;
        float dy_b = inv_b * dy;
        float dy2_c = inv_c * dy * dy;

        float *row = &tile_buf[ty * TILE_W * 4];

#ifdef __ARM_NEON
        /* Process 4 pixels at a time */
        /* Preload dx base values */
        float dx_base = (tile_px + x0) + 0.5f - splat_sx;

        int tx = x0;
        for (; tx + 3 <= x1; tx += 4) {
            float32x4_t vdx = {
                dx_base,
                dx_base + 1.0f,
                dx_base + 2.0f,
                dx_base + 3.0f
            };
            dx_base += 4.0f;

            /* d² = a*dx² + 2*b*dx*dy + c*dy² */
            float32x4_t va   = vdupq_n_f32(inv_a);
            float32x4_t vdy_b2 = vdupq_n_f32(2.0f * dy_b);
            float32x4_t vdy2c = vdupq_n_f32(dy2_c);

            float32x4_t d2 = vmlaq_f32(
                vmlaq_f32(vdy2c, vdy_b2, vdx),
                va, vmulq_f32(vdx, vdx));

            /* Evaluate Gaussian via LUT for each lane */
            float d2_arr[4];
            vst1q_f32(d2_arr, d2);

            for (int k = 0; k < 4; k++) {
                if (d2_arr[k] >= 9.0f) continue;

                float gauss = fast_gauss(d2_arr[k]);
                float w = gauss * sa;
                if (w < (1.0f / 255.0f)) continue;

                float omw = 1.0f - w;
                float *px = &row[(tx + k) * 4];
                px[0] = sr * w + px[0] * omw;
                px[1] = sg * w + px[1] * omw;
                px[2] = sb * w + px[2] * omw;
                px[3] = w + px[3] * omw;
            }
        }

        /* Remaining pixels */
        for (; tx <= x1; tx++) {
            float dx = (tile_px + tx) + 0.5f - splat_sx;
            float d2 = inv_a * dx * dx + 2.0f * dx * dy_b + dy2_c;
            if (d2 >= 9.0f) continue;

            float w = fast_gauss(d2) * sa;
            if (w < (1.0f / 255.0f)) continue;

            float omw = 1.0f - w;
            float *px = &row[tx * 4];
            px[0] = sr * w + px[0] * omw;
            px[1] = sg * w + px[1] * omw;
            px[2] = sb * w + px[2] * omw;
            px[3] = w + px[3] * omw;
        }
#else
        /* Scalar path */
        for (int tx = x0; tx <= x1; tx++) {
            float dx = (tile_px + tx) + 0.5f - splat_sx;
            float d2 = inv_a * dx * dx + 2.0f * dx * dy_b + dy2_c;
            if (d2 >= 9.0f) continue;

            float w = fast_gauss(d2) * sa;
            if (w < (1.0f / 255.0f)) continue;

            float omw = 1.0f - w;
            float *px = &row[tx * 4];
            px[0] = sr * w + px[0] * omw;
            px[1] = sg * w + px[1] * omw;
            px[2] = sb * w + px[2] * omw;
            px[3] = w + px[3] * omw;
        }
#endif
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
