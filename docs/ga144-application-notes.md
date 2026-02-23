# GA144 Application Notes Summary

Summary of all application notes, briefs, white papers, and tutorials from GreenArrays documentation, organized by topic. Key takeaways for compiler implementors are highlighted.

## Tutorials

### TUT002 — Hello Neighbor
**Topic**: Inter-node communication basics
**Nodes**: 500, 600
**Demonstrates**: Toggling pin 600.17 from node 500 by sending instruction words through the up port. Shows port execution pattern: writing instruction words directly to a neighbor's port for remote execution. Factoring common code to save RAM (10 words → 7 words).

**Compiler relevance**: Instruction word construction at compile time, `@p` literal embedding, `..` padding directive.

### TUT003 — LED Blinkers
**Topic**: Timing, loops, IDE usage
**Nodes**: 500, 600
**Demonstrates**: `for..unext` tight loops for timing delays, `for..next` counted loops, `begin..end` infinite loops. Blinking LEDs at different rates. IDE-based interactive testing with `call` command.

**Compiler relevance**: `for`, `next`, `unext`, `begin`, `end` control structure compilation. Timing estimation (~5 ns per unext iteration).

## Cryptography

### AN001 / AP001 — MD5 Hash Implementation
**Topic**: 32-bit algorithm on 18-bit architecture
**Nodes**: 12 nodes in 2×6 layout (rows 100 and 200, columns 02–07)
**Demonstrates**: Partner node pattern for 32-bit arithmetic — low 16 bits in row 100, high 16 bits in row 200. Carry accumulation across node boundaries (up to 3 additions before carry transfer). 32-bit rotation via inter-node T-value swaps. Data flow diagram methodology. Distributing constants and code across multiple nodes (64-word RAM limit). Self-modifying code for algorithm step sequencing.

**Compiler relevance**: Multi-node program structure, data allocation across nodes, cross-node data flow patterns, extended arithmetic mode usage.

## Networking

### AN007 — 10BASE-T Ethernet
**Topic**: Software-defined Ethernet PHY
**Nodes**: Pipeline of F18 nodes for receiver/decoder
**Demonstrates**: Bit-banging 10 Mbit/s Ethernet. Manchester decoder in 10 words (180 bits total). Line receiver nodes, packet buffering, broadcast detection, UDP/IP stack integration.

**Compiler relevance**: Timing-critical code where instruction placement matters. Very tight code (10-word programs).

### AB002 — Ethernet Receiver (ETH-RX)
**Topic**: Software-defined 10BASE-T receiver detail
**Demonstrates**: IO register monitoring for link pulses. Manchester decoding pipeline. FLP autonegotiation burst handling. No RAM modification during operation (pure register/stack computation).

## Memory & Storage

### AN003 — SRAM Control Cluster
**Topic**: External SRAM interface
**Nodes**: 4–5 node cluster
**Demonstrates**: Address bus control across multiple nodes. Data line multiplexing. Read/write timing coordination. Memory-efficient control logic factoring.

### AN010 — Snorkel (Memory Mastering)
**Topic**: High-speed external memory access
**Nodes**: Dedicated SRAM master (e.g., node 207)
**Demonstrates**: DMA-like transfers between external SRAM and internal nodes. Stimulus-based triggering. Dynamic instruction dispatch from memory. Full 64-word Snorkel program. Arbitrary bit-width transfers (16-bit, 18-bit). SPI flash I/O integration.

**Compiler relevance**: Dynamic code loading patterns, instruction word construction for port execution.

### AB005 — Delay Line Buffer
**Topic**: Multi-node data buffering
**Nodes**: 30 nodes
**Demonstrates**: 1920-word delay line using pipelined nodes. Constant instruction words on stack. Inter-node word movement via COM ports. Word insertion at entrance, extraction at exit.

### AB007 — Flash Update (UPDFLASH)
**Topic**: Flash memory programming
**Demonstrates**: Serial disk boot mechanism. Flash programming procedures. Recovery for bricked boards.

## Peripherals & Sensors

### AN008 — Accelerometer (ACCEL)
**Topic**: SPI sensor interface
**Nodes**: GPIO/IO edge nodes
**Demonstrates**: SPI communication from polyFORTH. GPIO pin control for sensor interaction. Binary-to-data conversion.

### AN009 — PS/2 Keyboard (KEYBRD)
**Topic**: Serial peripheral interface
**Demonstrates**: PS/2 protocol implementation. Key scanning and debouncing. Serial protocol handling.

