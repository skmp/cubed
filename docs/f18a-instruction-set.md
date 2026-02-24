> Sources: [DB001-171107-F18A](txt/DB001-171107-F18A.txt), [DB001-221113-F18A](txt/DB001-221113-F18A.txt), [PB001-100503-GA144-1-10](txt/PB001-100503-GA144-1-10.txt)

# F18A Instruction Set Reference

## Instruction Word Format

Each F18A instruction word is 18 bits wide, divided into 4 opcode slots:

```
 17 16 15 14 13 | 12 11 10 09 08 | 07 06 05 04 03 | 02 01 00
 [  Slot 0 (5)  ] [  Slot 1 (5)  ] [  Slot 2 (5)  ] [Slot3(3)]
```

- **Slot 0**: bits 17–13 (5 bits, all 32 opcodes valid)
- **Slot 1**: bits 12–8 (5 bits, all 32 opcodes valid)
- **Slot 2**: bits 7–3 (5 bits, all 32 opcodes valid)
- **Slot 3**: bits 2–0 (3 bits, only 8 opcodes valid)

When a jump/call instruction appears in a slot, all remaining bits in the word become the destination address field.

## Instruction Encoding

Instruction words stored in memory are XORed with `0x15555`:

```
encoded_word = raw_word XOR 0x15555
```

To decode: `raw_word = encoded_word XOR 0x15555`

The value `0x15555` corresponds to all slots filled with nop (opcode `0x1C` = `11100`), which means an "empty" instruction word in memory is all zeros after encoding.

## Complete Opcode Table

All 32 opcodes (5-bit encoding):

| Hex | Binary  | Mnemonic | arrayForth | Description | Stack Effect |
|-----|---------|----------|------------|-------------|--------------|
| 00  | 00000   | ret      | `;`        | Return (pop R into P) | R → P |
| 01  | 00001   | ex       | `ex`       | Execute (swap P and R) | P ↔ R |
| 02  | 00010   | jump     | `jump`/name | Unconditional jump | — |
| 03  | 00011   | call     | `call`/name | Call subroutine (push P to R) | P → R |
| 04  | 00100   | unext    | `unext`    | Micro-next (loop in slot 0, decrement R) | R-- or pop R |
| 05  | 00101   | next     | `next`     | Loop to address (decrement R, jump if R≠0) | R-- or pop R |
| 06  | 00110   | if       | `if`       | Jump if T=0 (pop T) | T → S, drop |
| 07  | 00111   | -if      | `-if`      | Jump if T≥0 (T bit 17 = 0, pop T) | T → S, drop |
| 08  | 01000   | @p       | `@p`       | Fetch literal (push T, read [P], P++) | push, T ← [P], P++ |
| 09  | 01001   | @+       | `@+`       | Fetch via A (push T, read [A], A++) | push, T ← [A], A++ |
| 0A  | 01010   | @b       | `@b`       | Fetch via B (push T, read [B]) | push, T ← [B] |
| 0B  | 01011   | @        | `@`        | Fetch via A (push T, read [A]) | push, T ← [A] |
| 0C  | 01100   | !p       | `!p`       | Store via P (write T to [P], P++, pop T) | [P] ← T, P++, drop |
| 0D  | 01101   | !+       | `!+`       | Store via A (write T to [A], A++, pop T) | [A] ← T, A++, drop |
| 0E  | 01110   | !b       | `!b`       | Store via B (write T to [B], pop T) | [B] ← T, drop |
| 0F  | 01111   | !        | `!`        | Store via A (write T to [A], pop T) | [A] ← T, drop |
| 10  | 10000   | +*       | `+*`       | Multiply step | see below |
| 11  | 10001   | 2*       | `2*`       | Left shift (T = T << 1) | T ← T << 1 |
| 12  | 10010   | 2/       | `2/`       | Right shift arithmetic (T = T >> 1, sign extend) | T ← T >> 1 |
| 13  | 10011   | -        | `inv`/`-`  | Invert all bits (~T) | T ← ~T |
| 14  | 10100   | +        | `+`        | Add (T = T + S, pop S) | T ← T + S, drop S |
| 15  | 10101   | and      | `and`      | Bitwise AND (T = T & S, pop S) | T ← T & S, drop S |
| 16  | 10110   | or       | `xor`/`or` | Bitwise XOR (T = T ^ S, pop S) | T ← T ^ S, drop S |
| 17  | 10111   | drop     | `drop`     | Drop T (T = S, pop S) | T ← S, drop S |
| 18  | 11000   | dup      | `dup`      | Duplicate T (push T) | push, S ← T |
| 19  | 11001   | pop      | `r>`       | Pop R to T (push T, T = R, pop R) | push, T ← R, pop R |
| 1A  | 11010   | over     | `over`     | Push S to T (push T, T = S) | push, T ← S |
| 1B  | 11011   | a        | `a`        | Read register A (push T, T = A) | push, T ← A |
| 1C  | 11100   | .        | `.` (nop)  | No operation | — |
| 1D  | 11101   | push     | `>r`       | Push T to R (R = T, pop T) | R ← T, push R, drop T |
| 1E  | 11110   | b!       | `b!`       | Store T into B register, pop T | B ← T[8:0], drop |
| 1F  | 11111   | a!       | `a!`       | Store T into A register, pop T | A ← T, drop |

