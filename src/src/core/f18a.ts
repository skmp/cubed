/**
 * F18A core emulator - single node of the GA144 chip.
 * Port of reference/ga144/src/f18a.rkt
 */
import { CircularStack } from './stack';
import {
  MEM_SIZE, coordToIndex, indexToCoord,
  isPortAddr, regionIndex, PORT, IO_BITS, NODE_GPIO_PINS,
  PortIndex,
} from './constants';
import { WORD_MASK, XOR_ENCODING, NodeState } from './types';
import type { NodeSnapshot, PortHandler } from './types';
import type { GA144 } from './ga144';

const mask18 = (n: number): number => n & WORD_MASK;

export class F18ANode {
  readonly index: number;
  readonly coord: number;
  activeIndex: number;
  private ga144: GA144;

  // Execution state
  private suspended = false;
  private dstack: CircularStack;
  private rstack: CircularStack;

  // Registers
  private A = 0;
  private B = 0;
  private P = 0;
  private I = 0;
  private IXor = 0;  // I ^ XOR_ENCODING cached
  private R = 0;
  private S = 0;
  private T = 0;
  private IO = 0x15555;

  // Instruction state
  private iI = 0;       // current slot index (0-3)
  private IIndex = 0;   // address of current instruction word
  private unextJumpP = false;
  private carryBit = 0;
  private extendedArith = false;

  // Memory
  private memory: (number | PortHandler | null)[];

  // Port communication
  private writingNodes: (F18ANode | null)[] = [null, null, null, null];
  private portVals: (number | null)[] = [null, null, null, null];
  private readingNodes: (F18ANode | null)[] = [null, null, null, null];
  private ludrPortNodes: (number | null)[] = [null, null, null, null]; // stores indices

  // Fetch state
  private fetchingInProgress: false | 'stack' | 'inst' = false;
  private fetchedData: number | null = null;
  private fetchNext = false;

  // Multiport state
  private multiportReadPorts: PortIndex[] | null = null;
  private currentReadingPort: PortIndex | PortIndex[] | null = null;
  private currentWritingPort: PortIndex | null = null;

  // GPIO
  private numGpioPins: number;
  private wakePinPort: PortIndex | null = null;
  private pin17 = false;
  private WD = false;
  private notWD = true;

  // IO read mask
  private notIoReadMask = 0;
  private ioReadDefault = 0;

  // Breakpoints
  private breakpoints: Map<number, boolean> = new Map();
  private breakpointHit = false;

  // Step counter
  stepCount = 0;

  constructor(index: number, ga144: GA144) {
    this.index = index;
    this.activeIndex = index;
    this.ga144 = ga144;
    this.coord = indexToCoord(index);
    this.numGpioPins = NODE_GPIO_PINS[this.coord] || 0;
    this.dstack = new CircularStack(8, 0x15555);
    this.rstack = new CircularStack(8, 0x15555);
    this.memory = new Array(MEM_SIZE).fill(0x134A9); // call warm
  }

  // ========================================================================
  // Initialization
  // ========================================================================

  init(): void {
    this.initLudrPortNodes();
    this.initIoMask();
  }

  private initLudrPortNodes(): void {
    const coord = this.coord;
    const x = coord % 100;
    const y = Math.floor(coord / 100);

    const convert = (dir: string): PortIndex => {
      switch (dir) {
        case 'north': return y % 2 === 0 ? PortIndex.DOWN : PortIndex.UP;
        case 'south': return y % 2 === 0 ? PortIndex.UP : PortIndex.DOWN;
        case 'east':  return x % 2 === 0 ? PortIndex.RIGHT : PortIndex.LEFT;
        case 'west':  return x % 2 === 0 ? PortIndex.LEFT : PortIndex.RIGHT;
        default: throw new Error(`Invalid direction: ${dir}`);
      }
    };

    this.ludrPortNodes = [null, null, null, null];

    // North neighbor
    if (y < 7) {
      this.ludrPortNodes[convert('north')] = coordToIndex(coord + 100);
    }
    // East neighbor
    if (x < 17) {
      this.ludrPortNodes[convert('east')] = coordToIndex(coord + 1);
    }
    // South neighbor
    if (y > 0) {
      this.ludrPortNodes[convert('south')] = coordToIndex(coord - 100);
    }
    // West neighbor
    if (x > 0) {
      this.ludrPortNodes[convert('west')] = coordToIndex(coord - 1);
    }

    // Wake pin port
    if (this.numGpioPins > 0) {
      if (this.coord > 700 || this.coord < 17) {
        this.wakePinPort = PortIndex.UP;
      } else {
        this.wakePinPort = PortIndex.LEFT;
      }
    }
  }

