> Sources: [DB001-221113-F18A](txt/DB001-221113-F18A.txt), [PB004-110412-F18A-IO](txt/PB004-110412-F18A-IO.txt), [PB006-100501-F18B-IO](txt/PB006-100501-F18B-IO.txt), [WP001-090805-noise](txt/WP001-090805-noise.txt)

# GA144 I/O Register & Pin Reference

## The `io` Register

Address: **0x15D**
Width: **18 bits**
Reset value: **0x15555**

The `io` register controls and reports the status of a node's I/O pins and communication ports. Its bit layout varies depending on the node type (GPIO, analog, SERDES, parallel bus).

## GPIO Nodes (Standard Edge Nodes)

Most edge nodes use the standard GPIO `io` register layout:

### Bit Layout

The WRITE and READ sides of the io register have different bit assignments:

```
Bit:    17  16  15  14  13  12  11  10   9   8   7   6   5   4   3   2   1   0
reset:   0   1   0   1   0   1   0   1   0   1   0   1   0   1   0   1   0   1
WRITE: [pin17 ctl]                  WD           ph9     ph7 [p5 ctl][p3 ctl][p1 ctl]
READ:  p17  Rr  Rw  Dr  Dw  Lr  Lw  Ur  Uw               p5      p3      p1
```

**WRITE side**: Pin drive control (2-bit fields), WD, phantom signals

**READ side**: Pin input state (single bits), port handshake status

### Port Handshake Status Bits (READ, bits 16–9)

| Bit | Name | Description |
|-|-|-|
| 16 | Rr- | Right port read handshake (0 = read pending) |
| 15 | Rw | Right port write handshake (1 = write pending) |
| 14 | Dr- | Down port read handshake (0 = read pending) |
| 13 | Dw | Down port write handshake (1 = write pending) |
| 12 | Lr- | Left port read handshake (0 = read pending) |
| 11 | Lw | Left port write handshake (1 = write pending) |
| 10 | Ur- | Up port read handshake (0 = read pending) |
| 9 | Uw | Up port write handshake (1 = write pending) |

### GPIO Pin Control Bits (WRITE)

Each GPIO pin is controlled by a 2-bit field:

| Value | Pin State |
|-|-|
| 00 | High-impedance (high-Z), input mode |
| 01 | Weak pulldown (~50kΩ to ground) |
| 10 | Drive low (strong output low) |
| 11 | Drive high (strong output high) |

GPIO pins are named by the bit position where their state is read:

- **Pin 17**: write control bits 17–16, read state bit 17
- **Pin 5**: write control bits 5–4, read state bit 5
- **Pin 3**: write control bits 3–2, read state bit 3
- **Pin 1**: write control bits 1–0, read state bit 1

Not all edge nodes have all 4 pin pairs. The exact pin availability depends on the node position and chip variant.

### Special Control Bits (WRITE)

| Bit | Name | Description |
|-|-|-|
| 11 | WD | Wake Disable — controls wakeup polarity for pin 17. 0 = wake on high (reset default), 1 = wake on low |
| 8 | phan 9 | Phantom wakeup signal for bit 9. 1 = signal high to receiver |
| 6 | phan 7 | Phantom wakeup signal for bit 7. 1 = signal high to receiver |

## Analog Nodes

Nodes with analog capabilities (617, 717, 417, 517, 117) have modified `io` register layouts:

### ADC (Analog to Digital Converter)

The GA144 ADC uses a **VCO-based design**:

1. Input voltage controls the frequency of a Voltage-Controlled Oscillator (VCO)
2. VCO output drives an 18-bit binary counter
3. Counter value represents the time-integral of input voltage
4. Software reads the counter at two times and computes the difference (modulo 2^18)

**Key characteristics:**
- VCO frequency: ~2 to ~4 GHz (voltage dependent)
- 18-bit counter rollover: ~65.5 to ~131 μs
- No sample-and-hold circuit needed
- Inherent moving-average anti-aliasing filter
- Input impedance: ~10 MΩ
- Input capacitance: ~2 pF

**Reading the ADC:**
1. Read counter value C1
2. Wait a measured interval Δt
3. Read counter value C2
4. Voltage ∝ (C2 - C1) mod 2^18 / Δt

The longer the interval, the higher the resolution but lower the sampling rate.

**ADC io register bits** include:
- Mode control bits for selecting ADC operation
- Counter read access

### DAC (Digital to Analog Converter)

- 9-bit resolution
- Available on nodes 617, 717, and 117
- DAC value set through specific bits in the `io` register

## Parallel Bus Nodes (007, 008, 009)

Nodes 007, 008, and 009 have special 18-bit parallel bus I/O:

- Full 18-bit data bus width
- Direction control (input/output per pin)
- Used for external SRAM interfaces and high-bandwidth I/O
- Bus direction configured through the `io` register

## SERDES Nodes (001, 701)

SERDES (Serializer/Deserializer) nodes have high-speed serial I/O:

- Support for high-speed serial boot
- Can communicate with external serial devices
- Used as boot nodes for serial loading

## Reading and Writing the `io` Register

### Reading

```
io b!       \ Point B to io register (address 0x15D)
@b          \ Read io register onto stack
```

Reading the `io` register returns the current state of all pins and handshake status bits. Pin output values reflect what was written; pin input values reflect the external voltage level.

### Writing

```
io b!       \ Point B to io register
30000 !b    \ Write 0x30000 — sets pin 17 high (bits 17:16 = 11)
20000 !b    \ Write 0x20000 — sets pin 17 low (bits 17:16 = 10)
```

Writing to the `io` register updates all pin states simultaneously. The handshake status bits (16–9 on READ) are read-only and not affected by writes.

### Important Notes

- At reset, `io` = 0x15555, and B points to 0x15D (the io register)
- The reset value 0x15555 puts all pins in the "weak pulldown" state (01 for each 2-bit field) and all handshake bits to 1 (idle)
- B is the most natural register for io access since it starts pointing there
- Using `dup dup or` (which produces zero) followed by `!b` sets all pins to high-Z input mode

## io Register as Compiler Constant

In arrayForth, `io` is a pre-defined constant that compiles to the literal value 0x15D. It is commonly used in initialization sequences:

```
io b!       \ After reset, B already points here, but explicit for clarity
```

The compiler should recognize `io` as a named constant with value `0x15D`.

## Port Addresses Summary Table

| Name | Address | Constant In arrayForth |
|------|---------|----------------------|
| up   | 0x115   | `up` |
| down | 0x135   | `down` |
| left | 0x171   | `left` |
| right| 0x141   | `right` |
| io   | 0x15D   | `io` |

These are used with `a!` to set the A register for port communication:

```
up a!       \ Point A to the up port
@           \ Read from up neighbor (blocks until data available)
right a!    \ Point A to the right port
!           \ Write T to right neighbor (blocks until neighbor reads)
```

## References

- [PB004 - F18A I/O Facilities](txt/PB004-110412-F18A-IO.txt) — Software-defined I/O, GPIO, analog I/O, SERDES, io control register
- [PB006 - F18B I/O Facilities](txt/PB006-100501-F18B-IO.txt) — F18B I/O enhancements: improved DAC, ADC multiplexor, pin wakeup
- [DB001 - F18A Technology Reference (2022)](txt/DB001-221113-F18A.txt) — I/O register bit fields and port handshake protocol
- [WP001 - Noise Reduction in ADC](txt/WP001-090805-noise.txt) — Analysis of VCO-based A/D converter noise filtering characteristics
