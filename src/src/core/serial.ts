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
}
