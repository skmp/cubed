> Sources: [g144poster.A1](txt/g144poster.A1.txt), [PB001-100503-GA144-1-10](txt/PB001-100503-GA144-1-10.txt), [PB004-110412-F18A-IO](txt/PB004-110412-F18A-IO.txt)

# GA144 Node Map & Chip Layout

## Overview

The GA144 contains 144 F18A processor cores arranged in an **8×18** rectangular grid. Each node connects to its immediate neighbors (up, down, left, right) via synchronous communication ports.

## Node Numbering

Nodes are numbered in a **YXX** format (3-digit coordinate system):

- **Y** (hundreds digit): Row, 0–7 (bottom to top)
- **XX** (tens and units): Column, 00–17 (left to right)

```
Row 7: 700 701 702 703 704 705 706 707 708 709 710 711 712 713 714 715 716 717
Row 6: 600 601 602 603 604 605 606 607 608 609 610 611 612 613 614 615 616 617
Row 5: 500 501 502 503 504 505 506 507 508 509 510 511 512 513 514 515 516 517
Row 4: 400 401 402 403 404 405 406 407 408 409 410 411 412 413 414 415 416 417
Row 3: 300 301 302 303 304 305 306 307 308 309 310 311 312 313 314 315 316 317
Row 2: 200 201 202 203 204 205 206 207 208 209 210 211 212 213 214 215 216 217
Row 1: 100 101 102 103 104 105 106 107 108 109 110 111 112 113 114 115 116 117
Row 0: 000 001 002 003 004 005 006 007 008 009 010 011 012 013 014 015 016 017
```

- Bottom-left: **000**
- Bottom-right: **017**
- Top-left: **700**
- Top-right: **717**

## Node Types

### Interior Nodes

Nodes not on the edge of the chip. They have 4 communication ports (up, down, left, right) and no external I/O pins. Most of the 144 nodes are interior nodes.

### Edge Nodes with GPIO

Nodes on the chip boundary have external I/O pins in addition to their communication ports:

- **Top edge** (row 7): Nodes 700–717 have pins on the top
- **Bottom edge** (row 0): Nodes 000–017 have pins on the bottom
- **Left edge** (column 00): Nodes 000, 100, 200, 300, 400, 500, 600, 700 have pins on the left
- **Right edge** (column 17): Nodes 017, 117, 217, 317, 417, 517, 617, 717 have pins on the right

Edge nodes that are **missing** a neighbor (because they're on the boundary) have GPIO capability on the corresponding pin instead.

### Corner Nodes

Corner nodes (000, 017, 700, 717) have two edges and can have GPIO on two sides.

### Special Node Types

#### Analog Nodes (with ADC/DAC)

Five nodes have analog capabilities:

| Node | Capabilities |
|------|-------------|
| 617  | ADC + DAC |
| 717  | ADC + DAC |
| 417  | ADC |
| 517  | ADC |
| 117  | DAC |

The ADC uses a VCO-based design with an 18-bit counter. The VCO frequency varies from ~2 to ~4 GHz based on input voltage. The DAC is 9-bit.

#### SERDES Nodes (High-Speed Serial)

| Node | Description |
|------|-------------|
| 001  | SERDES, boot node |
| 701  | SERDES, boot node |

SERDES nodes can communicate at very high speeds via serializer/deserializer hardware.

#### Parallel Bus Nodes

| Node | Description |
|------|-------------|
| 007  | 18-bit parallel bus |
| 008  | 18-bit parallel bus |
| 009  | 18-bit parallel bus |

These nodes have dedicated 18-bit wide parallel I/O bus support, useful for external memory interfaces.

#### Boot Nodes

Six nodes have boot ROM that enables them to load code from external sources:

| Node | Boot Protocol |
|------|--------------|
| 001  | SERDES |
| 701  | SERDES |
| 200  | 1-wire |
| 300  | 2-wire synchronous |
| 705  | SPI |
| 708  | Async serial (UART, 8N1) |

## Inter-Node Port Addresses

Each node accesses its neighbors through memory-mapped I/O ports:

| Port | Address | Direction | Connects To |
|------|---------|-----------|-------------|
| up   | 0x115   | Neighbor at Y+1 | Neighbor's `down` port |
| down | 0x135   | Neighbor at Y-1 | Neighbor's `up` port |
| right| 0x141   | Neighbor at X+1 | Neighbor's `left` port |
| left | 0x171   | Neighbor at X-1 | Neighbor's `right` port |
| io   | 0x15D   | I/O register | Local I/O control |

### Port Address Bit Encoding

The port addresses encode which ports to include:

```
Address bits: ... [left] [down] 0 [right] 0 [up]
                   bit 5  bit 4     bit 2     bit 0
```

This allows constructing multiport read addresses by OR-ing port bits:

| Address | Ports | Description |
|---------|-------|-------------|
| 0x115   | up    | Single port: up only |
| 0x135   | down  | Single port: down only |
| 0x141   | right | Single port: right only |
| 0x171   | left  | Single port: left only |
| 0x145   | right+up | Read from whichever has data first |
| 0x175   | left+up  | Read from whichever has data first |
| 0x155   | right+left+up | Three-port read |
| 0x165   | all four | Four-port read |
| 0x15D   | io    | I/O register (not a port) |

### Multiport Reads

Reading from a multiport address blocks until **any one** of the included ports has data available, then reads from that port. This is how boot ROM implements the three-port jump — the node waits for whichever neighbor sends data first.

Multiport writes are also possible: writing to a multiport address sends the same word to all included ports simultaneously. Both sides of each included port must complete their handshake.

## Communication Protocol

Inter-node communication is **synchronous** and **blocking**:

1. **Writer** attempts to write to a port → blocks until reader is ready
2. **Reader** attempts to read from a port → blocks until writer is ready
3. When both sides are ready, the 18-bit word transfers instantaneously
4. Both nodes resume execution

Key characteristics:
- No buffering — each transfer is exactly one 18-bit word
- No arbitration needed — deterministic handshake
- Very low power when blocked — node enters sleep state
- Transfer speed: ~1.5 ns (one clock cycle) once both sides are ready

### Port Execution

A powerful pattern is "port execution": a node can write instruction words into a neighbor's port. The neighbor, blocked on a read from that port, receives the word into its instruction register and executes it. This allows one node to remotely control another without the remote node needing any code in RAM.

## Neighbor Relationships

For a node at position (Y, XX):
- **Up neighbor**: (Y+1, XX) — if Y < 7
- **Down neighbor**: (Y-1, XX) — if Y > 0
- **Right neighbor**: (Y, XX+1) — if XX < 17
- **Left neighbor**: (Y, XX-1) — if XX > 0

Edge nodes missing a neighbor on one side have GPIO pins instead of that port. Reading/writing to a non-existent neighbor port accesses the external pin circuitry.

## 3D Visualization Mapping

In the CUBE 3D visualization, multi-node programs use the YXX coordinate to position
each node group on a grid matching the physical chip layout. The X axis maps to the
column (0-17), Y axis to the row (0-7), and Z axis represents code depth within each
node. See `docs/cube-language.md` section 12 for details.

## References

- [PB001 - GA144 Product Brief](txt/PB001-100503-GA144-1-10.txt) — GA144 chip overview: 8x18 array, node types, pinout, I/O capabilities
- [g144poster - GA144 Poster](txt/g144poster.A1.txt) — Visual pinout and node diagram for the GA144 chip
- [PB004 - F18A I/O Facilities](txt/PB004-110412-F18A-IO.txt) — Node I/O types: GPIO, analog, SERDES, parallel bus nodes