  private initIoMask(): void {
    let mask = 0;
    if (this.numGpioPins > 0) {
      const pinMasks = [0, 0x20000, 0x20002, 0x2000A, 0x2002A];
      mask = pinMasks[this.numGpioPins] || 0;
    }
    // Add status bits for existing ports
    if (this.ludrPortNodes[PortIndex.LEFT] !== null) mask |= 0x1800;
    if (this.ludrPortNodes[PortIndex.UP] !== null) mask |= 0x600;
    if (this.ludrPortNodes[PortIndex.DOWN] !== null) mask |= 0x6000;
    if (this.ludrPortNodes[PortIndex.RIGHT] !== null) mask |= 0x18000;

    this.notIoReadMask = mask18(~mask);
    this.ioReadDefault = 0x15555 & mask;
  }

  // ========================================================================
  // Stack operations
  // ========================================================================

  private dPush(value: number): void {
    this.dstack.push(this.S);
    this.S = this.T;
    this.T = mask18(value);
  }

  private dPop(): number {
    const val = this.T;
    this.T = this.S;
    this.S = this.dstack.pop();
    return val;
  }

  private rPush(value: number): void {
    this.rstack.push(this.R);
    this.R = value;
  }

  private rPop(): number {
    const val = this.R;
    this.R = this.rstack.pop();
    return val;
  }

  // ========================================================================
  // Address increment
  // ========================================================================

  private incr(curr: number): number {
    if ((curr & 0x100) > 0) return curr; // I/O space: don't increment
    const bit9 = curr & 0x200;
    const addr = curr & 0xFF;
    let next: number;
    if (addr < 0x7F) next = addr + 1;
    else if (addr === 0x7F) next = 0;
    else if (addr < 0xFF) next = addr + 1;
    else next = 0x80;
    return next | bit9;
  }

  // ========================================================================
  // Suspension and wakeup
  // ========================================================================

  private removeFromActiveList(): void {
    this.ga144.removeFromActiveList(this);
    this.suspended = true;
  }

  private addToActiveList(): void {
    this.ga144.addToActiveList(this);
    this.suspended = false;
  }

  private suspend(): void {
    this.removeFromActiveList();
  }

  private wakeup(): void {
    this.addToActiveList();
  }

  // ========================================================================
  // Port communication
  // ========================================================================

  private getPortNode(port: PortIndex): F18ANode | null {
    const idx = this.ludrPortNodes[port];
    if (idx === null) return null;
    return this.ga144.getNodeByIndex(idx);
  }

  private doPortRead(port: PortIndex): boolean {
    if (port === this.wakePinPort && this.wakePinPort !== null) {
      // Reading from wake pin
      if (this.pin17 === this.notWD) {
        this.fetchedData = this.pin17 ? 1 : 0;
        return true;
      } else {
        this.suspend();
        return false;
      }
    }

    const writingNode = this.writingNodes[port];
    if (writingNode) {
      // Value was ready
      this.fetchedData = this.portVals[port]!;
      this.writingNodes[port] = null;
      writingNode.finishPortWrite();
      return true;
    } else {
      // Suspend while waiting
      const other = this.getPortNode(port);
      if (other) {
        other.receivePortRead(port, this);
      }
      this.currentReadingPort = port;
      this.suspend();
      return false;
    }
  }