### AN012 — Sensor Tag (SENSORTAG)
**Topic**: Multi-sensor integration
**Demonstrates**: I2C/SPI coordination for temperature, humidity, pressure, accelerometer sensors. Low-power battery operation. Data fusion from multiple sensors.

### AN016 — DC Motor Control (DCMOTOR)
**Topic**: PWM and PID control
**Demonstrates**: PWM generator implementation across nodes. Timer nodes. PID control loop with closed-loop sensor feedback. Multi-node state machine.

**Compiler relevance**: Timing-critical control loops, real-time constraint patterns.

### AN005 — SCHMART Board Interface
**Topic**: Hardware peripheral interface
**Demonstrates**: Peripheral interfacing patterns.

## Video & Display

### AN018 — HDMI Receiver (ADV7611)
**Topic**: Video input processing
**Demonstrates**: Controlling Analog Devices ADV7611 HDMI receiver IC. I2C configuration. Video signal processing.

### AN020 — 1080p Video (1080P)
**Topic**: High-resolution video generation
**Demonstrates**: 1080p LED video sign generation. Video distribution system architecture. High-resolution pixel data streaming. Frame buffering and synchronization.

## System Architecture

### AN011 — Ganglia (Dynamic Message Routing)
**Topic**: Non-adjacent node communication
**Demonstrates**: Dynamic message routing between non-adjacent nodes. Static vs. dynamic data routing. Ganglion transaction propagation. Source routing headers. Multi-node message processing.

**Compiler relevance**: Message frame processing patterns, header manipulation, runtime routing decisions.

### AN017 — Ganglia 2 (Message Frame Routing)
**Topic**: Extended message routing
**Demonstrates**: Message frames with headers. Source routing information. Path crossing rules. Focusing call instruction dispatch.

### AB004 — Port Execution (PORTEX)
**Topic**: Remote code execution
**Nodes**: 608–609 pair example
**Demonstrates**: Using neighbor memory via port execution. Stack transfer through shared ports. @next loop patterns across neighboring nodes. Instruction word encoding for remote execution.

**Compiler relevance**: Yellow and green word color encoding for port dispatch. How instruction words should be constructed for remote execution.

### AB006 — Multi-Chip Bridge (BRIDGE)
**Topic**: Inter-chip communication
**Nodes**: 300, 400, 500
**Demonstrates**: Transparent port bridge between two GA144 chips. Sync boot mechanism. Cross-chip node addressing. Bridge code propagation.

## Timing & Measurement

### AN002 — Oscillator (OSC)
**Topic**: Clock generation
**Demonstrates**: Timing generation and clock management patterns.

### AB003 — Current Measurement (EVBCURR)
**Topic**: Power monitoring
**Demonstrates**: Measuring current consumption across 50+ nodes. Average power < 500 μA per node. Jumper-based measurement circuit.

## Evaluation Boards

### AN004 — Getting Started with EVB001
**Topic**: Development setup
**Demonstrates**: Initial connection, checkout, and use of EVB001 evaluation board.

### AN021 — Getting Started with EVB002
**Topic**: Development setup
**Demonstrates**: EVB002 board configuration, setup, and initial use.

## White Papers

### WP001 — Noise Reduction by ADC
**Topic**: Analog design
**Demonstrates**: VCO-based ADC inherent anti-aliasing. Moving average filter equivalent. Explains why external anti-aliasing filters may be unnecessary. At 1 KHz sampling: noise at 1 KHz attenuated 9 dB, at 10 KHz: 29 dB, at 100 KHz: 49 dB.

### WP002 — Energy Consumption
**Topic**: Power efficiency
**Demonstrates**: Individual node power control. Picosecond-level power gating per core. Energy integral optimization.

---

## Key Takeaways for Compiler Implementation

### Recurring Patterns to Support

1. **Port execution** — Constructing instruction words as data and sending them through ports. The compiler should make it easy to embed instruction words as literals.

2. **Multi-node programs** — Every non-trivial application uses multiple nodes. The compiler must handle per-node code generation with separate address spaces.

3. **64-word RAM constraint** — Code and data share 64 words per node. The compiler should report code size per node and warn when approaching the limit.

4. **Tight loops** — `for..unext` loops are used everywhere for timing. The compiler must ensure loop bodies fit within one instruction word.

5. **Instruction word alignment** — Many patterns require knowing exact word boundaries (for `@p` literals, `begin` targets, `for` loop starts).

