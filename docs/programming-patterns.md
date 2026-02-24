<\!-- Derived from: txt/AB004-141021-PORTEX.txt,txt/AB005-220623-DELAY.txt,txt/AB006-171108-BRIDGE.txt,txt/AN011-130608-GANGLIA1.txt,txt/AN016-141111-DCMOTOR.txt,txt/WP002-100405-energycons.txt -->
# F18A / GA144 Programming Patterns

Common programming patterns and idioms used in GA144 applications, extracted from tutorials, application notes, and example code.

## Inter-Node Communication

### Sending Data to a Neighbor

Point register A at the target port, then use `!` to send:

```
up a!       \ A points to up port (0x115)
data !      \ Send 'data' to up neighbor (blocks until neighbor reads)
```

### Receiving Data from a Neighbor

```
down a!     \ A points to down port (0x135)
@           \ Read from down neighbor (blocks until data available)
```

### Port Execution (Remote Control)

One of the most powerful GA144 patterns. A node can send instruction words to a neighbor for the neighbor to execute directly. After reset, most nodes are in a three-port jump, waiting to receive an instruction word:

```
\ Node 500 sends instructions to node 600 (up neighbor)
up a!                   \ Point A at up port
@p ! ..                 \ Send the next word through the port
@p !b ..                \ This IS the instruction: 600 will execute "@p !b .."
30000 !                 \ Send the literal 0x30000; 600 stores it in its B target
```

How this works:
1. Node 500 writes the instruction word `@p !b ..` to the up port
2. Node 600 (blocking on three-port jump) receives it into its instruction register
3. Node 600 executes `@p` — which reads the next word from the port (because P points to the port)
4. Node 500 sends `0x30000` through the port
5. Node 600 executes `!b` — storing the value into its B register
6. Node 600 executes `..` (nops) and goes back to waiting

### Remote Register Initialization

A common pattern to initialize a neighbor's B register to point to io:

```
up a!
@p ! ..     \ Send instruction word to neighbor
@p b! ..    \ Instruction: "@p b! .." — neighbor will execute this
io !        \ Send the literal value of io (0x15D) — neighbor stores in B
```

After this sequence, the neighbor's B register points to its io register, allowing it to respond to `!b` commands to control its pins.

### Data Relay (Wire Nodes)

Nodes between a source and destination act as data relays:

```
\ Wire node: relay all data from left to right
left a!     \ A points to left port
right b!    \ B points to right port
begin
  @ !b      \ Read from left, write to right
end         \ Loop forever
```

### Streaming Data Through a Pipeline

```
\ Node chain: 100 → 101 → 102 → 103
\ Each node reads from left, processes, writes to right

right a!    \ Output to right
left b!     \ Input from left
begin
  @b        \ Read from left neighbor
  \ ... process data ...
  !         \ Write to right neighbor
end
```

## Loop Constructs

### `for` ... `next` — Counted Loop

```
100 for
  \ ... loop body (executes 101 times: 100 down to 0) ...
next
```

The count is pushed to the return stack. `next` decrements R and jumps back if R ≠ 0.

### `for` ... `unext` — Tight Micro Loop

```
200000 for . . unext ;
```

`unext` re-executes the current instruction word without refetching from memory. The loop body must fit in slots 0–2 of one word. Each iteration takes ~1.5 ns.

Used primarily for **timing delays**:
- 200,000 iterations × ~5 ns = ~1 ms
- Chain multiple levels: `ms` calls `1ms` in a `for..next` loop

### `begin` ... `end` — Infinite Loop

```
begin
  hi wait lo wait   \ Toggle LED forever
end
```

Compiles an unconditional jump back to `begin`. No exit condition.

### `begin` ... `while` ... `end` — Conditional Loop

```
begin
  @ dup               \ Read and duplicate
  0x1FFFF and         \ Mask to check condition
while
  \ ... process while condition true ...
end
```

## Stack Manipulation Idioms

### Create Zero

```
dup dup or      \ T XOR T = 0 (since `or` is actually XOR)
```

Alternative:
```
dup xor         \ Same effect — T XOR T = 0
```

### Initialize A to Zero

```
dup dup or a!   \ A = 0
```

### Negate (Two's Complement)

```
- 1 . +         \ Invert bits, then add 1
```

Or in EAM mode (after `+cy`):
```
-               \ Invert bits
1 . +           \ Add 1 with carry handling
```

### Swap T and S

There is no dedicated swap instruction. Common pattern:

```
push over pop   \ >r over r> — swaps T and S using return stack
```

Or the shorter (but tricky):
```
over push       \ Save S copy on R
over            \ Now T=S, but need old T
\ ... this pattern requires careful stack management
```

## Timing and Delay

### Approximate 1 ms Delay

```
: 1ms  200000 for . . unext ;
```

Each `unext` iteration with two nops takes ~5 ns. 200,000 × 5 ns ≈ 1 ms.

### N Millisecond Delay

```
: ms  for 1ms next ;       \ Delay for approximately (n) milliseconds
: wait  200 ms ;            \ ~200 ms delay (visible to humans)
```

### Timing Estimation

- 1 nop: ~1.5 ns
- 1 `unext` iteration (2 nops + decrement): ~5 ns
- Instruction word (4 slots): ~6 ns
- 200,000 unext iterations: ~1 ms
- 1,000 × 1ms calls: ~1 second

