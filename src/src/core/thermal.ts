/**
 * F18A Thermal Model & Timing Jitter
 *
 * Implements per-node energy tracking, thermal accumulation with exponential
 * decay, and thermally-seeded timing jitter based on the F18A datasheet
 * (DB001-221113) and energy white paper (WP002-100405).
 *
 * Physics model:
 *   - Each instruction dissipates energy (pJ) based on its opcode class
 *   - Energy accumulates as heat in the node (tiny silicon die area)
 *   - Heat dissipates exponentially (Newton's cooling law)
 *   - Temperature deviation from nominal affects instruction timing
 *   - Timing varies with normal distribution, seeded by thermal state
 *
 * From the datasheet (section 2.4.1):
 *   "The time required for all activity varies directly with temperature,
 *    inversely with power supply voltage (VDD), and randomly within a
 *    statistical distribution due to variations in the process of
 *    fabricating the chips themselves."
 */

// ============================================================================
// Per-opcode energy (picojoules) and base timing (nanoseconds)
//
// Sources:
//   PB001 line 33: "basic ALU instruction in 1.5 ns for ~7 pJ"
//   DB001 §2.3.3: ALU/register class ~1.5 ns
//   DB001 §2.3.4: Memory read/write class ~5.1 ns (internal memory)
//   DB001 §2.3.5: Control flow class ~5.1 ns; unext ~2.0 ns
//   AN002 line 538: unext loop ~2.5 ns per iteration
//   WP002 line 27: Active node ~4.5 mW; leakage ~100 nW
//
// Within each class, energy is differentiated by circuit complexity:
//   - Ops with address incrementing (P++, A++) cost more than plain reads
//   - +* (multiply step) uses ALU + carry + shift — most complex ALU op
//   - Simple routing (dup, drop, a) costs less than arithmetic (+)
//   - nop dissipates only clock distribution energy
// ============================================================================

/** Energy in picojoules per opcode */
export const OPCODE_ENERGY_PJ: readonly number[] = [
  // 0x00-0x07: Control flow (base ~21 pJ; fetch from new address)
  21.0,   // 0x00  ;    (ret)    — pop R→P, fetch from new P
  21.0,   // 0x01  ex            — swap R↔P, fetch
  21.0,   // 0x02  jump          — load P, fetch
  22.0,   // 0x03  call          — push P→R + load P + fetch (extra stack write)
   8.5,   // 0x04  unext         — decrement R, no memory fetch, stays in word
  22.0,   // 0x05  next          — decrement R, conditional branch, possible fetch
  21.5,   // 0x06  if            — test T, conditional fetch
  21.5,   // 0x07  -if           — test T sign, conditional fetch

  // 0x08-0x0F: Memory read/write (base ~23 pJ; auto-increment costs more)
  24.0,   // 0x08  @p            — fetch P, increment P, memory read (most expensive)
  23.5,   // 0x09  @+            — fetch A, increment A, memory read
  23.0,   // 0x0A  @b            — fetch B, memory read
  23.0,   // 0x0B  @             — fetch A, memory read
  24.0,   // 0x0C  !p            — store at P, increment P, memory write
  23.5,   // 0x0D  !+            — store at A, increment A, memory write
  23.0,   // 0x0E  !b            — store at B, memory write
  23.0,   // 0x0F  !             — store at A, memory write

  // 0x10-0x1F: ALU/register (~7 pJ nominal from PB001; differentiated by complexity)
   9.5,   // 0x10  +*            — multiply step: ALU add + shift + carry (most complex)
   6.5,   // 0x11  2*            — left shift
   6.5,   // 0x12  2/            — right shift
   6.0,   // 0x13  not (inv)     — bitwise invert (toggle all bits)
   7.5,   // 0x14  +             — 18-bit add with carry chain (~7 pJ from PB001)
   6.0,   // 0x15  and           — bitwise AND (simple gate)
   6.0,   // 0x16  or (xor)      — bitwise XOR (simple gate)
   4.5,   // 0x17  drop          — stack pop only (minimal routing)
   4.5,   // 0x18  dup           — T→S push (minimal routing)
   5.0,   // 0x19  pop (r>)      — R→T, rstack pop + dstack push
   5.0,   // 0x1A  over          — S→T push (reads deeper stack)
   4.5,   // 0x1B  a             — A→T push (register read)
   3.0,   // 0x1C  . (nop)       — no operation, only clock distribution
   5.0,   // 0x1D  push (>r)     — T→R, dstack pop + rstack push
   5.0,   // 0x1E  b!            — T→B, stack pop
   5.0,   // 0x1F  a!            — T→A, stack pop
];

