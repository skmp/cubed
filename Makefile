# Gaussian Splat Renderer - MiSTer DE10-Nano
#
# Build natively ON the MiSTer:
#   make
#
# Cross-compile from desktop:
#   make CROSS=arm-linux-gnueabihf-
#
# Desktop (x86) test build (no NEON):
#   make desktop
#
# Run on MiSTer:
#   ./gsplat                    # 10K test splats, renders to /dev/fb0
#   ./gsplat -n 5000 -bench     # benchmark 5K splats
#   ./gsplat -s /dev/ttyS0      # GA144 input via HPS UART
#
# Run on desktop:
#   ./gsplat -n 5000 -ppm       # dumps PPM frames

CROSS  ?=
CC      = $(CROSS)gcc

# MiSTer / ARM flags
ARM_FLAGS = -mcpu=cortex-a9 -mfpu=neon -mfloat-abi=hard -mtune=cortex-a9
CFLAGS    = -O2 -Wall -Wextra -std=c99 -D_GNU_SOURCE $(ARM_FLAGS)
LDFLAGS   = -static -lm

TARGET = gsplat
SRCS   = gsplat.c main.c
OBJS   = $(SRCS:.c=.o)

all: $(TARGET)

# Desktop build (no ARM/NEON flags)
desktop: CFLAGS = -O2 -Wall -Wextra -std=c99 -D_GNU_SOURCE
desktop: clean $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

%.o: %.c gsplat.h
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(TARGET) $(OBJS) frame_*.ppm

test: desktop
	./$(TARGET) -n 5000 -frames 5 -ppm
	@ls -la frame_0000.ppm
	@echo "Check frame_*.ppm"

bench: desktop
	./$(TARGET) -n 1000 -bench
	./$(TARGET) -n 5000 -bench
	./$(TARGET) -n 10000 -bench
	./$(TARGET) -n 20000 -bench

.PHONY: all desktop clean test bench