## Pin Control Patterns

### Set Pin High

```
io b!       \ B → io register (usually already set from reset)
30000 !b    \ Write 0x30000 to io — pin 17 high
```

### Set Pin Low

```
20000 !b    \ Write 0x20000 to io — pin 17 driven low
```

### Toggle Pin

```
: hi  30000 !b ;
: lo  20000 !b ;
: blink  hi wait lo wait ;
```

### Set Pin to Input (High-Z)

```
dup dup or !b   \ Write 0x00000 to io — all pins high-Z
```

## Memory-Efficient Factoring

### Shared Subroutines

Factor out common code into subroutines called by multiple words:

```
: pin!  @p ! ! ;    \ Send instruction word and literal to neighbor
  @p !b ..          \ The instruction word (compiled as literal)

: hi  30000 pin! ;  \ Set pin high via neighbor
: lo  20000 pin! ;  \ Set pin low via neighbor
```

This saves RAM by sharing the port-execution mechanism between `hi` and `lo`.

### Literal Parameters

Pass values on the stack rather than compiling separate words:

```
: pin!  @p ! ! ;    \ n -- : send instruction word then n to port
  @p !b ..
: hi  30000 pin! ;  \ Uses same subroutine with different literal
: lo  20000 pin! ;
```

Total: 7 words of RAM instead of 10 for separate hi/lo implementations.

## 32-bit Arithmetic on 18-bit Architecture

### Partner Node Pattern (from MD5 implementation)

Split 32-bit values into high 16 bits and low 16 bits across two adjacent nodes:

```
\ Low word node (row 100)      High word node (row 200)
\ Handles bits 0-15            Handles bits 16-31
\ Accumulates carry in         Receives carry from low node
\ bits 16-17                   Adds carry to result
```

### 32-bit Addition

1. Low node adds low 16 bits, accumulates carry in bits 16–17
2. After up to 3 additions, low node sends carry to high node
3. High node adds high 16 bits plus carry
4. Both nodes independently handle the bitwise operations (AND, XOR, etc.)

### 32-bit Rotation

1. Both nodes shift their 16-bit halves
2. Nodes swap their T values (send shifted bits to each other)
3. OR the received bits into position
4. Mask with 0xFFFF to keep only 16 bits

## Data Flow Programming

### Node Cluster Design

GA144 applications are designed as data flow diagrams:

1. **Identify operations**: Break the algorithm into independent operations
2. **Assign to nodes**: Each operation gets a dedicated node (or cluster)
3. **Route data**: Connect nodes via their communication ports
4. **Design the pipeline**: Data flows from input nodes through processing nodes to output nodes

### Node Roles

- **Compute nodes**: Perform arithmetic/logic operations
- **Wire nodes**: Relay data between non-adjacent nodes
- **Storage nodes**: Hold constants or lookup tables in RAM/ROM
- **I/O nodes**: Interface with external pins
- **Control nodes**: Coordinate timing and sequencing

### Example: MD5 Block Diagram

```
Input → 102 → 103 → 104 (message buffer, low)
         ↕      ↕      ↕
Input → 202 → 203 → 204 (message buffer, high)
                ↕      ↕
        105 → 106 → 107 (constants + compute, low)
         ↕      ↕      ↕
        205 → 206 → 207 (constants + compute, high)
```

12 nodes total, arranged in 2 rows for partner-node carry/rotation coordination.

## Self-Modifying Code

### Computed Goto

```
: jump  push ;      \ Pop T, push to R, then return pops R to P
                    \ Effectively: jump to address in T
```

### Dynamic Instruction Dispatch

The Snorkel pattern (from AN010): load arbitrary instruction streams from external SRAM and execute them:

```
\ Read instruction word from SRAM, execute it
@ ex                \ Fetch from memory, swap P and R (execute the word)
```

## Common Initialization Sequence

```
: start
  up a!             \ Point A at up port (for neighbor communication)
  @p ..             \ Send instruction word to neighbor:
  @p b! ..          \ Instruction: set neighbor's B register
  ! io              \ Send io address to neighbor
  dup dup or        \ Create zero
  !b                \ Clear local io register
  io b!             \ Point B at io register
;
```

This sequence:
1. Prepares A for upward communication
2. Initializes the neighbor's B register to point to its io register
3. Clears the local I/O pins to high-Z
4. Points local B to the io register for convenient access

## References

- [AB004 - Port Execution Communication](txt/AB004-141021-PORTEX.txt) — Inter-node communication via port execution
- [AB005 - Delay Lines/Buffers](txt/AB005-220623-DELAY.txt) — FIFO buffer implementation using port execution across nodes
- [AB006 - Transparent Port Bridge](txt/AB006-171108-BRIDGE.txt) — Two-chip connection via port bridging
- [AN016 - PID Motor Controller](txt/AN016-141111-DCMOTOR.txt) — Multi-node coordination pattern with PID feedback loop
- [AN011 - Ganglia Mark 1](txt/AN011-130608-GANGLIA1.txt) — Dynamic message routing patterns across the chip
- [WP002 - Energy Conservation](txt/WP002-100405-energycons.txt) — Power management patterns and sleep/wake strategies