/** Base execution time in nanoseconds per opcode (DB001 §2.3.3-2.3.5) */
export const OPCODE_TIME_NS: readonly number[] = [
  // 0x00-0x07: Control flow (~5.1 ns, DB001 §2.3.5; unext ~2.0 ns)
  5.1,    // 0x00  ;
  5.1,    // 0x01  ex
  5.1,    // 0x02  jump
  5.1,    // 0x03  call
  2.0,    // 0x04  unext
  5.1,    // 0x05  next
  5.1,    // 0x06  if
  5.1,    // 0x07  -if

  // 0x08-0x0F: Memory (~5.1 ns, DB001 §2.3.4)
  5.1,    // 0x08  @p
  5.1,    // 0x09  @+
  5.1,    // 0x0A  @b
  5.1,    // 0x0B  @
  5.1,    // 0x0C  !p
  5.1,    // 0x0D  !+
  5.1,    // 0x0E  !b
  5.1,    // 0x0F  !

  // 0x10-0x1F: ALU/register (~1.5 ns, DB001 §2.3.3)
  1.6,    // 0x10  +* — multiply step: near timing limit (DB001 §2.4.2 prefetch warning)
  1.5,    // 0x11  2*
  1.5,    // 0x12  2/
  1.5,    // 0x13  not
  1.5,    // 0x14  +
  1.5,    // 0x15  and
  1.5,    // 0x16  or
  1.5,    // 0x17  drop
  1.5,    // 0x18  dup
  1.5,    // 0x19  pop
  1.5,    // 0x1A  over
  1.5,    // 0x1B  a
  0.7,    // 0x1C  . (nop) — no work, just pipeline slot within instruction word
  1.5,    // 0x1D  push
  1.5,    // 0x1E  b!
  1.5,    // 0x1F  a!
];

/** Leakage power when suspended (nanowatts) — from DB001 section 3.2 */
export const IDLE_POWER_NW = 100;

/** Active power typical (milliwatts) — from WP002 */
export const ACTIVE_POWER_MW = 4.5;

// ============================================================================
// Thermal state per node
// ============================================================================

/**
 * Thermal state for a single F18A node.
 *
 * Model: dT/dt = (P_dissipated / C_thermal) - k * (T - T_ambient)
 *
 * Where:
 *   T = node temperature (Kelvin above ambient, so 0 = ambient)
 *   P = instantaneous power dissipation
 *   C_thermal = thermal capacitance of the node (very small die area)
 *   k = thermal decay constant (heat dissipation to substrate)
 *
 * We track temperature as a dimensionless "thermal units" value that
 * represents deviation from nominal. The exact mapping to Kelvin isn't
 * needed — what matters is the relative variation it introduces.
 *
 * The thermal decay constant is chosen so that at typical active power
 * (~4.5 mW), the steady-state temperature offset is ~1.0 thermal units,
 * producing ~1-3% timing jitter (matching the datasheet's description
 * of "approximate" instruction times).
 */
export interface ThermalState {
  /** Accumulated thermal energy (arbitrary thermal units, 0 = ambient) */
  temperature: number;
  /** Total energy dissipated since reset (picojoules) */
  totalEnergy: number;
  /** Simulated wall-clock time for this node (nanoseconds) */
  simulatedTime: number;
  /** PRNG state for this node's jitter (seeded by thermal state) */
  prngState: number;
  /** Last jittered execution time (ns) — recorded for analog output */
  lastJitteredTime: number;
}

/**
 * Thermal decay per nanosecond of simulated time.
 * At steady state with 4.5 mW continuous load:
 *   T_ss = P_avg / (k * C) ≈ 1.0 thermal units
 *
 * We use exponential decay: T_new = T_old * exp(-dt / tau)
 * tau ~ 100 ns for a tiny silicon node (~60-70 ALU instructions).
 * This gives smoother temperature evolution with realistic thermal
 * inertia — silicon die area per node is ~0.007 mm², but substrate
 * coupling provides meaningful thermal mass.
 */
export const THERMAL_TAU_NS = 100.0;

/**
 * Energy-to-temperature conversion factor.
 * Chosen so that steady-state active temperature ≈ 1.0 thermal units
 * at typical mixed instruction workload (~12 pJ average per opcode).
 * Factor = 1 / (C_thermal) in units of [thermal_units / pJ]
 */
export const ENERGY_TO_TEMP = 0.015;

/**
 * Jitter coefficient: how much temperature affects timing.
 * At T=1.0 (steady-state active), timing jitter sigma = JITTER_COEFF * base_time.
 * DB001 §2.4.1: times are "approximate" and "vary directly with temperature,
 * inversely with VDD, and randomly within a statistical distribution."
 * We model ~1.5% sigma at steady state — conservative estimate matching
 * the datasheet's language of "approximate" instruction times.
 */
