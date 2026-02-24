<\!-- Derived from: txt/AN021-220819-GS-EVB002.txt,txt/BOOT-02.txt,txt/DB001-221113-F18A.txt,txt/DB014-190520-EVB002.txt -->
# GA144 Boot Process

## Overview

On power-up or reset, each F18A node begins executing its ROM code. Most nodes execute a **three-port jump** that blocks waiting for an instruction word from any neighbor. The six **boot nodes** have special ROM that loads code from an external source and then propagates it to other nodes.

## Boot Nodes

| Node | Protocol | External Interface |
|------|----------|--------------------|
| 001  | SERDES   | High-speed serial (differential pair) |
| 701  | SERDES   | High-speed serial (differential pair) |
| 200  | 1-wire   | Single-pin bidirectional |
| 300  | 2-wire sync | Clock + data (synchronous) |
| 705  | SPI      | SPI bus (CLK, MOSI, MISO, CS) |
| 708  | Async serial | UART (8N1, auto-baud detection) |

## Reset Behavior

### All Non-Boot Nodes

After reset, most nodes:
1. Set P to their ROM entry point
2. Execute a three-port jump: read an instruction word from whichever neighbor port (up, left, down — typically) first provides data
3. Execute the received instruction word
4. Continue waiting for more instruction words

This means idle nodes consume near-zero power, sleeping until a neighbor sends them code.

### Boot Nodes

Boot nodes have specialized ROM that:
1. Initialize their external I/O interface
2. Wait for incoming data on the external medium
3. Receive 18-bit words from the external source
4. Store received words in RAM and/or forward them to neighbors
5. Begin executing the loaded code

## Boot Frame Format

A boot frame is a sequence of 18-bit words that defines the code to load into a node:

```
[address] [count] [word0] [word1] ... [wordN-1]
```

- **address**: Starting RAM address (0x00–0x3F for the 64-word RAM)
- **count**: Number of words to load (0 means "call address 0" — start execution)
- **words**: The actual data/code words to store

A boot stream consists of one or more boot frames. The stream ends when a frame with count=0 is received, which causes the boot node to begin executing code at the specified address.

## Boot Protocols

### Async Serial (Node 708)

The most commonly used boot protocol for development:

- **Format**: 8N1 (8 data bits, no parity, 1 stop bit)
- **Auto-baud**: The boot ROM measures the first incoming byte to determine baud rate
- **Encoding**: Each 18-bit word is transmitted as 3 bytes (6+6+6 bits, low bits first)
  - Byte 1: bits 5–0
  - Byte 2: bits 11–6
  - Byte 3: bits 17–12

The auto-baud detection works by timing the start bit of the first byte received.

### SPI (Node 705)

- **Interface**: Standard SPI (clock, MOSI, MISO, chip select)
- **Boot ROM**: Reads from an external SPI flash memory
- **Validity check**: The boot ROM verifies the first word read is valid before proceeding
- **Flash addressing**: Can jump to arbitrary SPI flash addresses by loading a short program into RAM and executing it

### 1-Wire (Node 200)

- Single pin for bidirectional communication
- Boot ROM toggles the pin for synchronization
- Relatively slow but minimal wiring

### 2-Wire Synchronous (Node 300)

- Clock + data pins
- Synchronous protocol driven by external clock
- More reliable than 1-wire for noisy environments

### SERDES (Nodes 001, 701)

- High-speed differential serial
- Used for chip-to-chip communication
- Very fast boot capability

## Boot Stream Construction

To program the GA144, you construct a boot stream that:

1. **Loads code into the boot node** — The first frames in the stream go to the boot node's RAM
2. **The boot node code loads neighbor nodes** — The boot node executes code that writes instruction words to its neighbors' ports
3. **Chain propagation** — Each loaded node can in turn load its own neighbors

### Node Initialization Chain

A typical boot sequence for a multi-node application:

1. External source sends boot stream to boot node (e.g., 708 via serial)
2. Boot node receives frames and stores code in its RAM
3. Boot node begins execution (frame with count=0)
4. Boot node code writes to neighbor ports to initialize adjacent nodes
5. Those nodes write to their neighbors, and so on
6. Eventually all required nodes are loaded and running

### Building a Boot Stream from Compiled Code

The compiler produces object code (compiled instruction words) for each node. The boot stream builder:

1. Determines which boot node to use
2. Constructs the chain from boot node to each target node
3. Generates the boot frames for each node in topological order (boot node first, then its neighbors, etc.)
4. Encodes the frames in the appropriate protocol format

### Wire Nodes

Nodes along the path from boot node to target that don't run application code serve as "wire nodes" — they simply relay data from one port to another. The boot code sets these up with a simple relay loop:

```
\ Wire node: relay data from left to right
left a!     \ A points to left port
right b!    \ B points to right port
begin @b !+ again   \ or similar relay pattern
```

## Practical Boot Example

Loading code into node 500 via async serial boot at node 708:

1. Serial stream arrives at node 708
2. 708's boot ROM loads its own RAM with relay code
3. 708 forwards data to its neighbors along a path to 500
4. Path: 708 → 608 → 508 → 500 (or similar route depending on application)
5. Each intermediate node acts as a wire, relaying data
6. Node 500 receives its application code

## IDE Boot vs. Production Boot

### IDE Mode (Development)

- Uses arrayForth's `compile serial load talk panel` sequence
- Loads code interactively through the serial port
- Allows interactive testing via the IDE panel
- `hook` and `boot` commands target specific nodes

### Production Boot

- Boot stream burned into external flash memory
- SPI flash at node 705 or serial EEPROM at other boot nodes
- Chip boots autonomously on power-up
- No host computer needed after programming

## Key Boot Constants

| Constant | Value | Description |
|----------|-------|-------------|
| io reset | 0x15555 | All pins weak pulldown, ports idle |
| RAM size | 64 words | Maximum code per node per boot frame |
| ROM entry | 0x0AA (typical) | Boot ROM start address (varies by node) |

## References

- [BOOT-02 - Boot Protocols](txt/BOOT-02.txt) — Specification of SPI Flash, 2-wire sync, 1-wire, and UART boot protocols with frame structure and timing
- [DB001 - F18A Technology Reference (2022)](txt/DB001-221113-F18A.txt) — Boot ROM entry points and node-specific boot behavior
- [AN021 - Getting Started with EVB002 (2022)](txt/AN021-220819-GS-EVB002.txt) — Practical boot setup and jumper configuration for EVB002
- [DB014 - EVB002 Evaluation Board Reference](txt/DB014-190520-EVB002.txt) — EVB002 hardware boot interfaces and dual-chip configuration
