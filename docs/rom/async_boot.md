# Async Serial Boot ROM (node 708)

ROM type: `async_boot`
Representative node: 708
ROM address range: 0x80 - 0xBF (64 words, mirrored at 0xC0-0xFF)

## Symbols

| Symbol | Address | Physical ROM offset |
|--------|---------|-------------------|
| relay | 0xa1 | 0x21 |
| warm | 0xa9 | 0x29 |
| cold | 0xaa | 0x2a |
| ser-exec | 0xae | 0x2e |
| ser-copy | 0xb3 | 0x33 |
| wait | 0xbb | 0x3b |
| sync | 0xbe | 0x3e |
| start | 0xc5 | 0x85 (mirror: 0xc5 - 0x40 = 0x85) |
| delay | 0xc8 | 0x88 (mirror: 0xc8 - 0x40 = 0x88) |
| 18ibits | 0xcb | 0x8b (mirror: 0xcb - 0x40 = 0x8b) |
| byte | 0xd0 | 0x90 (mirror: 0xd0 - 0x40 = 0x90) |
| 4bits | 0xd2 | 0x92 (mirror: 0xd2 - 0x40 = 0x92) |
| 2bits | 0xd3 | 0x93 (mirror: 0xd3 - 0x40 = 0x93) |
| 1bit | 0xd4 | 0x94 (mirror: 0xd4 - 0x40 = 0x94) |
| lsh | 0xd9 | 0x99 (mirror: 0xd9 - 0x40 = 0x99) |
| rsh | 0xdb | 0x9b (mirror: 0xdb - 0x40 = 0x9b) |

Note: ROM addresses 0xC0-0xFF mirror 0x80-0xBF. Functions like `18ibits` at
address 0xCB physically reside at ROM offset 0x8B (= 0xCB - 0x40).

## Reference Source (block 1424)

From `reference/ga144/ref/OkadBack.txt`:

```forth
( block 1424 - async serial boot top/bot )
( 0xcf ) org 0xcb : 18ibits              ; Note: 0xCB mirrors to physical 0x8B
 org 0xa1
( 0xa1 ) 1388 load                        ; relay (shared routine from block 1388)
( 0xa9 ) : warm await ;
: cold ( 0xaa ) 0x31a5 ( 'rdlu) a! @ @b .. -if
: ser-exec ( 0xae ) ( x-d) 18ibits drop push .
  18ibits drop a! . 18ibits
: ser-copy ( 0xb3 ) ( xnx-d) drop push zif ;
  then begin 18ibits drop !+ next ;
  then drop 0x1b5 ( 'rdl-) push push ;
: wait ( 0xbb ) ( x-1/1) begin . drop @b -until . drop ;
: sync ( 0xbe ) ( x-3/2-d) dup dup wait or - push
  begin @b . -if . drop *next await ;
  then . drop pop - 2/ ;
: start ( 0xc5 ) ( dw-4/2-dw,io)
  dup wait over dup 2/ . + push
: delay ( 0xc8 ) ( -1/1-io)
  begin @b . -if then . drop next @b ;

( 0xcb ) 1426 load ( 18ibits - bit reception routines )
( 0xd9 ) 1392 load ( lsh rsh )
```

## Annotated Disassembly

