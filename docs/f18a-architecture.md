<\!-- Derived from: txt/DB001-171107-F18A.txt,txt/DB001-221113-F18A.txt,txt/PB001-100503-GA144-1-10.txt,txt/PB005-100501-F18B.txt -->
# F18A Core Architecture

The F18A is an 18-bit stack-based processor core. Each GA144 chip contains 144 instances of the F18A, connected in an 8×18 mesh grid.

## Registers

| Register | Width | Description |
|----------|-------|-------------|
| **P**    | 10 bits (+ P9 for EAM) | Program counter. Bits 7–0 address memory/IO. Bit 8 (P8) selects I/O space. Bit 9 (P9) enables Extended Arithmetic Mode. |
| **I**    | 18 bits | Instruction register. Holds current instruction word being executed. |
| **A**    | 18 bits | General-purpose address register. Used by `@`, `@+`, `!`, `!+`, `a`, `a!`. |
| **B**    | 9 bits (write-only) | Secondary address register. Used by `@b`, `!b`, `b!`. Only low 9 bits of T stored. Cannot be read directly. |
| **T**    | 18 bits | Top of data stack. |
| **S**    | 18 bits | Second element of data stack. |
| **R**    | 18 bits | Top of return stack. Used as loop counter by `next`/`unext`. |
| **io**   | 18 bits | I/O control/status register (address 0x15D). |

## Data Stack

The data stack has 10 elements total:
- **T** — top of stack (directly accessible)
- **S** — second element (directly accessible)
- **8-element circular buffer** — remaining elements

Stack operations:
- **Push**: S is pushed into the circular buffer, old T moves to S, new value goes into T
- **Pop/Drop**: S moves to T, top of circular buffer moves to S

The circular buffer wraps — pushing more than 8 values overwrites the oldest value silently (no overflow detection).

## Return Stack

The return stack has 9 elements total:
- **R** — top of return stack (directly accessible)
- **8-element circular buffer** — remaining elements

Used for:
- Subroutine return addresses (`call` pushes P to R, `;` pops R to P)
- Loop counters (`next`, `unext` decrement R)
- Temporary storage (`>r`, `r>`)

Same circular behavior as the data stack — no overflow detection.

## Memory Map

Each F18A node has a 10-bit address space (addresses 0x000–0x3FF):

| Address Range | Size | Description |
|---------------|------|-------------|
| 0x000–0x03F   | 64 words | **RAM** — Read/write. Program and data storage. |
| 0x040–0x07F   | 64 words | RAM mirror (same 64 words, address wraps) |
| 0x080–0x0BF   | 64 words | **ROM** — Read-only. Contains boot and utility code. |
| 0x0C0–0x0FF   | 64 words | ROM mirror (same 64 words, address wraps) |
| 0x100–0x1FF   | 256 addresses | **I/O space** — Communication ports, io register |

### RAM Details

- 64 × 18-bit words per node
- Shared between program code and data (no separation)
- Addressed by bits 5–0 of the address; bits 7–6 are ignored within RAM space
- P auto-increments within RAM but wraps at address boundaries

### ROM Details

- 64 × 18-bit words per node
- Contains boot code, utility routines, and ROM-specific programs
- Contents vary by node position and type (edge nodes have different ROM than interior nodes)
- Selected when address bit 7 is set

### I/O Space

Selected when P8 (address bit 8) is set. Contains:

| Address | Name | Description |
|---------|------|-------------|
| 0x115   | **up** | Port to neighbor above (y+1) |
| 0x135   | **down** | Port to neighbor below (y-1) |
| 0x141   | **right** | Port to neighbor to the right (x+1) |
| 0x171   | **left** | Port to neighbor to the left (x-1) |
| 0x15D   | **io** | I/O control and status register |

#### Multiport Addresses

Reading from a multiport address reads from whichever port has data available first:

| Address | Ports Combined |
|---------|---------------|
| 0x145   | right + up |
| 0x175   | left + up |
| 0x155   | right + left + up (three-port read) |
| 0x165   | right + left + up + down (four-port read) |

Additional combinations follow the same bit-pattern logic:
- Bit 0 (0x001): up port
- Bit 2 (0x004): right port
- Bit 4 (0x010): down port
- Bit 5 (0x020): left port

(These bits are within the port address encoding.)

## Communication Ports

Inter-node communication uses synchronous handshake (blocking):

- **Write to port**: Node blocks until the neighbor reads from the shared port
- **Read from port**: Node blocks until the neighbor writes to the shared port

This means:
- A write to `right` blocks until the right neighbor reads from its `left` port
- A read from `up` blocks until the upper neighbor writes to its `down` port
- No buffering — data transfers are synchronous and point-to-point

Both nodes must participate in a transfer simultaneously. If only one side is ready, it sleeps (very low power) until the other side completes the handshake.

## Address Increment Behavior

- P increments after `@p` and `!p`
- A increments after `@+` and `!+`
- B never increments
- P does **not** increment when pointing to I/O space (P8 set)
- Address wrapping:
  - RAM: wraps within 64-word boundary (bits 5–0)
  - ROM: wraps within 64-word boundary
  - I/O: P does not increment

## Reset State

On power-up or reset, each F18A core initializes to:

| Register | Reset Value | Notes |
|----------|-------------|-------|
| P        | 0x0AA (ROM) | Points to ROM boot code (varies by node) |
| I        | —           | First instruction fetched from P |
| A        | 0x000       | Points to start of RAM |
| B        | 0x15D (io)  | Points to io register |
| T, S     | 0x00000     | Data stack cleared |
| R        | 0x00000     | Return stack cleared |
| io       | 0x15555     | All I/O pins in default state |

### Boot ROM Behavior

After reset, most nodes execute a **three-port jump** from ROM: they read an instruction word from whichever port (up, left, down) first provides data. This means idle nodes simply wait for a neighbor to send them instructions.

Boot nodes (001, 200, 300, 701, 705, 708) have special ROM that implements their respective boot protocols (SERDES, 1-wire, 2-wire sync, SPI, async serial).

## Prefetch

The F18A prefetches the next instruction word while executing the current one:

- During execution of the current word, the next word at [P+1] is being read
- If the last instruction in a word modifies P (jump, call, return), the prefetched word is discarded
- If accessing I/O or ports in the last slot, prefetch timing may cause unexpected behavior
- The `unext` instruction avoids prefetch entirely — it re-executes the current word from slot 0 without fetching

### Prefetch Constraints

- Avoid placing `@p` (literal fetch) in slot 3 — the literal will be the prefetched word, not the intended one
- After a `;` (return), `jump`, `call`, or `next` that takes the branch, the prefetched word is discarded
- Memory-mapped I/O reads in the last slot may interact with prefetch timing

## References

- [DB001 - F18A Technology Reference (2017)](txt/DB001-171107-F18A.txt) — Comprehensive F18A processor documentation: registers, stacks, memory, instruction encoding
- [DB001 - F18A Technology Reference (2022)](txt/DB001-221113-F18A.txt) — Revised edition of the F18A reference
- [PB001 - GA144 Product Brief](txt/PB001-100503-GA144-1-10.txt) — GA144 chip overview including F18A core specifications
- [PB005 - F18B Computer](txt/PB005-100501-F18B.txt) — F18B evolutionary improvement over F18A architecture
