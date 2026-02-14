/**
 * ROM function auto-detection for GA144 nodes.
 * Determines the ROM type based on node coordinates and exposes
 * available ROM functions as callable symbols.
 */
import { ROM_SYMBOLS } from '../rom-data';
import { ANALOG_NODES, SERDES_NODES, SYNC_BOOT_NODES, ASYNC_BOOT_NODES, SPI_BOOT_NODES, ONE_WIRE_NODES } from '../constants';

export type RomType = 'basic' | 'analog' | 'serdes_boot' | 'sync_boot' | 'async_boot' | 'spi_boot' | 'one_wire';

// Map raw ROM symbol names to clean identifiers for use as rom.xxx
const SYMBOL_RENAMES: Record<string, string> = {
  '*.': 'multiply',
  '*.17': 'multiply17',
  '-dac': 'dac',
  '--u/mod': 'divmod2',
  '-u/mod': 'divmod',
  '6in': 'sixIn',
  '2in': 'twoIn',
  'ser-exec': 'serExec',
  'ser-copy': 'serCopy',
  '18ibits': 'ibits18',
  '8obits': 'obits8',
  '4bits': 'fourBits',
  '2bits': 'twoBits',
  '1bit': 'oneBit',
  'spi-boot': 'spiBoot',
  'spi-exec': 'spiExec',
  'spi-copy': 'spiCopy',
};

export function getRomType(coord: number): RomType {
  if (ANALOG_NODES.includes(coord)) return 'analog';
  if (SERDES_NODES.includes(coord)) return 'serdes_boot';
  if (SYNC_BOOT_NODES.includes(coord)) return 'sync_boot';
  if (ASYNC_BOOT_NODES.includes(coord)) return 'async_boot';
  if (SPI_BOOT_NODES.includes(coord)) return 'spi_boot';
  if (ONE_WIRE_NODES.includes(coord)) return 'one_wire';
  return 'basic';
}

/** Get ROM functions available on a node, keyed by clean identifier (e.g. "multiply" not "*.") */
export function getRomFunctions(coord: number): Record<string, number> {
  const romType = getRomType(coord);
  const rawSymbols = ROM_SYMBOLS[romType] ?? {};
  const result: Record<string, number> = {};
  for (const [rawName, addr] of Object.entries(rawSymbols)) {
    const cleanName = SYMBOL_RENAMES[rawName] ?? rawName;
    result[cleanName] = addr;
  }
  return result;
}

/** Get all possible ROM function names (across all ROM types) */
export function getAllRomFunctionNames(): string[] {
  const names = new Set<string>();
  for (const symbols of Object.values(ROM_SYMBOLS)) {
    for (const rawName of Object.keys(symbols)) {
      names.add(SYMBOL_RENAMES[rawName] ?? rawName);
    }
  }
  return [...names];
}
