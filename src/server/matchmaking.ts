// The ranked queue, ported from the v1 server (`git show v1.0.0:server/server.js`, §5). Pure and
// in memory only: the `Accounts` Durable Object hosts one Matchmaker and drives it from
// /api/account/queue/* (accounts.ts), with an injected clock so the tests can move time.
//
// A player waits with their internal TR (hidden or not). Their accepted TR gap starts at ±500 and
// widens by 500 every 10 s. Two entries pair, oldest first, when |trA - trB| <= max(rangeA, rangeB).
// Polling `status` is the keep-alive: an entry not polled for QUEUE_STALE_MS is dropped. A pairing
// is kept as a `matched` answer until that player reads it, or MATCHED_TTL_MS pass.

export const INITIAL_RANGE = 500;
export const RANGE_EXPAND = 500;
export const RANGE_EXPAND_MS = 10_000;
export const QUEUE_STALE_MS = 15_000;
export const MATCHED_TTL_MS = 30_000;

export interface QueuePlayer {
  key: string; // lower-cased username
  username: string;
}

interface Entry extends QueuePlayer {
  tr: number;
  joinedAt: number;
  seenAt: number; // last join or poll
}

export type QueueStatus =
  | { status: "waiting"; waited: number; range: number } // waited in whole seconds
  | { status: "matched"; code: string }
  | { status: "none" };

/** Two players taken out of the queue together. `players[0]` waited longer. */
export interface Pairing {
  players: [QueuePlayer, QueuePlayer];
  entries: [Entry, Entry];
}

/** The accepted TR gap after `waitedMs` in the queue. */
export function rangeAfter(waitedMs: number): number {
  return INITIAL_RANGE + RANGE_EXPAND * Math.floor(waitedMs / RANGE_EXPAND_MS);
}

/** How the queue screen writes a range: `±500`. */
export function formatRange(range: number): string {
  return `±${range}`;
}

export class Matchmaker {
  private waiting: Entry[] = []; // oldest first
  private matched = new Map<string, { code: string; at: number }>();
  private opening = new Map<string, Entry>(); // paired, waiting for their room to be registered

  constructor(private now: () => number) {}

  /** Enter (or re-enter) the queue; any earlier entry or unread match for the account is dropped. */
  join(player: QueuePlayer, tr: number): void {
    this.leave(player.key);
    const t = this.now();
    this.waiting.push({ key: player.key, username: player.username, tr, joinedAt: t, seenAt: t });
  }

  leave(key: string): void {
    this.waiting = this.waiting.filter((e) => e.key !== key);
    this.matched.delete(key);
    this.opening.delete(key);
  }

  /** The player's state; a poll keeps a waiting entry alive, and a `matched` answer is given once. */
  status(key: string): QueueStatus {
    this.expire();
    const m = this.matched.get(key);
    if (m) {
      this.matched.delete(key);
      return { status: "matched", code: m.code };
    }
    const e = this.waiting.find((x) => x.key === key) ?? this.opening.get(key);
    if (!e) return { status: "none" };
    const t = this.now();
    e.seenAt = t;
    return { status: "waiting", waited: Math.floor((t - e.joinedAt) / 1000), range: rangeAfter(t - e.joinedAt) };
  }

  /** Keep a waiting entry alive without answering (status does this too). */
  touch(key: string): void {
    const e = this.waiting.find((x) => x.key === key) ?? this.opening.get(key);
    if (e) e.seenAt = this.now();
  }

  /** Take every pair that fits out of the queue, oldest entries first. Stale entries are dropped first. */
  pair(): Pairing[] {
    this.expire();
    const t = this.now();
    const pairs: Pairing[] = [];
    for (let i = 0; i < this.waiting.length; i++) {
      const a = this.waiting[i];
      for (let j = i + 1; j < this.waiting.length; j++) {
        const b = this.waiting[j];
        if (a.key === b.key) continue; // join replaces an entry, so this can't happen; never pair anyone with themselves
        if (Math.abs(a.tr - b.tr) <= Math.max(rangeAfter(t - a.joinedAt), rangeAfter(t - b.joinedAt))) {
          this.waiting.splice(j, 1);
          this.waiting.splice(i, 1);
          pairs.push({ players: [{ key: a.key, username: a.username }, { key: b.key, username: b.username }], entries: [a, b] });
          this.opening.set(a.key, a);
          this.opening.set(b.key, b);
          i--;
          break;
        }
      }
    }
    return pairs;
  }

  /** The pairing has a room: both players get `{status: "matched", code}` on their next poll. */
  matchedTo(pairing: Pairing, code: string): void {
    const at = this.now();
    for (const e of pairing.entries) {
      // a player who left (or re-joined) meanwhile isn't told; the opponent then waits alone and the room times out
      if (this.opening.get(e.key) !== e) continue;
      this.opening.delete(e.key);
      this.matched.set(e.key, { code, at });
    }
  }

  /** No room could be opened for the pairing: put both entries back in their place, unless they left or re-joined. */
  requeue(pairing: Pairing): void {
    for (const e of pairing.entries) {
      if (this.opening.get(e.key) !== e) continue;
      this.opening.delete(e.key);
      this.waiting.push(e);
    }
    this.waiting.sort((x, y) => x.joinedAt - y.joinedAt);
  }

  /** Entries waiting (for the tests). */
  get size(): number {
    return this.waiting.length;
  }

  private expire(): void {
    const t = this.now();
    this.waiting = this.waiting.filter((e) => t - e.seenAt < QUEUE_STALE_MS);
    for (const [key, m] of this.matched) if (t - m.at >= MATCHED_TTL_MS) this.matched.delete(key);
  }
}