  private doMultiportRead(ports: PortIndex[]): boolean {
    let done = false;
    for (const port of ports) {
      if (port === this.wakePinPort && this.wakePinPort !== null) {
        if (this.pin17 === this.notWD) {
          this.fetchedData = this.pin17 ? 1 : 0;
          done = true;
        }
      } else {
        const writingNode = this.writingNodes[port];
        if (writingNode && !done) {
          this.fetchedData = this.portVals[port]!;
          this.writingNodes[port] = null;
          writingNode.finishPortWrite();
          done = true;
        }
      }
    }

    if (done) return true;

    // Suspend waiting for any port
    this.multiportReadPorts = [];
    for (const port of ports) {
      const other = this.getPortNode(port);
      if (other) {
        other.receivePortRead(port, this);
        this.multiportReadPorts.push(port);
      }
    }
    this.currentReadingPort = ports;
    this.suspend();
    return false;
  }

  private portWrite(port: PortIndex, value: number): boolean {
    const readingNode = this.readingNodes[port];
    if (readingNode) {
      this.readingNodes[port] = null;
      readingNode.finishPortRead(value);
      return true;
    } else {
      const other = this.getPortNode(port);
      if (other) {
        other.receivePortWrite(port, value, this);
      }
      this.currentWritingPort = port;
      this.suspend();
      return false;
    }
  }

  private multiportWrite(ports: PortIndex[], value: number): boolean {
    for (const port of ports) {
      const readingNode = this.readingNodes[port];
      if (readingNode) {
        this.readingNodes[port] = null;
        readingNode.finishPortRead(value);
      }
    }
    return true;
  }

  finishPortRead(val: number): void {
    this.fetchedData = val;
    if (this.suspended) this.wakeup();
    if (this.fetchingInProgress) {
      this.finishFetch();
    }
    // Cancel any other multiport reads
    if (this.multiportReadPorts) {
      for (const port of this.multiportReadPorts) {
        const other = this.getPortNode(port);
        if (other) other.receivePortRead(port, null);
      }
      this.multiportReadPorts = null;
    }
    this.currentReadingPort = null;
  }

  finishPortWrite(): void {
    this.currentWritingPort = null;
    this.wakeup();
  }

  receivePortRead(port: PortIndex, node: F18ANode | null): void {
    this.readingNodes[port] = node;
  }

  receivePortWrite(port: PortIndex, value: number, node: F18ANode): void {
    this.writingNodes[port] = node;
    this.portVals[port] = value;
  }

  // ========================================================================
  // IO register
  // ========================================================================

  private readIoReg(): number {
    let io = (mask18(~this.IO) & this.notIoReadMask) | this.ioReadDefault;

    // Handshake read bits
    if (this.readingNodes[PortIndex.LEFT]) io &= IO_BITS.Lr_MASK;
    if (this.readingNodes[PortIndex.UP]) io &= IO_BITS.Ur_MASK;
    if (this.readingNodes[PortIndex.DOWN]) io &= IO_BITS.Dr_MASK;
    if (this.readingNodes[PortIndex.RIGHT]) io &= IO_BITS.Rr_MASK;

    // Handshake write bits
    if (this.writingNodes[PortIndex.LEFT]) io |= IO_BITS.Lw_BIT;
    if (this.writingNodes[PortIndex.UP]) io |= IO_BITS.Uw_BIT;
    if (this.writingNodes[PortIndex.DOWN]) io |= IO_BITS.Dw_BIT;
    if (this.writingNodes[PortIndex.RIGHT]) io |= IO_BITS.Rw_BIT;

    // GPIO pin bits
    if (this.numGpioPins > 0 && this.pin17) io |= IO_BITS.PIN17_BIT;

    return io;
  }

  private setIoReg(val: number): void {
    this.IO = val;
    this.WD = ((val >> 11) & 1) === 1;
    this.notWD = !this.WD;
    this.ga144.onIoWrite(this.index, val);
  }

  // ========================================================================
  // Memory access
  // ========================================================================