export const JITTER_COEFF = 0.015;

// ============================================================================
// Thermal model functions
// ============================================================================

export function createThermalState(seed?: number): ThermalState {
  return {
    temperature: 0,
    totalEnergy: 0,
    simulatedTime: 0,
    prngState: seed ?? (Math.random() * 0x7FFFFFFF) | 0,
    lastJitteredTime: 0,
  };
}

export function resetThermalState(state: ThermalState, seed?: number): void {
  state.temperature = 0;
  state.totalEnergy = 0;
  state.simulatedTime = 0;
  state.prngState = seed ?? (Math.random() * 0x7FFFFFFF) | 0;
  state.lastJitteredTime = 0;
}

/**
 * xorshift32 PRNG — fast, good enough for jitter simulation.
 * Returns a value in [0, 1).
 */
function xorshift32(state: ThermalState): number {
  let x = state.prngState;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  state.prngState = x;
  return (x >>> 0) / 0x100000000;
}

/**
 * Box-Muller transform: generate a normal(0,1) sample from two uniform samples.
 * Uses the thermal state's PRNG.
 */
function normalRandom(state: ThermalState): number {
  const u1 = xorshift32(state) || 1e-10; // avoid log(0)
  const u2 = xorshift32(state);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Apply thermal decay for a given time interval.
 * T_new = T_old * exp(-dt / tau)
 */
function decayTemperature(state: ThermalState, dt_ns: number): void {
  if (dt_ns > 0) {
    state.temperature *= Math.exp(-dt_ns / THERMAL_TAU_NS);
  }
}

/**
 * Record energy dissipation from an instruction and update thermal state.
 *
 * @param state - Node's thermal state
 * @param opcode - Instruction opcode (0-31)
 * @returns Jittered execution time in nanoseconds
 */
export function recordInstruction(state: ThermalState, opcode: number): number {
  const energy = OPCODE_ENERGY_PJ[opcode & 0x1F] ?? 6.75;
  const baseTime = OPCODE_TIME_NS[opcode & 0x1F] ?? 1.5;

  // 1. Decay temperature over the base execution time
  decayTemperature(state, baseTime);

  // 2. Add heat from this instruction's energy
  state.temperature += energy * ENERGY_TO_TEMP;
  state.totalEnergy += energy;

  // 3. Compute jittered time
  // Timing varies directly with temperature (datasheet 2.4.1)
  // sigma = JITTER_COEFF * baseTime * sqrt(temperature)
  // Using sqrt(T) so jitter grows sublinearly with temperature
  const sigma = JITTER_COEFF * baseTime * Math.sqrt(Math.abs(state.temperature));
  const jitter = normalRandom(state) * sigma;

  // Deterministic thermal slowdown: hotter silicon = slower transistors.
  // DB001 §2.4.1: "time required for all activity varies directly with temperature"
  // CMOS delay temperature coefficient ~0.1-0.2%/°C; our thermal units map to
  // a few °C of variation, so ~0.3% per thermal unit is physically reasonable.
  const thermalSlowdown = 1.0 + 0.003 * state.temperature;

  const jitteredTime = Math.max(0.1, baseTime * thermalSlowdown + jitter);

  // 4. Advance simulated time
  state.simulatedTime += jitteredTime;
  state.lastJitteredTime = jitteredTime;

  return jitteredTime;
}

/**
 * Record idle time (node suspended/waiting).
 * Leakage power is negligible (~100 nW) but temperature still decays.
 *
 * @param state - Node's thermal state
 * @param dt_ns - Duration of idle period in nanoseconds
 */
export function recordIdle(state: ThermalState, dt_ns: number): void {
  decayTemperature(state, dt_ns);
  // Leakage energy: 100 nW × dt_ns = 100e-9 W × dt_ns × 1e-9 s = 1e-16 × dt_ns joules
  // = 1e-4 × dt_ns pJ — negligible, but we track it for completeness
  const leakageEnergy = 1e-4 * dt_ns;
  state.totalEnergy += leakageEnergy;
  state.simulatedTime += dt_ns;
}

/**
 * Mix thermal state into the PRNG seed.
 * Called periodically to ensure thermal feedback into jitter.
 */
export function mixThermalSeed(state: ThermalState): void {
  // Mix temperature bits into PRNG state
  const tempBits = (state.temperature * 1e6) | 0;
  state.prngState ^= tempBits;
  // Run a few rounds to diffuse
  xorshift32(state);
  xorshift32(state);
}
