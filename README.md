# gsplat - Gaussian Splat Renderer for MiSTer DE10-Nano

CPU-based Gaussian splat renderer targeting the MiSTer's ARM Cortex-A9.
Designed as Phase 1 toward FPGA-offloaded rendering, with data input
from a GA144 via SerDes.

## Quick start on MiSTer

```sh
# SSH in (default: root / 1)
ssh root@mister

# Install build tools (if not present)
apt-get update && apt-get install -y gcc make

# Or just scp the binary if cross-compiling:
# On desktop: make CROSS=arm-linux-gnueabihf-
# scp gsplat root@mister:/root/

# Build on MiSTer
make

# Run test (renders to /dev/fb0)
./gsplat -n 5000

# Benchmark
./gsplat -bench -n 5000
```

## Architecture

```
GA144 ──SerDes──> splat_store ──> project ──> sort ──> rasterize ──> /dev/fb0
         UART       (DDR3)       (CPU)      (CPU)    (CPU+NEON)     (mmap)
```

### Optimizations for A9

- **Tile-based rasterization**: 32x32 pixel tiles keep the blend buffer
  in L1 cache (16KB RGBA float) instead of thrashing DDR3
- **exp() LUT**: 1024-entry lookup table replaces libm expf() in the
  inner loop (~50 cycles -> ~5 cycles)
- **NEON**: Mahalanobis distance computed 4 pixels at a time
- **Radix sort**: 2-pass 8-bit radix sort on quantized depth, much
  faster than qsort for N > 5K

### GA144 Wire Protocol

18-bit word format over UART (3 bytes per word, 6 bits/byte):

| Field | Words | Format |
|-------|-------|--------|
| SYNC  | 1     | 0x3FFFF |
| COUNT | 1     | splat count |
| X,Y,Z | 3     | s1.16 signed fixed-point |
| COV[6] | 6    | u0.18 unsigned fixed-point |
| RGB   | 1     | R[17:12] G[11:6] B[5:0] (6-bit per channel) |
| ALPHA | 1     | low 8 bits |

Total: 11 words (33 bytes) per splat + 2 word header.

## MiSTer notes

- MiSTer's Linux is BusyBox-based. Use `/bin/sh` or `/usr/bin/bash`.
- `/dev/fb0` is typically configured by the MiSTer binary. When no
  FPGA core is running, the framebuffer should be available.
- HPS UART is on `/dev/ttyS0`. USB serial adapters show up as
  `/dev/ttyUSB0` or `/dev/ttyACM0`.
- The HPS GPIO header on the DE10-Nano can be used for higher-speed
  parallel or SPI connection to the GA144.
- `splat_store_t` is ~5.5MB. Total RAM usage is ~6-7MB for 50K splats.

## Phase 2: FPGA offload

The rasterizer is >95% of the frame time. To offload to FPGA:

1. CPU writes sorted, projected `splat_2d_t` array to DDR3
2. CPU triggers FPGA via lightweight H2F bridge register write
3. FPGA DMA reads splat descriptors from DDR3 (F2SDRAM bridge)
4. FPGA tile rasterizer evaluates Gaussians and blends
5. FPGA scans out framebuffer to HDMI

The tile_buf format is designed to map directly to FPGA BRAM.
