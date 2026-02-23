# arrayForth Compilation Model

This document describes how arrayForth compiles code for the GA144, which serves as the reference model for implementing a GA144 compiler.

## Source Code Organization

### Block-Based Source

arrayForth organizes source code in 1024-character blocks (numbered). Key blocks:

- **Block 1300**: Application setup (declares which blocks to load)
- **Block 1302**: Load list (contains `load` directives for source blocks)
- **Application blocks**: Contain the actual node programs

### Color Coding

arrayForth uses colors to distinguish token types:

| Color | Meaning | Compiler Action |
|-------|---------|----------------|
| **Red** | Definition (word name) | Creates a dictionary entry / label |
| **Green** | Compiled opcode | Packs into current instruction word |
| **Yellow** | Executed immediately | Interpreted at compile time |
| **Gray** | Comment | Ignored by compiler |
| **Dark green** (italic) | Hex literal | Compiled as hex number |

In practice, a compiler for GA144 needs to handle these semantics:
- Labels/definitions that mark addresses in the code
- Opcodes that get packed into instruction words
- Directives that execute at compile time
- Literals (decimal and hexadecimal)

## Compiler Directives

### `node` (n)

Declares that following code is for node number `n`. Switches the compiler's target node context.

```
500 node    \ Begin compiling for node 500
```

### `org` (address)

Sets the location counter to the specified address. Forces word alignment (flushes any partially-built instruction word).

```
0 org       \ Start compiling at address 0
```

### `,` (comma) — Compile Literal Data

Forces word alignment, then compiles the value on the stack as a literal data word at the current address. Advances the location counter.

```
30000 ,     \ Compile hex 0x30000 as data at current address
```

### `..` (pad with nops)

Pads the remaining slots in the current instruction word with nop (`.`) opcodes. Ensures the next opcode starts in a new instruction word at slot 0.

```
@p !b ..    \ Pack @p and !b, pad remaining slots with nop
```

This is critical when the next word needs to be a literal value (for `@p`), since the literal must be a separate word.

### `/` (force new word)

Similar to `..` but specifically forces the next opcode into slot 0 of the next instruction word. Used when alignment matters.

### `+cy` / `-cy`

Control Extended Arithmetic Mode:
- `+cy` — Sets P9 in the location counter (enables EAM for subsequent code)
- `-cy` — Clears P9 in the location counter (disables EAM)

Both force word alignment.

### `here`

Returns the current word-aligned location counter value. Useful for computing relative addresses.

### `#` (number/reference)

Instructs the assembler to leave a number, label address, or reference on the stack instead of assembling it. Used for stack calculations and forward reference construction.

## Instruction Packing

The core compiler job is packing opcodes into 18-bit instruction words. The compiler maintains:

- **Location counter** (`'CL`): Current word address being compiled
- **Instruction word** (`'IW`): The 18-bit word being built
- **Slot pointer** (`'SLOT`): Which slot (0–3) the next opcode goes into

### Packing Algorithm

```
1. For each opcode to compile:
   a. If it's a jump/call instruction:
      - It must occupy all remaining bits from the current slot onward
      - The address field fills the remaining lower bits
      - The word is complete — flush it
   b. If it's a regular opcode:
      - If current slot is 0–2: place 5-bit opcode at the slot position
      - If current slot is 3: place 3-bit opcode (only 8 opcodes valid here)
      - Advance slot pointer
   c. If the word is full (past slot 3):
      - Flush the current word (XOR with 0x15555, store at location counter)
      - Advance location counter
      - Start a new word at slot 0
```

### Jump/Call Address Encoding

When a jump, call, next, if, or -if instruction is placed in a slot:

| Slot | Opcode Bits | Address Bits | Address Range |
|------|-------------|--------------|---------------|
| 0    | bits 17–13  | bits 12–0    | Full range (with P9, P8 control) |
| 1    | bits 12–8   | bits 7–0     | 256 words, P8 forced to 0 |
| 2    | bits 7–3    | bits 2–0     | 8 words, P8 forced to 0 |
| 3    | —           | —            | No room for address — not useful |

For slot 0 jumps, bits 12–10 are unused by the F18A hardware and can be set arbitrarily (the assembler typically sets them to match the jump target for convenience).

### Word Flushing

When an instruction word is complete:
1. XOR the raw word with `0x15555` to encode it
2. Store at the current location counter address
3. Increment location counter

Any incomplete word must also be flushed when:
- A label/definition is encountered (word boundary required)
- `..` or `/` directive is used
- `org` or `,` is used
- End of compilation for a node

Unfilled slots are padded with `;` (return, opcode 0x00) by default, which acts as a no-op when execution falls through. Some compilers pad with `.` (nop, opcode 0x1C) instead.

## Labels and Definitions

A label (red word in arrayForth) creates a named entry at the current location:

1. Force word alignment (flush current word if partially built)
2. Record the current location counter as the label's address
3. Add to the dictionary for forward reference resolution