## Slot 3 Valid Opcodes

Only 8 opcodes can be placed in slot 3 (3-bit encoding, using bits 2–0):

| Slot 3 Code | Full Opcode | Mnemonic | Description |
|-------------|-------------|----------|-------------|
| 0           | 0x00 (0)    | ret (`;`)  | Return |
| 1           | 0x04 (4)    | unext    | Micro-next loop |
| 2           | 0x08 (8)    | @p       | Fetch literal |
| 3           | 0x0C (12)   | !p       | Store via P |
| 4           | 0x10 (16)   | +*       | Multiply step |
| 5           | 0x14 (20)   | +        | Add |
| 6           | 0x18 (24)   | dup      | Duplicate T |
| 7           | 0x1C (28)   | .        | Nop |

The slot 3 encoding maps the 3-bit value to full opcode by: `opcode = slot3_value << 2` (i.e., every 4th opcode: 0, 4, 8, 12, 16, 20, 24, 28).

In practice, only `;` (return/nop padding), `unext`, `@p`, `!p`, `+`, and `dup` are commonly used in slot 3.

## Jump/Call Address Fields

When a jump, call, next, if, or -if instruction appears in a slot, all remaining lower bits become the destination address:

| Instruction Slot | Address Field Bits | Address Range |
|------------------|--------------------|---------------|
| Slot 0           | bits 12–0 (13 bits) | Full 10-bit address space + P9 + P8 |
| Slot 1           | bits 7–0 (8 bits)   | 256 words (within current page) |
| Slot 2           | bits 2–0 (3 bits)   | 8 words (very local) |
| Slot 3           | No address bits     | Jump/call not useful in slot 3 |

### Slot 0 Address Field Detail

```
Bits: 12 11 10 | 09 | 08 | 07 06 05 04 03 02 01 00
      [unused]   [P9] [P8] [        address        ]
```

- **Bits 12–10**: Can be set to any convenient value (ignored by hardware in F18A)
- **Bit 9 (P9)**: Controls Extended Arithmetic Mode (EAM)
- **Bit 8 (P8)**: Selects I/O address space when set
- **Bits 7–0**: Target address within selected space

### Slot 1 Address Field Detail

```
Bits: 07 06 05 04 03 02 01 00
      [        address        ]
```

- Forces P8 to zero (cannot address I/O space from slot 1)
- Does not affect P9 (EAM state preserved)

### Slot 2 Address Field Detail

```
Bits: 02 01 00
      [address]
```

- Forces P8 to zero
- Does not affect P9
- Very limited range (8 words)

## Extended Arithmetic Mode (EAM)

Enabled by setting bit P9 of the Program Counter (via a slot 0 jump/call):

- **+** (opcode 0x14): Becomes "add with carry" — includes latched carry in sum, latches carry out from bit 17
- **+*** (opcode 0x10): Multiply step behavior includes latched carry

The carry latch is set by the carry-out of bit 17 from the previous + or +* operation. This enables multi-word arithmetic (e.g., 32-bit addition on 18-bit words).

To enter EAM: Use a slot 0 call/jump with P9 bit set in the address field.
To exit EAM: Use a slot 0 call/jump with P9 bit clear.

The `-cy` and `+cy` assembler directives control EAM:
- `+cy` — enables EAM (sets P9)
- `-cy` — disables EAM (clears P9)

## Multiply Step (+*)

The `+*` instruction (opcode 0x10) implements one step of a shift-and-add multiplication:

