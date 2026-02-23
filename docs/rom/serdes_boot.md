# SerDes Boot ROM (node 001)

ROM type: `serdes_boot`
Representative node: 1
ROM address range: 0x80 - 0xBF (64 words)

## Symbols

| Symbol | Address |
|--------|---------|
| relay | 0xa1 |
| warm | 0xa9 |
| cold | 0xaa |
| poly | 0xaa |
| *.17 | 0xb0 |
| *. | 0xb7 |
| taps | 0xbc |
| interp | 0xc4 |
| triangle | 0xce |
| clc | 0xd3 |
| --u/mod | 0x2d5 |
| -u/mod | 0x2d6 |

## Disassembly

```
  [0x80]  0x26aba  pop | a! | push | .
  [0x81]  0x0ecb0  !+ | pop | . | +
  [0x82]  0x270bd  pop | next(0xbd)
  [0x83]  0x02a55  @ | a! | ;
  [0x84]  0x248ba  dup | push | push | .
  [0x85]  0x209b2  over | . | . | .
  [0x86]  0x311aa  2/ | unext | a! | .
  [0x87]  0x3e81b  and | push | @+ | dup
  [0x88]  0x066b0  @+ | - | . | +
  [0x89]  0x32cab  - | pop | a! | dup
  [0x8a]  0x243b2  dup | or | . | .
  [0x8b]  0x351ba  +* | unext | push | .
  [0x8c]  0x3acb0  drop | pop | . | +
  [0x8d]  0x15555  ;
  [0x8e]  0x04f69  @p | over | -if(0x1)
  [0x8f]  0x10000  (data: 65536)
  [0x90]  0x3a9f5  drop | . | + | ;
  [0x91]  0x3a6b0  drop | - | . | +
  [0x92]  0x33555  - | ;
  [0x93]  0x24de3  dup | dup | or | dup
  [0x94]  0x2c1ed  . | + | drop | ;
  [0x95]  0x136d3  call(0x2d3)
  [0x96]  0x2bdba  a! | @p | push | .
  [0x97]  0x00011  (data: 17)
  [0x98]  0x249f2  dup | . | + | .
  [0x99]  0x2edb0  push | dup | . | +
  [0x9a]  0x24eb0  dup | a | . | +
  [0x9b]  0x1b6de  -if(0x2de)
  [0x9c]  0x3ac78  drop | pop | next(0x0)
  [0x9d]  0x249f5  dup | . | + | ;
  [0x9e]  0x203e2  over | or | or | .
  [0x9f]  0x270d8  pop | next(0xd8)
  [0xa0]  0x249f5  dup | . | + | ;

; ---- relay ----
  [0xa1]  0x26a1a  pop | a! | @+ | .
  [0xa2]  0x2fc7c  push | @+ | next(0x4)
  [0xa3]  0x3b7a8  drop | jump(0xa8)
  [0xa4]  0x26fbf  pop | over | push | @p
  [0xa5]  0x236a1  (data: 145057)
  [0xa6]  0x09b22  !b | !b | !b | .
  [0xa7]  0x07b72  @+ | !b | unext | .
  [0xa8]  0x228ad  a | push | a! | ;

; ---- warm ----
  [0xa9]  0x115b5  jump(0x1b5)

; ---- cold / poly ----
  [0xaa]  0x04a13  @p | a! | @p | dup
  [0xab]  0x03141  (data: 12609)
  [0xac]  0x3fffe  and | @b | and | !p
  [0xad]  0x0a9b2  ! | . | . | .
  [0xae]  0x135a5  call(0x1a5)
  [0xaf]  0x114aa  jump(0xaa)

; ---- *.17 ----
  [0xb0]  0x2bdbb  a! | @p | push | dup
  [0xb1]  0x00010  (data: 16)
  [0xb2]  0x243b2  dup | or | . | .
  [0xb3]  0x351c9  +* | unext | - | +*
  [0xb4]  0x232b6  a | -if(0xb6)
  [0xb5]  0x3a6dd  drop | - | 2* | ;
  [0xb6]  0x3a4cd  drop | 2* | - | ;

; ---- *. ----
  [0xb7]  0x134b0  call(0xb0)
  [0xb8]  0x2246b  a | 2* | -if(0x3)
  [0xb9]  0x3a6da  drop | - | 2* | .
  [0xba]  0x33555  - | ;
  [0xbb]  0x3a455  drop | 2* | ;

; ---- taps ----
  [0xbc]  0x26aba  pop | a! | push | .
  [0xbd]  0x07eba  @+ | @ | push | .
  [0xbe]  0x228b2  a | push | . | .
  [0xbf]  0x134b0  call(0xb0)
```

## References

- [BOOT-02 - Boot Protocols](../../reference/greenarrays/pdfs/BOOT-02.txt) — SERDES boot protocol specification
- [DB001 - F18A Technology Reference (2022)](../../reference/greenarrays/pdfs/DB001-221113-F18A.txt) — Nodes 001/701 ROM and SERDES boot behavior
- [PB004 - F18A I/O Facilities](../../reference/greenarrays/pdfs/PB004-110412-F18A-IO.txt) — SERDES I/O pin configuration and protocol
