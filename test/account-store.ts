// The in-memory AccountStore the accounts, leaderboard and ranked tests share (the Durable Object's is SQLite).
import { AccountRow, AccountStore, CalibratedRow, PAIR_WINDOW_MS, REGISTRATION_WINDOW_MS, RankedMatchRow, RatingRow, SessionRow } from "../src/server/accounts";
import { RD_HIDDEN } from "../src/server/rating";

const sorted = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export class MemoryStore implements AccountStore {
  accounts = new Map<string, AccountRow>();
  sessions = new Map<string, SessionRow>();
  account(key: string): AccountRow | null {
    return this.accounts.get(key) ?? null;
  }
  insertAccount(key: string, row: AccountRow): boolean {
    if (this.accounts.has(key)) return false;
    this.accounts.set(key, { ...row });
    return true;
  }
  accountCount(): number {
    return this.accounts.size;
  }
  registrations: { ipHash: string; at: number }[] = [];
  registrationsFrom(ipHash: string, since: number): number[] {
    return this.registrations.filter((r) => r.ipHash === ipHash && r.at >= since).map((r) => r.at).sort((a, b) => a - b);
  }
  insertRegistration(ipHash: string, at: number): void {
    this.registrations = this.registrations.filter((r) => r.at >= at - REGISTRATION_WINDOW_MS);
    this.registrations.push({ ipHash, at });
  }
  accountsCreatedSince(since: number): number {
    return [...this.accounts.values()].filter((a) => a.createdAt >= since).length;
  }
  setRecords(key: string, records: string): void {
    this.accounts.get(key)!.records = records;
  }
  session(tokenHash: string): SessionRow | null {
    return this.sessions.get(tokenHash) ?? null;
  }
  insertSession(tokenHash: string, row: SessionRow): void {
    this.sessions.set(tokenHash, { ...row });
  }
  deleteSession(tokenHash: string): void {
    this.sessions.delete(tokenHash);
  }
  deleteSessionsFor(key: string): void {
    for (const [k, s] of this.sessions) if (s.key === key) this.sessions.delete(k);
  }
  deleteExpiredSessions(now: number): void {
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k);
  }
  ratings = new Map<string, RatingRow>();
  ranked = new Map<string, RankedMatchRow>();
  rating(key: string): RatingRow | null {
    return this.ratings.get(key) ?? null;
  }
  rankedMatch(code: string): RankedMatchRow | null {
    return this.ranked.get(code) ?? null;
  }
  insertRankedMatch(code: string, row: RankedMatchRow): void {
    this.ranked.set(code, row);
  }
  deleteRankedMatchesBefore(createdAt: number): void {
    for (const [k, m] of this.ranked) if (m.createdAt < createdAt) this.ranked.delete(k);
  }
  deleteRankedMatch(code: string): boolean {
    return this.ranked.delete(code);
  }
  pairs: { keys: [string, string]; at: number }[] = []; // rated pairs, keys sorted
  rateMatch(code: string, ratings: [string, RatingRow][], at: number): boolean {
    if (!this.ranked.delete(code)) return false;
    for (const [key, row] of ratings) this.ratings.set(key, { ...row });
    if (ratings.length === 2) this.pairs.push({ keys: sorted(ratings[0][0], ratings[1][0]), at });
    this.pairs = this.pairs.filter((p) => p.at >= at - PAIR_WINDOW_MS);
    return true;
  }
  pairCount(keyA: string, keyB: string, since: number): number {
    const [lo, hi] = sorted(keyA, keyB);
    return this.pairs.filter((p) => p.keys[0] === lo && p.keys[1] === hi && p.at >= since).length;
  }
  openMatchCount(keyA: string, keyB: string, since: number): number {
    const [lo, hi] = sorted(keyA, keyB);
    return [...this.ranked.values()].filter((m) => {
      const [x, y] = sorted(m.keys[0], m.keys[1]);
      return x === lo && y === hi && m.createdAt >= since;
    }).length;
  }
  calibrated(): CalibratedRow[] {
    const rows: CalibratedRow[] = [];
    for (const [key, r] of this.ratings) {
      const a = this.accounts.get(key);
      if (a && r.rd <= RD_HIDDEN) rows.push({ key, username: a.username, createdAt: a.createdAt, r: r.r, rd: r.rd, games: r.games });
    }
    return rows;
  }
}
