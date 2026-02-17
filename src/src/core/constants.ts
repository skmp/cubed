import { PortIndex } from './types';
export { PortIndex } from './types';

export const NUM_NODES = 144;
export const MEM_SIZE = 0x301; // 769

// 32 opcodes indexed by opcode number (0-31)
export const OPCODES: string[] = [
  ';', 'ex', 'jump', 'call', 'unext', 'next', 'if', '-if',
  '@p', '@+', '@b', '@', '!p', '!+', '!b', '!',
  '+*', '2*', '2/', '-', '+', 'and', 'or', 'drop',
  'dup', 'pop', 'over', 'a', '.', 'push', 'b!', 'a!',
];

export const OPCODE_MAP: Map<string, number> = new Map(
  OPCODES.map((name, index) => [name, index])
);

// Instructions that require an address field
export const ADDRESS_REQUIRED = new Set(['jump', 'call', 'next', 'if', '-if']);

// Instructions valid in slot 3 (3-bit encoding, value << 1 gives 5-bit opcode)
export const LAST_SLOT_INSTRUCTIONS = new Set([';', 'unext', '@p', '!p', '+*', '+', 'dup', '.']);

// Instructions that consume the rest of the word
export const INSTRUCTIONS_USING_REST_OF_WORD = new Set([';', 'ex']);

// Instructions preceded by nops
export const INSTRUCTIONS_PRECEDED_BY_NOPS = new Set(['+', '+*']);

// Port addresses (reference implementation convention)
export const PORT = {
  RIGHT: 0x1D5,
  DOWN:  0x115,
  LEFT:  0x175,
  UP:    0x145,
  IO:    0x15D,
  DATA:  0x141,
} as const;

// Named addresses for the assembler
export const NAMED_ADDRESSES: Record<string, number> = {
  right:  0x1D5,
  down:   0x115,
  left:   0x175,
  up:     0x145,
  io:     0x15D,
  ldata:  0x171,
  data:   0x141,
  warp:   0x157,
  center: 0x1A5,
  top:    0x1B5,
  side:   0x185,
  corner: 0x195,
};

// Multiport addresses mapped to their component port indices
export const MULTIPORT_ADDRESSES: Record<number, PortIndex[]> = {
  0x145: [PortIndex.UP],                                           // ---u
  0x175: [PortIndex.LEFT],                                         // --l-
  0x165: [PortIndex.LEFT, PortIndex.UP],                           // --lu
  0x115: [PortIndex.DOWN],                                         // -d--
  0x105: [PortIndex.DOWN, PortIndex.UP],                           // -d-u
  0x135: [PortIndex.DOWN, PortIndex.LEFT],                         // -dl-
  0x125: [PortIndex.DOWN, PortIndex.LEFT, PortIndex.UP],           // -dlu
  0x1D5: [PortIndex.RIGHT],                                       // r---
  0x1C5: [PortIndex.RIGHT, PortIndex.UP],                         // r--u
  0x1F5: [PortIndex.RIGHT, PortIndex.LEFT],                       // r-l-
  0x1E5: [PortIndex.RIGHT, PortIndex.LEFT, PortIndex.UP],         // r-lu
  0x195: [PortIndex.RIGHT, PortIndex.DOWN],                       // rd--
  0x185: [PortIndex.RIGHT, PortIndex.DOWN, PortIndex.UP],         // rd-u
  0x1B5: [PortIndex.RIGHT, PortIndex.DOWN, PortIndex.LEFT],       // rdl-
  0x1A5: [PortIndex.RIGHT, PortIndex.DOWN, PortIndex.LEFT, PortIndex.UP], // rdlu
};

// IO register bit positions
export const IO_BITS = {
  PIN17_BIT: 1 << 17,
  PIN5_BIT:  1 << 6,
  PIN3_BIT:  1 << 4,
  PIN1_BIT:  2,
  // Read status bits (clear = pending)
  Rr_MASK: 0x3FFFF & ~(1 << 16), // Right read
  Rw_BIT:  1 << 15,               // Right write
  Dr_MASK: 0x3FFFF & ~(1 << 14), // Down read
  Dw_BIT:  1 << 13,               // Down write
  Lr_MASK: 0x3FFFF & ~(1 << 12), // Left read
  Lw_BIT:  1 << 11,               // Left write
  Ur_MASK: 0x3FFFF & ~(1 << 10), // Up read
  Uw_BIT:  1 << 9,                // Up write
};

// Special node classifications
export const ANALOG_NODES = [709, 713, 717, 617, 117];
// DAC-capable nodes (can drive VGA output on EVB001)
export const DAC_NODES = [117, 617, 717];
export const SERDES_NODES = [1, 701];
export const BOOT_NODES = [1, 200, 300, 701, 705, 708];
export const SYNC_BOOT_NODES = [300];
export const ASYNC_BOOT_NODES = [708];
export const SPI_BOOT_NODES = [705];
export const ONE_WIRE_NODES = [200];

// Node to GPIO pin count
export const NODE_GPIO_PINS: Record<number, number> = {
  701: 2, 705: 4, 708: 2, 715: 1,
  517: 1, 417: 1, 317: 1, 217: 1,
  8: 4, 1: 2, 100: 1, 200: 1,
  300: 2, 500: 1, 600: 1,
};

// Convert node coordinate (YXX) to linear index (0-143)
export function coordToIndex(coord: number): number {
  return Math.floor(coord / 100) * 18 + (coord % 100);
}

// Convert linear index (0-143) to node coordinate (YXX)
export function indexToCoord(index: number): number {
  return Math.floor(index / 18) * 100 + (index % 18);
}

// Check if coordinate is valid
export function validCoord(coord: number): boolean {
  return coord >= 0 && (coord % 100) < 18 && Math.floor(coord / 100) < 8;
}

// Check if address is in I/O space
export function isPortAddr(addr: number): boolean {
  return (addr & 0x100) > 0;
}

// Resolve address to memory index, handling RAM/ROM mirroring
export function regionIndex(addr: number): number {
  if (isPortAddr(addr)) return addr;
  addr = addr & 0xFF;
  if (addr >= 0x80) {
    return addr > 0xBF ? addr - 0x40 : addr;
  }
  return addr > 0x3F ? addr - 0x40 : addr;
}

// Convert direction name to LUDR port index based on node coordinate
export function convertDirection(coord: number, dir: string): PortIndex {
  const x = coord % 100;
  const y = Math.floor(coord / 100);
  switch (dir) {
    case 'north': return y % 2 === 0 ? PortIndex.DOWN : PortIndex.UP;
    case 'south': return y % 2 === 0 ? PortIndex.UP : PortIndex.DOWN;
    case 'east':  return x % 2 === 0 ? PortIndex.RIGHT : PortIndex.LEFT;
    case 'west':  return x % 2 === 0 ? PortIndex.LEFT : PortIndex.RIGHT;
    default: throw new Error(`Invalid direction: ${dir}`);
  }
}

// Get port address for a given direction at a given node coordinate
export function getDirectionAddress(coord: number, dir: 'north' | 'east' | 'south' | 'west'): number {
  const dirNames: Record<string, string> = { north: 'north', east: 'east', south: 'south', west: 'west' };
  const ludr = convertDirection(coord, dirNames[dir]);
  const ludrToAddr: Record<number, number> = {
    [PortIndex.LEFT]: PORT.LEFT,
    [PortIndex.UP]: PORT.UP,
    [PortIndex.DOWN]: PORT.DOWN,
    [PortIndex.RIGHT]: PORT.RIGHT,
  };
  return ludrToAddr[ludr];
}