- If A0 (bit 0 of A) is 1: T = T + S
- Shift T:A right one bit (T17 sign-extends, T0 shifts into A17)

A full 18×18 multiply requires 18 consecutive `+*` instructions. The result is in T (high word) and A (low word).

## Timing

- Most instructions execute in **1.5 ns** (approximately 700 MHz at 1.8V)
- Instructions within one word execute sequentially across slots
- A complete 4-slot instruction word executes in approximately **6 ns**
- Memory reads (`@p`, `@+`, `@`, `@b`) may incur additional time if accessing I/O ports (blocking until data available)
- `unext` loops execute the current instruction word repeatedly without refetching — very fast tight loops

### Prefetch Considerations

- The F18A prefetches the next instruction word during execution of the current word
- If the last slot contains a memory operation that changes the address (e.g., `@p` in slot 3), the prefetch may have already occurred with the old P value
- Slot 3 `+` (add) has special handling — the prefetch occurs during its execution

## Instruction Descriptions

### Control Flow

- **`;` (return)**: Pop return stack R into program counter P. Ends a subroutine.
- **`ex` (execute)**: Swap P and R. Used for coroutine-style control flow.
- **`jump`**: Unconditional jump to address in remaining bits.
- **`call`**: Push current P to R, then jump to address. Creates a subroutine call.
- **`unext`**: If R ≠ 0, decrement R and restart execution at slot 0 of the current word (no memory fetch). If R = 0, pop R and continue to next word. Creates extremely tight loops.
- **`next`**: If R ≠ 0, decrement R and jump to address. If R = 0, pop R and continue. Standard counted loop.
- **`if`**: If T = 0, jump to address. Drops T regardless. Conditional branch.
- **`-if`**: If T ≥ 0 (bit 17 = 0), jump to address. Drops T regardless. Tests sign bit.

### Memory Access

- **`@p` (fetch-P)**: Push T onto data stack, fetch word at [P] into T, increment P. Primary mechanism for inline literals.
- **`@+` (fetch-A-inc)**: Push T, fetch [A] into T, increment A. Sequential memory read.
- **`@b` (fetch-B)**: Push T, fetch [B] into T. B unchanged. Used for I/O reads.
- **`@` (fetch-A)**: Push T, fetch [A] into T. A unchanged.
- **`!p` (store-P)**: Store T to [P], increment P, drop T. Sequential memory write.
- **`!+` (store-A-inc)**: Store T to [A], increment A, drop T.
- **`!b` (store-B)**: Store T to [B], drop T. Used for I/O writes.
- **`!` (store-A)**: Store T to [A], drop T.

### Arithmetic & Logic

- **`+*` (multiply step)**: See Multiply Step section above.
- **`2*` (shift left)**: T = T << 1. Bit 0 becomes 0. Carry out from bit 17 is lost (unless in EAM).
- **`2/` (shift right)**: T = T >> 1. Arithmetic shift — bit 17 is preserved (sign extension).
- **`-` / `inv` (invert)**: T = ~T. Bitwise NOT of all 18 bits.
- **`+` (add)**: T = T + S, drop S. In EAM: T = T + S + carry, updates carry latch.
- **`and`**: T = T & S, drop S.
- **`xor` / `or`**: T = T ^ S, drop S. (Named `or` in some docs but is actually XOR.)

### Stack Operations

- **`drop`**: T = S, pop data stack (discard old T).
- **`dup`**: Push T (copy T into S, old S shifts down).
- **`over`**: Push S onto stack as new T. (T becomes S, old T becomes new T... effectively T ← S, push old T)
- **`r>` (pop)**: Push T onto data stack, T = R, pop return stack.
- **`>r` (push)**: Push T onto return stack as R, drop T from data stack.
- **`a`**: Push T, T = A. Read the A register value.
- **`b!`**: B = T[8:0], drop T. Store low 9 bits of T into B register.
- **`a!`**: A = T, drop T. Store full 18-bit T into A register.

### No Operation

- **`.` (nop)**: No operation. Used to pad instruction words.

## References

- [DB001 - F18A Technology Reference (2017)](txt/DB001-171107-F18A.txt) — Instruction set encoding, opcode table, slot restrictions, XOR encoding
- [DB001 - F18A Technology Reference (2022)](txt/DB001-221113-F18A.txt) — Revised edition with updated instruction details
- [PB001 - GA144 Product Brief](txt/PB001-100503-GA144-1-10.txt) — Instruction timing and performance specifications