Labels are **word-aligned** — they always point to the start of an instruction word, never to a specific slot.

## Literal Compilation

To compile an inline literal value:

1. Compile `@p` (opcode 0x08) into the current slot
2. Pad remaining slots with nop (`..`)
3. Compile the literal value as the next full word

The compiled `@p` instruction tells the F18A to fetch the next word (at [P]) and push it onto the stack, then increment P past the literal.

Example: Compiling `30000` (hex) as a literal:
```
Instruction word: @p . . .    (opcode 0x08 in slot 0, nops in slots 1-3)
Literal word:     0x30000      (the actual value, XOR'd with 0x15555 for storage)
```

## Control Structures

### `for` ... `next`

- `for`: At runtime, pops T and pushes to R as loop count. At compile time, pads current word with nops so the loop body starts at a word boundary.
- `next`: Compiles a conditional jump back to the `for` address. If R ≠ 0, decrements R and jumps; if R = 0, pops R and continues.

### `for` ... `unext`

- Same as above, but `unext` loops within the current instruction word (slot 0 re-execution). The loop body must fit within slots 0–2 of one word. Extremely fast (~1.5 ns per iteration).

### `begin` ... `end`

- `begin`: Pads current word, records loop address.
- `end`: Compiles unconditional jump back to `begin` address. Creates infinite loop.

### `begin` ... `while` ... `end`

- `begin`: Records loop address.
- `while`: Compiles conditional jump (if T=0) past `end`.
- `end`: Compiles unconditional jump back to `begin`.

### `if` ... `then`

- `if`: Compiles conditional jump with unresolved forward reference.
- `then`: Resolves the forward reference to the current address.

## Forward References

When a jump/call target is not yet known (forward reference):

1. Compile the jump/call opcode with a placeholder address
2. Record the location and slot of the unresolved reference
3. When the target label is defined, patch the address into the stored word

The compiler must track:
- Which word contains the unresolved reference
- Which slot the jump opcode is in (determines address field size)
- The target label name

## Multi-Node Programs

A complete GA144 program declares code for multiple nodes:

```
500 node 0 org
  \ ... code for node 500 ...

600 node 0 org
  \ ... code for node 600 ...

708 node 0 org
  \ ... code for node 708 (boot node) ...
```

Each `node` directive switches the compiler's target, creating a separate code image for that node. The compiler maintains separate location counters and dictionaries per node.

### Cross-Node References

Labels defined in one node cannot be directly referenced from another node's code (they're in separate address spaces). Inter-node communication must be done through ports at runtime.

## Object Code Output

The compiler produces, for each node:

1. A block of compiled instruction words (XOR'd with 0x15555)
2. Starting address (from `org`)
3. Word count
4. Entry point address (if specified)

These are assembled into boot frames for the target boot protocol.

## Named Constants

The compiler pre-defines these named constants:

| Name  | Value  | Description |
|-------|--------|-------------|
| up    | 0x115  | Up port address |
| down  | 0x135  | Down port address |
| left  | 0x171  | Left port address |
| right | 0x141  | Right port address |
| io    | 0x15D  | io register address |

These are compiled as literals (using `@p` + literal word) when used in green (compiled) context.

## Compilation Example

Source (for node 500):
```
500 node 0 org
: hi  30000 !b ;
: lo  20000 !b ;
```

Compiles to:

**Word 0** (`hi` label, address 0x00):
```
Raw: @p    !b    ;     .
     01000 01110 00000 11100  = 0x08E1C
Encoded: 0x08E1C XOR 0x15555 = 0x1DB49
```

**Word 1** (literal for hi):
```
Raw: 0x30000
Encoded: 0x30000 XOR 0x15555 = 0x25555
```

**Word 2** (`lo` label, address 0x02):
```
Raw: @p    !b    ;     .
     01000 01110 00000 11100  = 0x08E1C
Encoded: same as word 0
```

**Word 3** (literal for lo):
```
Raw: 0x20000
Encoded: 0x20000 XOR 0x15555 = 0x35555
```

## References

- [DB004 - arrayForth User's Manual](../reference/greenarrays/pdfs/DB004-131030-aFUSER.txt) — Original arrayForth IDE: assembler, simulator, development environment
- [DB013 - arrayForth 3 User's Manual](../reference/greenarrays/pdfs/DB013-221112-aFUSER.txt) — Contemporary development system combining arrayForth with polyFORTH
- [DB005 - polyFORTH Reference Manual](../reference/greenarrays/pdfs/DB005-120825-PF-REF.txt) — polyFORTH virtual machine environment reference
- [DB006 - G144A12 polyFORTH Supplement](../reference/greenarrays/pdfs/DB006-221112-PF-G144A12.txt) — GA144-specific polyFORTH implementation details
- [dpans94 - ANS Forth Standard](../reference/greenarrays/pdfs/dpans94.txt) — ANSI X3.215-1994 Forth language standard