6. **Partner node coordination** — 32-bit operations split across two nodes require careful coordination. The compiler should support paired node programming.

7. **Wire nodes** — Many applications need simple relay code. Consider providing built-in wire node code generation.

8. **Boot stream generation** — The compiler must produce boot streams, not just object code. This includes path routing from boot node to each target node.

### What the Compiler Must Get Right

- **Instruction word packing**: Correctly filling 4 slots per word
- **Slot 3 restrictions**: Only 8 opcodes valid in the 3-bit slot
- **XOR encoding**: All stored words XOR'd with 0x15555
- **Jump address fields**: Correctly sized per slot position
- **Literal placement**: `@p` must be followed by the literal in the next word
- **EAM management**: Track P9 state for extended arithmetic
- **Forward reference resolution**: Patch jump targets after label definition
- **Code size tracking**: 64-word hard limit per node

## References

- [AN001 - Implementing MD5 on GA144](../reference/greenarrays/pdfs/AN001-141023-MD5.txt) — MD5 hash using multi-node F18A clusters
- [AN002 - Simple Oscillators](../reference/greenarrays/pdfs/AN002-171106-OSC.txt) — External timing references and clock generation
- [AN003 - SRAM Control Cluster](../reference/greenarrays/pdfs/AN003-110810-SRAM.txt) — Four-node SRAM controller for external memory
- [AN005 - SchmartBoard Usage](../reference/greenarrays/pdfs/AN005-110926-SCHMART.txt) — Prototyping with QFN-88 carrier for GA144
- [AN007 - 10baseT Bit-Banged NIC](../reference/greenarrays/pdfs/AN007-141112-10BASET.txt) — 26-node software Ethernet controller
- [AN008 - 3-axis Accelerometer](../reference/greenarrays/pdfs/AN008-120510-ACCEL.txt) — Sensor integration with polyFORTH
- [AN009 - PS/2 Keyboard](../reference/greenarrays/pdfs/AN009-120912-KEYBRD.txt) — PS/2 keyboard interface implementation
- [AN010 - Snorkel Mark 1](../reference/greenarrays/pdfs/AN010-130604-SNORKEL1.txt) — Programmable DMA channel from SRAM
- [AN011 - Ganglia Mark 1](../reference/greenarrays/pdfs/AN011-130608-GANGLIA1.txt) — Dynamic message routing surface
- [AN012 - TI SensorTag Control](../reference/greenarrays/pdfs/AN012-130606-SENSORTAG.txt) — BLE and I2C sensor integration
- [AN016 - PID Motor Controller](../reference/greenarrays/pdfs/AN016-141111-DCMOTOR.txt) — DC motor speed control with PID feedback
- [AN017 - Ganglia Mark 2](../reference/greenarrays/pdfs/AN017-170105-GANGLIA2.txt) — Enhanced message routing with multi-chip support
- [AN018 - ADV7611 HDMI Receiver](../reference/greenarrays/pdfs/AN018-171105-ADV7611.txt) — HDMI video input with I2C bus mastering
- [AN020 - 1080p Video Distribution](../reference/greenarrays/pdfs/AN020-171106-1080P.txt) — Large-scale LED signage architecture
- [AN021 - Getting Started with EVB002](../reference/greenarrays/pdfs/AN021-220819-GS-EVB002.txt) — EVB002 quick-start guide
- [AB002 - Ethernet Line Receiver](../reference/greenarrays/pdfs/AB002-120108-ETH-RX.txt) — Manchester decoder for 10baseT input
- [AB003 - Measuring Currents on EVB001](../reference/greenarrays/pdfs/AB003-121018-EVBCURR.txt) — Power measurement techniques
- [AB004 - Port Execution Communication](../reference/greenarrays/pdfs/AB004-141021-PORTEX.txt) — Inter-node port execution demonstration
- [AB005 - Delay Lines/Buffers](../reference/greenarrays/pdfs/AB005-220623-DELAY.txt) — FIFO buffer via port execution
- [AB006 - Transparent Port Bridge](../reference/greenarrays/pdfs/AB006-171108-BRIDGE.txt) — Two-chip COM port bridge
- [WP001 - Noise Reduction in ADC](../reference/greenarrays/pdfs/WP001-090805-noise.txt) — VCO-based A/D converter noise analysis
- [WP002 - Energy Conservation](../reference/greenarrays/pdfs/WP002-100405-energycons.txt) — Fine-grained power control mechanisms