  private readMemory(addr: number): boolean {
    addr = addr & 0x1FF;
    if (isPortAddr(addr)) {
      const handler = this.memory[addr];
      if (handler && typeof handler === 'object' && 'read' in handler) {
        return (handler as PortHandler).read();
      }
      return true; // invalid port, don't crash
    }
    this.fetchedData = this.memory[regionIndex(addr)] as number;
    return true;
  }

  private readMemoryToStack(addr: number): void {
    if (this.readMemory(addr)) {
      this.dPush(this.fetchedData!);
    } else {
      this.fetchingInProgress = 'stack';
    }
  }

  private setMemory(addr: number, value: number): void {
    addr = addr & 0x1FF;
    if (isPortAddr(addr)) {
      const handler = this.memory[addr];
      if (handler && typeof handler === 'object' && 'write' in handler) {
        (handler as PortHandler).write(value);
      }
      return;
    }
    (this.memory as number[])[regionIndex(addr)] = value;
  }

  // ========================================================================
  // Instruction execution
  // ========================================================================

  private executeInstruction(opcode: number, jumpAddrPos: number, addrMask: number): boolean {
    this.stepCount++;

    if (opcode < 8) {
      // Control flow instructions - need address from decoded word
      const addr = this.IXor & ((1 << jumpAddrPos) - 1);
      return this.executeWithAddr(opcode, addr, addrMask);
    }
    return this.executeNoAddr(opcode);
  }

  private executeWithAddr(opcode: number, addr: number, mask: number): boolean {
    switch (opcode) {
      case 0: // ; (return)
        this.P = this.R;
        this.rPop();
        return false;

      case 1: // ex (exchange P and R)
        const temp = this.P;
        this.P = this.R;
        this.R = temp;
        return false;

      case 2: // jump
        this.extendedArith = (addr & 0x200) !== 0;
        this.P = addr | (this.P & mask);
        return false;

      case 3: // call
        this.extendedArith = (addr & 0x200) !== 0;
        this.rPush(this.P);
        this.P = addr | (this.P & mask);
        return false;

      case 4: // unext
        if (this.R === 0) {
          this.rPop();
          return true;
        } else {
          this.R--;
          this.unextJumpP = true;
          return false;
        }

      case 5: // next
        if (this.R === 0) {
          this.rPop();
          return false;
        } else {
          this.R--;
          this.P = addr | (this.P & mask);
          return false;
        }

      case 6: // if (jump if T=0)
        if (this.T === 0) {
          this.P = addr | (this.P & mask);
          return false;
        }
        return true;

      case 7: // -if (jump if T>=0, bit 17 = 0)
        if (((this.T >> 17) & 1) === 0) {
          this.P = addr | (this.P & mask);
          return false;
        }
        return true;

      default:
        return true;
    }
  }

