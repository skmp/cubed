/**
 * Sorted event queue backed by a pool-allocated linked list.
 *
 * Fixed pool of 1024 nodes. Events are sorted by time (ascending).
 * O(1) dequeue from head, O(n) insertion scan but no array shifting.
 * On time collision the new arrival is nudged forward by EPSILON.
 */

export const EVT_NODE = 0;
export const EVT_SERIAL = 1;

const EPSILON = 0.001; // ns nudge for collision resolution
const POOL_SIZE = 1024;
const NIL = -1; // sentinel for "no node"

export interface EventQueue {
  // Pool storage — parallel arrays indexed by pool slot
  times: Float64Array;
  types: Uint8Array;
  payloads: Uint16Array;
  next: Int16Array;     // next pointer (-1 = end)

  head: number;         // index of first (soonest) event, or NIL
  freeHead: number;     // head of free list, or NIL
}

export function createEventQueue(): EventQueue {
  const next = new Int16Array(POOL_SIZE);
  // Build free list: 0 → 1 → 2 → ... → POOL_SIZE-1 → NIL
  for (let i = 0; i < POOL_SIZE - 1; i++) next[i] = i + 1;
  next[POOL_SIZE - 1] = NIL;

  return {
    times: new Float64Array(POOL_SIZE),
    types: new Uint8Array(POOL_SIZE),
    payloads: new Uint16Array(POOL_SIZE),
    next,
    head: NIL,
    freeHead: 0,
  };
}

/** Allocate a node from the free list. Throws on overflow. */
function alloc(q: EventQueue): number {
  const idx = q.freeHead;
  if (idx === NIL) throw new Error('EventQueue overflow (1024 limit)');
  q.freeHead = q.next[idx];
  return idx;
}

/** Return a node to the free list. */
function free(q: EventQueue, idx: number): void {
  q.next[idx] = q.freeHead;
  q.freeHead = idx;
}

/**
 * Enqueue an event at `time`. Maintains sorted order.
 * If `time` collides with an existing event, nudge forward by EPSILON.
 */
export function enqueue(
  q: EventQueue,
  time: number,
  type: number,
  payload: number,
): void {
  let t = time;
  const slot = alloc(q);
  q.types[slot] = type;
  q.payloads[slot] = payload;

  // Insert into sorted linked list
  if (q.head === NIL || t < q.times[q.head]) {
    // Collision check with current head
    if (q.head !== NIL && t === q.times[q.head]) t += EPSILON;
    q.times[slot] = t;
    q.next[slot] = q.head;
    q.head = slot;
    return;
  }

  // Scan for insertion point: find last node where times[cur] <= t
  let prev = q.head;
  let cur = q.next[prev];
  // Handle collision with head
  if (t === q.times[prev]) t += EPSILON;

  while (cur !== NIL) {
    if (q.times[cur] > t) break;
    if (q.times[cur] === t) t += EPSILON;
    prev = cur;
    cur = q.next[cur];
  }

  q.times[slot] = t;
  q.next[slot] = cur;
  q.next[prev] = slot;
}

/** Returns true if the queue has no events. */
export function isEmpty(q: EventQueue): boolean {
  return q.head === NIL;
}

/**
 * Peek at the head event time. Returns Infinity if empty.
 */
export function peekTime(q: EventQueue): number {
  return q.head === NIL ? Infinity : q.times[q.head];
}

/**
 * Dequeue the soonest event. Returns false if empty.
 * Writes result into the provided out object to avoid allocation.
 */
export function dequeue(
  q: EventQueue,
  out: { time: number; type: number; payload: number },
): boolean {
  if (q.head === NIL) return false;
  const idx = q.head;
  out.time = q.times[idx];
  out.type = q.types[idx];
  out.payload = q.payloads[idx];
  q.head = q.next[idx];
  free(q, idx);
  return true;
}

/**
 * Remove all events matching a given type and payload.
 * Used when a node suspends — remove its pending EVT_NODE event.
 */
export function removeByTypeAndPayload(q: EventQueue, type: number, payload: number): void {
  // Remove from head
  while (q.head !== NIL && q.types[q.head] === type && q.payloads[q.head] === payload) {
    const old = q.head;
    q.head = q.next[old];
    free(q, old);
  }
  if (q.head === NIL) return;

  // Remove from rest of list
  let prev = q.head;
  let cur = q.next[prev];
  while (cur !== NIL) {
    if (q.types[cur] === type && q.payloads[cur] === payload) {
      q.next[prev] = q.next[cur];
      free(q, cur);
      cur = q.next[prev];
    } else {
      prev = cur;
      cur = q.next[cur];
    }
  }
}

/** Clear all events and reset the free list. */
export function clearQueue(q: EventQueue): void {
  for (let i = 0; i < POOL_SIZE - 1; i++) q.next[i] = i + 1;
  q.next[POOL_SIZE - 1] = NIL;
  q.head = NIL;
  q.freeHead = 0;
}
