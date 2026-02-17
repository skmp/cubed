# VGA Profiling Guide

This guide describes how to profile VGA rendering performance in CUBED.

## Recommended Scenarios

- 640x480 output with HSYNC/VSYNC
- High-frequency IO writes (stress test)
- Long-running sessions to watch memory behavior

## Chrome Performance Capture

1. Run the app with a VGA sample (for example, Blue Rectangle).
2. Open DevTools and switch to the Performance panel.
3. Click Record, let it run for 5–10 seconds, then stop.
4. Inspect Main thread time, GPU raster time, and frame rate.

## Memory Check

1. Open DevTools and switch to the Memory panel.
2. Take a heap snapshot at start.
3. Let the emulator run for a few minutes.
4. Take another snapshot and compare retained sizes.

## What To Record

Record the sample name, output resolution, average FPS, and peak memory.
If frame rate dips occur, capture a short Performance trace and note the timestamp.