  private executeNoAddr(opcode: number): boolean {
    switch (opcode) {
      case 8: // @p (fetch from P, push, increment P)
        this.readMemoryToStack(this.P);
        this.P = this.incr(this.P);
        return true;

      case 9: // @+ (fetch from A, push, increment A)
        this.readMemoryToStack(this.A & 0x1FF);
        this.A = this.incr(this.A);
        return true;

      case 10: // @b (fetch from B, push)
        this.readMemoryToStack(this.B);
        return true;

      case 11: // @ (fetch from A, push)
        this.readMemoryToStack(this.A & 0x1FF);
        return true;

      case 12: // !p (store T to [P], pop, increment P)
        this.setMemory(this.P, this.dPop());
        this.P = this.incr(this.P);
        return true;

      case 13: // !+ (store T to [A], pop, increment A)
        this.setMemory(this.A, this.dPop());
        this.A = this.incr(this.A);
        return true;

      case 14: // !b (store T to [B], pop)
        this.setMemory(this.B, this.dPop());
        return true;

      case 15: // ! (store T to [A], pop)
        this.setMemory(this.A & 0x1FF, this.dPop());
        return true;

      case 16: { // +* (multiply step)
        if ((this.A & 1) === 1) {
          let sum: number;
          if (this.extendedArith) {
            sum = this.T + this.S + this.carryBit;
            this.carryBit = (sum >> 18) & 1;
          } else {
            sum = this.T + this.S;
          }
          const sum17 = sum & 0x20000;
          const result = (sum * (1 << 17)) + (this.A >>> 1);
          this.A = mask18(result);
          this.T = sum17 | ((result >>> 18) & 0x1FFFF);
        } else {
          const t17 = this.T & 0x20000;
          const t0 = this.T & 1;
          this.T = t17 | (this.T >>> 1);
          this.A = ((t0 << 17) | (this.A >>> 1)) & WORD_MASK;
        }
        return true;
      }

      case 17: // 2* (left shift)
        this.T = mask18(this.T << 1);
        return true;

      case 18: // 2/ (right arithmetic shift)
        this.T = this.T >> 1;
        return true;

      case 19: // - (bitwise NOT)
        this.T = mask18(~this.T);
        return true;

      case 20: { // + (add)
        if (this.extendedArith) {
          const sum = this.dPop() + this.dPop() + this.carryBit;
          this.carryBit = (sum >> 18) & 1;
          this.dPush(mask18(sum));
        } else {
          this.dPush(mask18(this.dPop() + this.dPop()));
        }
        return true;
      }

      case 21: // and
        this.dPush(this.dPop() & this.dPop());
        return true;

      case 22: // or (actually XOR)
        this.dPush(this.dPop() ^ this.dPop());
        return true;

      case 23: // drop
        this.dPop();
        return true;

      case 24: // dup
        this.dPush(this.T);
        return true;

      case 25: // pop (R -> T)
        this.dPush(this.rPop());
        return true;

      case 26: // over
        this.dPush(this.S);
        return true;

      case 27: // a (read A register)
        this.dPush(this.A);
        return true;

      case 28: // . (nop)
        return true;

      case 29: // push (T -> R)
        this.rPush(this.dPop());
        return true;

      case 30: // b! (store T into B)
        this.B = this.dPop() & 0x1FF;
        return true;

      case 31: // a! (store T into A)
        this.A = this.dPop();
        return true;

      default:
        return true;
    }
  }

  // ========================================================================
  // Instruction fetch and step
  // ========================================================================

  private finishIFetch(): void {
    this.I = this.fetchedData ?? 0;
    this.fetchedData = null;
    this.P = this.incr(this.P);
    if (this.I === null || this.I === undefined) {
      this.suspend();
      this.I = 0x134A9; // call warm
    }
    this.IXor = this.I ^ XOR_ENCODING;
  }

  fetchI(): void {
    this.IIndex = this.P;
    if (this.readMemory(this.P)) {
      this.finishIFetch();
    } else {
      this.fetchingInProgress = 'inst';
    }
  }

  private finishFetch(): void {
    if (this.fetchingInProgress === 'stack') {
      this.dPush(this.fetchedData!);
    } else if (this.fetchingInProgress === 'inst') {
      this.finishIFetch();
    }
    this.fetchingInProgress = false;
  }

  private doStep(): void {
    switch (this.iI) {
      case 0: {
        // Check breakpoint
        const bpAddr = isPortAddr(this.IIndex) ? (this.IIndex & 0x1FF) : regionIndex(this.IIndex);
        if (this.breakpoints.has(bpAddr)) {
          this.breakpointHit = true;
          this.ga144.onBreakpoint(this);
          return;
        }
        const opcode = (this.IXor >> 13) & 0x1F;
        this.iI = this.executeInstruction(opcode, 10, 0x3FC00) ? 1 : 0;
        break;
      }
      case 1: {
        const opcode = (this.IXor >> 8) & 0x1F;
        this.iI = this.executeInstruction(opcode, 8, 0x3FE00) ? 2 : 0;
        break;
      }
      case 2: {
        const opcode = (this.IXor >> 3) & 0x1F;
        this.iI = this.executeInstruction(opcode, 3, 0x3FEF8) ? 3 : 0;
        break;
      }
      case 3: {
        const opcode = (this.IXor & 0x7) << 1;
        this.executeInstruction(opcode, 0, 0);
        this.iI = 0;
        break;
      }
    }

    // Fetch next word if back to slot 0
    if (this.iI === 0) {
      if (this.unextJumpP) {
        this.unextJumpP = false;
      } else if (this.suspended) {
        this.fetchNext = true;
      } else {
        this.fetchI();
      }
    }
  }

