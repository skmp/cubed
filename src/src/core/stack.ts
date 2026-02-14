/**
 * Circular stack matching the F18A hardware behavior.
 * 8-element circular buffer — no overflow detection, wraps silently.
 * Port of reference/ga144/src/stack.rkt
 */
export class CircularStack {
  private sp: number;
  private body: number[];
  private readonly size: number;

  constructor(size: number = 8, init: number = 0) {
    this.size = size;
    this.sp = 0;
    this.body = new Array(size).fill(init);
  }

  push(value: number): void {
    this.sp = (this.sp + 1) % this.size;
    this.body[this.sp] = value;
  }

  pop(): number {
    const val = this.body[this.sp];
    this.sp = (this.sp + this.size - 1) % this.size;
    return val;
  }

  /** Return array of values from top to bottom (most recently pushed first) */
  toArray(): number[] {
    const result: number[] = [];
    for (let i = 0; i < this.size; i++) {
      result.push(this.body[(this.sp - i + this.size * 2) % this.size]);
    }
    return result;
  }

  reset(init: number = 0): void {
    this.sp = 0;
    this.body.fill(init);
  }

  clone(): CircularStack {
    const copy = new CircularStack(this.size);
    copy.sp = this.sp;
    copy.body = [...this.body];
    return copy;
  }
}
