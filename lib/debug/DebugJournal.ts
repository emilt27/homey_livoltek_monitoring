/**
 * Debug journal: a record of every poll, decision and device delivery, kept in app settings in
 * hourly chunks so it survives restarts (also unexpected ones) and can be downloaded through the
 * app API (GET /journal). Off by default; switched with the inverter's "Debug journal" setting.
 * Switching it off deletes everything it saved. See "Debug journal" in the README.
 */
import { Logger } from '../LivoltekAPI';
import { TimerApi } from '../Poller';

export interface JournalEntry {
  at: number;
  kind: string;
  [field: string]: unknown;
}

/** What the site pipeline needs from a journal; the no-op default keeps it optional. */
export interface Journal {
  add(kind: string, fields: Record<string, unknown>): void;
}

export const NO_JOURNAL: Journal = { add: () => undefined };

export interface JournalStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  unset(key: string): void;
}

export interface JournalConfig {
  retentionMs: number; // chunks older than this are dropped
  chunkMs: number; // one settings key per chunk, so a save writes only the current one
  maxEntriesPerChunk: number; // safety limit
  urgentDelayMs: number; // urgent entries are saved this soon (a burst becomes one write)
  persistDelayMs: number; // other entries are saved at most this late
  urgentKinds: readonly string[];
}

const INDEX_KEY = 'debug:journal:index';
const ENABLED_KEY = 'debug:journal:enabled'; // remembered, so a restart records from app-start on
const LEGACY_KEY = 'debug:journal'; // whole journal in one key, written by the first debug build
const chunkKey = (start: number) => `debug:journal:${start}`;

export class DebugJournal implements Journal {
  private readonly chunks = new Map<number, JournalEntry[]>();
  private readonly dirty = new Set<number>();
  private readonly removed = new Set<number>();
  private readonly store: JournalStore;
  private readonly timers: Pick<TimerApi, 'setTimeout'>;
  private readonly config: JournalConfig;
  private readonly logger: Logger;
  private readonly now: () => number;
  private enabled = false;
  private urgentScheduled = false;
  private persistScheduled = false;

  constructor(store: JournalStore, timers: Pick<TimerApi, 'setTimeout'>, config: JournalConfig, logger: Logger, now: () => number = Date.now) {
    this.store = store;
    this.timers = timers;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.load();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Switches recording on or off; switching off deletes every saved chunk. Never throws. */
  setEnabled(enabled: boolean): void {
    try {
      if (enabled === this.enabled) return;
      this.enabled = enabled;
      this.store.set(ENABLED_KEY, enabled);
      if (!enabled) this.clear();
    } catch (error) {
      this.logger.error('[journal] switching failed:', error);
    }
  }

  add(kind: string, fields: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      const at = this.now();
      const start = at - (at % this.config.chunkMs);
      const chunk = this.chunks.get(start) ?? [];
      chunk.push({ at, kind, ...fields });
      if (chunk.length > this.config.maxEntriesPerChunk) chunk.splice(0, chunk.length - this.config.maxEntriesPerChunk);
      this.chunks.set(start, chunk);
      this.dirty.add(start);
      this.dropExpired(at);
      this.schedule(this.config.urgentKinds.includes(kind));
    } catch (error) {
      this.logger.error('[journal] add failed:', error);
    }
  }

  list(since: number): JournalEntry[] {
    return [...this.chunks.keys()].sort((a, b) => a - b)
      .flatMap((start) => this.chunks.get(start) ?? [])
      .filter((entry) => entry.at >= since);
  }

  /** Writes the changed chunks and the index; never throws. */
  persist(): void {
    try {
      // Order against a power loss between the writes: a removed chunk goes before the index stops
      // listing it, a new chunk only after the index lists it. A listed key that was never written
      // is skipped on load; a written key that no index lists could never be found again.
      for (const start of this.removed) this.store.unset(chunkKey(start));
      if (this.dirty.size > 0 || this.removed.size > 0) this.store.set(INDEX_KEY, [...this.chunks.keys()]);
      for (const start of this.dirty) this.store.set(chunkKey(start), this.chunks.get(start) ?? []);
      this.dirty.clear();
      this.removed.clear();
    } catch (error) {
      this.logger.error('[journal] persist failed:', error);
    }
  }

  private clear(): void {
    for (const start of this.chunks.keys()) this.store.unset(chunkKey(start));
    const index = this.store.get(INDEX_KEY);
    if (Array.isArray(index)) for (const start of index) if (typeof start === 'number') this.store.unset(chunkKey(start));
    this.store.unset(INDEX_KEY);
    this.chunks.clear();
    this.dirty.clear();
    this.removed.clear();
  }

  private load(): void {
    try {
      if (this.store.get(LEGACY_KEY) !== null) this.store.unset(LEGACY_KEY);
      this.enabled = this.store.get(ENABLED_KEY) === true;
      if (!this.enabled) {
        this.clear();
        return;
      }
      const index = this.store.get(INDEX_KEY);
      if (!Array.isArray(index)) return;
      for (const start of index) {
        const chunk = this.store.get(chunkKey(start));
        if (typeof start === 'number' && Array.isArray(chunk)) this.chunks.set(start, chunk as JournalEntry[]);
      }
      this.dropExpired(this.now());
    } catch (error) {
      this.logger.error('[journal] load failed:', error);
    }
  }

  /** Only chunks that start before the cutoff can hold expired entries; newer ones are skipped. */
  private dropExpired(now: number): void {
    const oldest = now - this.config.retentionMs;
    for (const [start, chunk] of this.chunks) {
      if (start >= oldest) continue;
      const kept = start + this.config.chunkMs <= oldest ? [] : chunk.filter((entry) => entry.at >= oldest);
      if (kept.length === 0) {
        this.chunks.delete(start);
        this.dirty.delete(start);
        this.removed.add(start);
      } else if (kept.length !== chunk.length) {
        this.chunks.set(start, kept);
        this.dirty.add(start);
      }
    }
  }

  private schedule(urgent: boolean): void {
    if (urgent && !this.urgentScheduled) {
      this.urgentScheduled = true;
      this.timers.setTimeout(() => {
        this.urgentScheduled = false;
        this.persist();
      }, this.config.urgentDelayMs);
    } else if (!urgent && !this.persistScheduled) {
      this.persistScheduled = true;
      this.timers.setTimeout(() => {
        this.persistScheduled = false;
        this.persist();
      }, this.config.persistDelayMs);
    }
  }
}