  step(): void {
    if (this.fetchingInProgress) {
      this.finishFetch();
    } else if (this.fetchNext) {
      this.fetchNext = false;
      this.fetchI();
    } else {
      this.doStep();
    }
  }

  stepProgram(): boolean {
    if (!this.suspended) {
      this.step();
    }
    return this.suspended;
  }

  // ========================================================================
  // Reset
  // ========================================================================

  reset(romData?: number[]): void {
    this.A = 0;
    this.B = PORT.IO; // 0x15D
    this.P = 0;
    this.iI = 0;
    this.R = 0x15555;
    this.S = 0x15555;
    this.T = 0x15555;
    this.IO = 0x15555;
    this.memory = new Array(MEM_SIZE).fill(0x134A9);
    this.fetchingInProgress = false;
    this.fetchedData = null;
    this.fetchNext = false;
    this.dstack = new CircularStack(8, 0x15555);
    this.rstack = new CircularStack(8, 0x15555);
    this.writingNodes = [null, null, null, null];
    this.readingNodes = [null, null, null, null];
    this.portVals = [null, null, null, null];
    this.multiportReadPorts = null;
    this.currentReadingPort = null;
    this.currentWritingPort = null;
    this.WD = false;
    this.notWD = true;
    this.pin17 = false;
    this.unextJumpP = false;
    this.suspended = false;
    this.stepCount = 0;
    this.breakpointHit = false;
    this.carryBit = 0;
    this.extendedArith = false;

    // Load ROM
    if (romData) {
      for (let i = 0; i < romData.length && i < 64; i++) {
        this.memory[0x80 + i] = romData[i];
      }
    }

    // Setup ports
    this.setupPorts();

    // Reset P to ROM cold/warm entry
    this.resetP();
  }

  resetP(start?: number): void {
    if (start !== undefined) {
      this.P = start;
      return;
    }
    // Default: use ROM "cold" or "warm" entry
    // We'll default to 0xAA (cold) which is typical
    this.P = 0xAA;
  }

  private setupPorts(): void {
    const self = this;
    const makeSinglePort = (port: PortIndex): PortHandler => ({
      read: () => self.doPortRead(port),
      write: (v: number) => { self.portWrite(port, v); },
    });
    const makeMultiPort = (ports: PortIndex[]): PortHandler => ({
      read: () => self.doMultiportRead(ports),
      write: (v: number) => { self.multiportWrite(ports, v); },
    });

    // Single ports
    this.memory[PORT.LEFT] = makeSinglePort(PortIndex.LEFT);
    this.memory[PORT.RIGHT] = makeSinglePort(PortIndex.RIGHT);
    this.memory[PORT.UP] = makeSinglePort(PortIndex.UP);
    this.memory[PORT.DOWN] = makeSinglePort(PortIndex.DOWN);

    // IO register
    this.memory[PORT.IO] = {
      read: () => { self.fetchedData = self.readIoReg(); return true; },
      write: (v: number) => { self.setIoReg(v); },
    };

    // Multiport combinations
    this.memory[0x165] = makeMultiPort([PortIndex.LEFT, PortIndex.UP]);         // --lu
    this.memory[0x105] = makeMultiPort([PortIndex.DOWN, PortIndex.UP]);         // -d-u
    this.memory[0x135] = makeMultiPort([PortIndex.DOWN, PortIndex.LEFT]);       // -dl-
    this.memory[0x125] = makeMultiPort([PortIndex.DOWN, PortIndex.LEFT, PortIndex.UP]); // -dlu
    this.memory[0x1C5] = makeMultiPort([PortIndex.RIGHT, PortIndex.UP]);        // r--u
    this.memory[0x1F5] = makeMultiPort([PortIndex.RIGHT, PortIndex.LEFT]);      // r-l-
    this.memory[0x1E5] = makeMultiPort([PortIndex.RIGHT, PortIndex.LEFT, PortIndex.UP]); // r-lu
    this.memory[0x195] = makeMultiPort([PortIndex.RIGHT, PortIndex.DOWN]);      // rd--
    this.memory[0x185] = makeMultiPort([PortIndex.RIGHT, PortIndex.DOWN, PortIndex.UP]); // rd-u
    this.memory[0x1B5] = makeMultiPort([PortIndex.RIGHT, PortIndex.DOWN, PortIndex.LEFT]); // rdl-
    this.memory[0x1A5] = makeMultiPort([PortIndex.RIGHT, PortIndex.DOWN, PortIndex.LEFT, PortIndex.UP]); // rdlu

    // DATA port
    let dataVal = 0;
    this.memory[PORT.DATA] = {
      read: () => { self.fetchedData = dataVal; return true; },
      write: (v: number) => { dataVal = v; },
    };
  }

