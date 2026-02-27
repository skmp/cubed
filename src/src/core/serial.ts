export type SerialBit = { value: boolean; durationNS: number };

export class SerialBits {
  /**
   * Build an RS232-encoded bit sequence for the given bytes.
   * RS232 polarity: idle = LOW, start bit = HIGH, data bits inverted, stop = LOW.
   *
   * @param bytes   Raw bytes to transmit
   * @param baud    Baud rate in Hz
   * @param idleS   Lead-in idle duration in seconds (default 0)
   */
  static buildBits(bytes: number[], baud: number, idleS: number = 0): SerialBit[] {
    const bits: SerialBit[] = [];
    const bitNS = 1e9 / baud;

    const push = (value: boolean, durationNS: number) => {
      if (bits.length > 0 && bits[bits.length - 1].value === value) {
        bits[bits.length - 1].durationNS += durationNS;
      } else {
        bits.push({ value, durationNS });
      }
    };

    if (idleS > 0) push(false, idleS * 1e9);

    for (const byte of bytes) {
      push(true, bitNS);                                         // start bit: HIGH
      for (let bit = 0; bit < 8; bit++) {
        push(((byte >> bit) & 1) === 0, bitNS);                  // data bits inverted, LSB first
      }
      push(false, bitNS);                                        // stop bit: LOW
    }

    push(false, bitNS * 2);                                      // trailing idle
    return bits;
  }

  /**
   * Build boot stream bits with a lead-in idle for auto-baud detection.
   * Defaults to 10 bit-periods of idle.
   */
  static bootStreamBits(bytes: number[], baud: number, idleS?: number): SerialBit[] {
    return SerialBits.buildBits(bytes, baud, idleS ?? 10 / baud);
  }

  /**
   * Decode an RS232-encoded bit sequence back to bytes.
   * Inverse of buildBits: skips idle, detects start bits (HIGH),
   * samples 8 data bits at baud-rate centers (inverted), skips stop bit.
   *
   * @param bits   Bit sequence as produced by buildBits
   * @param baud   Baud rate in Hz
   * @returns Decoded bytes
   */
  static decodeBits(bits: SerialBit[], baud: number): number[] {
    const bitNS = 1e9 / baud;
    const halfBit = bitNS / 2;
    const bytes: number[] = [];

    // Build segment boundary lookup for fast sampling
    let totalNS = 0;
    for (const seg of bits) totalNS += seg.durationNS;

    // Sample the bit value at a given absolute time
    const sampleAt = (t: number): boolean => {
      let elapsed = 0;
      for (const seg of bits) {
        if (t < elapsed + seg.durationNS) return seg.value;
        elapsed += seg.durationNS;
      }
      return false; // past end = idle LOW
    };

    // Find the exact time of the next LOW→HIGH transition at or after t
    const findRisingEdge = (from: number): number => {
      let elapsed = 0;
      for (const seg of bits) {
        const segEnd = elapsed + seg.durationNS;
        if (segEnd <= from) { elapsed = segEnd; continue; }
        if (seg.value) {
          // This segment is HIGH — the rising edge is at the start of this segment
          return Math.max(from, elapsed);
        }
        elapsed = segEnd;
      }
      return totalNS; // no rising edge found
    };

    let t = 0;
    while (t < totalNS) {
      // Skip while LOW (idle) — jump to next rising edge
      if (!sampleAt(t)) {
        t = findRisingEdge(t);
        if (t >= totalNS) break;
      }
      // Start bit detected (HIGH) at exact edge. Advance to center of first data bit.
      t += bitNS + halfBit;

      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        if (t >= totalNS) break;
        // Data bits are inverted: LOW on wire = 1
        const wireVal = sampleAt(t);
        if (!wireVal) byte |= (1 << bit);
        t += bitNS;
      }
      bytes.push(byte);

      // Skip stop bit — advance past it, then re-sync at next rising edge
      t += halfBit;
    }

    return bytes;
  }
}