```
  ; ---- unnamed (block 1426: 18ibits/byte/4bits/2bits/1bit/lsh/rsh) ----
  ; These routines are at 0x80-0xA0 but accessed via mirror addresses 0xC0-0xE0
  ;
  ; 18ibits (0xcb → mirror 0x8b): receives 18 bits from async serial
  ;   sync sync dup start leap(2bits) leap
  [0x80]  0x0096b  @b | . | -if(0x3)           ; part of sync/start/delay subroutines
  [0x81]  0x2c278  . | drop | next(0x0)
  [0x82]  0x115b5  jump(0x1b5)
  [0x83]  0x2c29a  . | drop | pop | !b
  [0x84]  0x32755  - | 2/ | ;
  [0x85]  0x256bb  dup | call(0xbb)             ; start (0xc5 → 0x85): dup wait
  [0x86]  0x20dc2  over | dup | 2/ | !b         ;   over dup 2/ !b
  [0x87]  0x3c8b2  + | push | . | !b            ;   + push
  [0x88]  0x00969  @b | . | -if(0x1)            ; delay (0xc8 → 0x88): begin @b . -if
  [0x89]  0x2c278  . | drop | next(0x0)         ;   then . drop next
  [0x8a]  0x01555  @b | ;                       ;   @b ;
  [0x8b]  0x134be  call(0xbe)                   ; 18ibits (0xcb → 0x8b): call sync
  [0x8c]  0x134be  call(0xbe)                   ;   call sync
  [0x8d]  0x256c5  dup | call(0xc5)             ;   dup call start
  [0x8e]  0x134d3  call(0xd3)                   ;   leap → call 2bits
  [0x8f]  0x134d0  call(0xd0)                   ;   leap → call byte
  [0x90]  0x3b6c5  drop | call(0xc5)            ; byte (0xd0 → 0x90): drop call start
  [0x91]  0x134d2  call(0xd2)                   ;   leap → call 4bits
  [0x92]  0x134d3  call(0xd3)                   ; 4bits (0xd2 → 0x92): leap → call 2bits
  [0x93]  0x134d4  call(0xd4)                   ; 2bits (0xd3 → 0x93): leap → call 1bit
  [0x94]  0x2e79a  push | 2/ | pop | !b         ; 1bit (0xd4 → 0x94): push 2/ pop !b
  [0x95]  0x20312  over | or | @p | !b          ;   over or @p !b
  [0x96]  0x20000  (data: 131072)               ;   0x20000 (bit 17 mask)
  [0x97]  0x3e382  and | or | over | !b         ;   and or over !b
  [0x98]  0x2f7c8  push | jump(0xc8)            ;   push jump delay
  [0x99]  0x2e9b2  push | . | . | !b            ; lsh (0xd9 → 0x99): push . . !b
  [0x9a]  0x37155  2* | unext | ;               ;   2* unext ;
  [0x9b]  0x2e9b2  push | . | . | !b            ; rsh (0xdb → 0x9b): push . . !b
  [0x9c]  0x31155  2/ | unext | ;               ;   2/ unext ;
  [0x9d]  0x134a9  call(0xa9)                   ; padding: call warm (await)
  [0x9e]  0x134a9  call(0xa9)
  [0x9f]  0x134a9  call(0xa9)
  [0xa0]  0x134a9  call(0xa9)

  ; ---- relay (block 1388) ----
  ; Moves executable packets down node chain via B register port.
  ; Packet format: [address] [count-1] [word0] [word1] ...
  [0xa1]  0x26a1a  pop | a! | @+ | !b           ; relay: pop a! @+ !b  (set A, send addr)
  [0xa2]  0x2fc7c  push | @+ | next(0x4)        ;   push @+ next(done)  (send count, loop body)
  [0xa3]  0x3b7a8  drop | jump(0xa8)             ;   drop jump(done)  (count was 0, skip)
  [0xa4]  0x26fbf  pop | over | push | unext     ;   pop over push unext (inner loop)
  [0xa5]  0x236a1  a | call(0xa1)                ;   a call relay  (chain to next node)
  [0xa6]  0x09b22  !b | !b | !b | !b             ;   !b !b !b !b  (send 4 words)
  [0xa7]  0x07b72  @+ | !b | unext | !b          ;   @+ !b unext !b  (send remaining)
  [0xa8]  0x228ad  a | push | a! | ;              ;   a push a! ;  (save A, return)

  ; ---- warm ----
  ; Warm reset: jump to multiport read (suspend/await)
  [0xa9]  0x115b5  jump(0x1b5)                   ; warm: jump 0x1B5 (rdl- multiport read → suspend)

  ; ---- cold ----
  ; Cold boot entry point. Reads all ports (rdlu) to detect wake source.
  ; If pin17 HIGH (bit 17 set → T negative), skip to ser-exec.
  ; If pin17 LOW, jump to 0xB8 (drop into wait loop).
  [0xaa]  0x04a0a  @p | a! | @ | !b             ; cold: @p a! @ !b  → A=0x1A5 (rdlu), read [A], write IO
  [0xab]  0x031a5  (data: 12709)                 ;   literal 0x31A5 (A gets 0x1A5 = rdlu address)
  [0xac]  0x009b2  @b | . | . | !b              ;   @b . . !b  → read IO into T, write back to IO
  [0xad]  0x1b4b8  -if(0xb8)                     ;   -if(0xB8)  → if T bit17=0 (not negative), jump to 0xB8

  ; ---- ser-exec ----
  ; Reads boot frame: [address] [count] [data...]
  ; Called after cold boot detects serial data (pin17 active).
  [0xae]  0x134cb  call(0xcb)                   ; ser-exec: call 18ibits  (read address word)
  [0xaf]  0x3a8b2  drop | push | . | !b         ;   drop push . !b  (push address to R)
  [0xb0]  0x134cb  call(0xcb)                   ;   call 18ibits  (read count word)
  [0xb1]  0x3aab2  drop | a! | . | !b           ;   drop a! . !b  (A = address)
  [0xb2]  0x134cb  call(0xcb)                   ;   call 18ibits  (read first data word / or count for ser-copy)

  ; ---- ser-copy ----
  ; Receives N words at address A.
  ; If count=0, return (;). Otherwise loop: read word, store at A+, decrement count.
  [0xb3]  0x3a87d  drop | push | next(0x5)      ; ser-copy: drop push next(0xB4+1=0xB5) → loop if count>0
  [0xb4]  0x15555  ;                             ;   ; (return if count was 0 — "zif")
  [0xb5]  0x134cb  call(0xcb)                   ;   call 18ibits  (read data word)
  [0xb6]  0x3b87d  drop | !+ | next(0x5)        ;   drop !+ next(0xB5)  (store word, loop)
  [0xb7]  0x15555  ;                             ;   ; (return when done)

  ; This code is between ser-copy and wait; cold boot's -if(0xB8) jumps here.
  ; It sets up B=0x1B5 (rdl- port) and pushes onto R, then falls into wait.
  [0xb8]  0x3bdba  drop | @p | push | !b         ;   drop @p push !b  → load 0x1B5, push to R, write IO
  [0xb9]  0x001b5  (data: 437)                   ;   literal 0x1B5 (rdl- multiport address)
  [0xba]  0x2f555  push | ;                       ;   push ;  → push 0x1B5 to R, then return via ;

  ; ---- wait ----
  ; Polls IO register (via @b where B=IO) looking for negative value (bit 17 set).
  ; This is the pin17 serial idle/start-bit detection loop.
  [0xbb]  0x2c202  . | drop | @b | !b           ; wait: begin . drop @b !b
  [0xbc]  0x1b4bb  -if(0xbb)                     ;   -if(wait)  → loop back if T not negative
  [0xbd]  0x2c255  . | drop | ;                   ;   . drop ;  → return when T is negative (pin17 HIGH)

  ; ---- sync ----
  ; Synchronizes to async serial clock edge.
  ; Waits for pin17 transition, measures timing.
  [0xbe]  0x24d4b  dup | dup | call(0x3)         ; sync: dup dup call(0x3) → wait variant at addr 3
  [0xbf]  0x386ba  or | - | push | !b             ;   or - push !b
```

## Cold Boot Flow Analysis

On reset, P = 0xAA (cold boot entry). The execution flow:

1. **0xAA**: `@p a! @ !b` — Load literal 0x31A5 into A (truncated to 0x1A5 = rdlu
   multiport address). Read from `[A]` (all 4 ports). Write result to IO register
   via `!b` (B=0x15D at reset = IO port).

2. **0xAC**: `@b . . !b` — Read IO register back into T (via `@b` where B=0x15D),
   then write T back to IO. The `.` NOPs give time for IO to settle.

3. **0xAD**: `-if(0xB8)` — Check if T is negative (bit 17 set). On the F18A, `-if`
   jumps when T is NOT negative (bit 17 = 0). If pin17 was HIGH during the rdlu read,
   the IO register will have bit 17 set (via PIN17_BIT), making T negative, so `-if`
   falls through to ser-exec. If pin17 was LOW, T is not negative, so `-if` jumps
   to 0xB8.

4. **If serial detected (fall-through to 0xAE)**: Enter `ser-exec` which reads boot
   frames from the serial port via `18ibits`.

5. **If no serial (jump to 0xB8)**: Load 0x1B5 (rdl- address) into R and B, then
   fall into `wait` loop which polls IO for pin17 going HIGH (serial start bit).