  // ========================================================================
  // Loading
  // ========================================================================

  load(node: { mem: (number | null)[]; len: number; a?: number; b?: number; io?: number; p?: number; stack?: number[] }): void {
    const code = node.mem;
    const n = node.len;
    for (let i = 0; i < n; i++) {
      if (code[i] !== null) {
        this.memory[i] = code[i]!;
      }
    }
    this.P = node.p ?? 0;
    this.iI = 0;
    if (node.a !== undefined) this.A = node.a;
    if (node.b !== undefined) this.B = node.b;
    if (node.io !== undefined) this.IO = node.io;
    if (node.stack) {
      for (const v of node.stack) this.dPush(v);
    }
    this.fetchI();
  }

  // ========================================================================
  // Breakpoints
  // ========================================================================

  setBreakpoint(addr: number): void {
    this.breakpoints.set(addr, true);
  }

  clearBreakpoint(addr: number): void {
    this.breakpoints.delete(addr);
  }

  clearAllBreakpoints(): void {
    this.breakpoints.clear();
    this.breakpointHit = false;
  }

  // ========================================================================
  // State queries
  // ========================================================================

  getState(): NodeState {
    if (this.breakpointHit) return NodeState.SUSPENDED;
    if (!this.suspended) return NodeState.RUNNING;
    if (this.currentReadingPort !== null) return NodeState.BLOCKED_READ;
    if (this.currentWritingPort !== null) return NodeState.BLOCKED_WRITE;
    return NodeState.SUSPENDED;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  getSnapshot(): NodeSnapshot {
    return {
      coord: this.coord,
      index: this.index,
      state: this.getState(),
      registers: {
        P: this.P,
        I: this.I,
        A: this.A,
        B: this.B,
        T: this.T,
        S: this.S,
        R: this.R,
        IO: this.IO,
      },
      dstack: [this.T, this.S, ...this.dstack.toArray()],
      rstack: [this.R, ...this.rstack.toArray()],
      ram: this.getRAM(),
      rom: this.getROM(),
      slotIndex: this.iI,
      stepCount: this.stepCount,
      currentReadingPort: this.currentReadingPort !== null
        ? (Array.isArray(this.currentReadingPort)
          ? `multi(${this.currentReadingPort.length})`
          : ['L', 'U', 'D', 'R'][this.currentReadingPort])
        : null,
      currentWritingPort: this.currentWritingPort !== null
        ? ['L', 'U', 'D', 'R'][this.currentWritingPort]
        : null,
    };
  }

  getRAM(): number[] {
    const ram: number[] = [];
    for (let i = 0; i < 64; i++) {
      const val = this.memory[i];
      ram.push(typeof val === 'number' ? val : 0);
    }
    return ram;
  }

  getROM(): number[] {
    const rom: number[] = [];
    for (let i = 0x80; i < 0xC0; i++) {
      const val = this.memory[i];
      rom.push(typeof val === 'number' ? val : 0);
    }
    return rom;
  }

  getCoord(): number {
    return this.coord;
  }
}
