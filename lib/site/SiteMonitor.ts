import { Journal, NO_JOURNAL } from '../debug/DebugJournal';
import { EnergyMeter, EnergyMeterState, EnergyTotals } from '../energy/EnergyMeter';
import { DEFAULT_THRESHOLDS } from '../grid/evidence';
import { EstimatorState, GridDecision, GridStateEstimator } from '../grid/GridStateEstimator';
import { Logger, RawPowerFlow } from '../LivoltekAPI';
import LivoltekAuthError from '../LivoltekAuthError';
import { Poller, TimerApi } from '../Poller';
import { OutputFilter, OutputState, SiteValues } from '../powerflow/outputs';
import {
  isComplete, isPlaceholder, mergeSample, normalizeSample, PowerSample,
} from '../powerflow/sample';
import { restoreSiteState } from './restoreState';
import { DEFAULT_SCHEDULE, errorBackoffMs, nextPollDelayMs } from './schedule';

export interface PowerFlowSource {
  /** Throws LivoltekAuthError when the credentials are refused, any other error for a failed read. */
  getCurrentPowerFlow(siteId: string): Promise<RawPowerFlow | null>;
}

export interface SiteSnapshot {
  dataTimestamp: number;
  fresh: boolean; // first publication of this data point (false: a later read filled in missing fields)
  sample: PowerSample;
  values: SiteValues;
  grid: GridDecision;
  energy: EnergyTotals;
}

export interface SiteSubscriber {
  onSnapshot(snapshot: SiteSnapshot): Promise<void>;
  onUnavailable(reason: string): Promise<void>;
  /** The API keeps refusing the credentials: only a repair helps. Sent once per streak. */
  onAuthorizationFailed(reason: string): Promise<void>;
  /** Meter values the subscriber already shows; restored totals are raised to them on subscribe. */
  energyFloor?(): Partial<EnergyTotals>;
}

export interface PersistedSiteState {
  estimator: EstimatorState;
  outputs: OutputState;
  energy: EnergyMeterState;
}

export interface SiteStateStore {
  load(): unknown; // whatever was saved; validated by restoreSiteState

  save(state: PersistedSiteState): void;
}

/** No new data point for this long means the inverter or its cloud link is offline. */
const STALE_AFTER_MS = 12 * 60_000;
/**
 * Gaps up to two missing 5-minute points (the API sometimes never completes a point) are bridged
 * by the energy meter; a longer one (Homey or the inverter off) is not counted.
 */
const ENERGY_MAX_GAP_MS = 16 * 60_000;
/** Polls spent re-reading a processed point that still lacks the state of charge, 10 s apart. */
const SOC_RETRIES = 5;

/** A snapshot delivered again (late subscriber, recovery): not fresh and no grid change, so no flow fires twice. */
function asOld(snapshot: SiteSnapshot): SiteSnapshot {
  return { ...snapshot, fresh: false, grid: { ...snapshot.grid, changed: false } };
}

/**
 * Polls one Livoltek site for all devices that show it: one request per cycle, one grid state,
 * one set of energy counters. Each data point is processed once, as soon as load and battery are
 * known; later reads of the same point only refresh the published values. Deliveries to one
 * subscriber are strictly sequential, so a device never writes an older snapshot after a newer one.
 */
export class SiteMonitor {
  private readonly siteId: string;
  private source: PowerFlowSource;
  private readonly store: SiteStateStore;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly journal: Journal;
  private readonly poller: Poller;
  private readonly subscribers = new Set<SiteSubscriber>();
  private readonly deliveries = new Map<SiteSubscriber, Promise<void>>(); // tail of each subscriber's queue
  private readonly estimator: GridStateEstimator;
  private readonly outputs: OutputFilter;
  private readonly energy: EnergyMeter;
  private current: PowerSample | null = null; // latest data point, merged over its reads
  private currentResult: SiteSnapshot | null = null; // null until the current point is processed
  private lastSnapshot: SiteSnapshot | null = null;
  private staleReported = false;
  private socRetriesLeft = 0;
  private consecutiveErrors = 0;
  private authorizationReported = false;
  private unavailableReported = false; // devices were told the site is unavailable or refused
  private sourceGeneration = 0; // bumped by setSource, so a poll of the old source is ignored
  private nextDelay: () => number = () => this.nextDelayMs();

  constructor(
    siteId: string,
    source: PowerFlowSource,
    timers: TimerApi,
    store: SiteStateStore,
    logger: Logger,
    now: () => number = Date.now,
    journal: Journal = NO_JOURNAL,
  ) {
    this.siteId = siteId;
    this.source = source;
    this.store = store;
    this.logger = logger;
    this.now = now;
    this.journal = journal;
    const { state, problems } = restoreSiteState(this.loadSaved());
    for (const problem of problems) this.logger.error(`[site ${siteId}] saved state: ${problem}, starting it fresh`);
    this.estimator = new GridStateEstimator(state?.estimator ?? null);
    this.outputs = new OutputFilter(state?.outputs ?? null);
    this.energy = new EnergyMeter(state?.energy ?? null, ENERGY_MAX_GAP_MS);
    this.poller = new Poller(timers, () => this.poll(), (error) => this.logger.error(`[site ${siteId}] polling error:`, error));
  }

  /** Returns the unsubscribe function; the last unsubscribe stops polling. */
  subscribe(subscriber: SiteSubscriber): () => void {
    this.subscribers.add(subscriber);
    const floor = subscriber.energyFloor?.();
    if (floor !== undefined && this.energy.raiseFloor(floor)) this.saveState();

    if (this.subscribers.size === 1) {
      this.poller.start(this.nextDelay).catch((error) => this.logger.error(error));
    } else if (this.lastSnapshot !== null) {
      const snapshot = asOld(this.lastSnapshot);
      this.enqueue(subscriber, () => subscriber.onSnapshot(snapshot)).catch((error) => this.logger.error(error));
    }
    return () => {
      this.subscribers.delete(subscriber);
      this.deliveries.delete(subscriber);
      if (this.subscribers.size === 0) this.poller.stop();
    };
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Adds energy to the grid import and saves it at once (the daily compensation, see dailyExport.ts). */
  addImportedEnergy(kWh: number): EnergyTotals {
    const totals = this.energy.addGridImport(kWh);
    this.saveState();
    return totals;
  }

  /** New credentials (repair): forget the error streak and try them at once. */
  setSource(source: PowerFlowSource): void {
    this.source = source;
    this.sourceGeneration += 1;
    this.consecutiveErrors = 0;
    this.authorizationReported = false;
    if (this.subscribers.size > 0) this.poller.start(this.nextDelay).catch((error) => this.logger.error(error));
  }

  private waitingForSoc(): boolean {
    return this.currentResult?.values.soc === null && this.socRetriesLeft > 0;
  }

  private nextDelayMs(): number {
    // Grid power is not waited for: the API reports it as null for as long as the grid is off.
    const complete = this.currentResult !== null && !this.waitingForSoc();
    const scheduled = nextPollDelayMs(this.now(), this.current?.dataTimestamp ?? null, complete, DEFAULT_SCHEDULE);
    return Math.max(scheduled, errorBackoffMs(this.consecutiveErrors, DEFAULT_SCHEDULE));
  }

  private async poll(): Promise<void> {
    if (this.waitingForSoc()) this.socRetriesLeft -= 1; // every attempt counts, failed ones too

    const generation = this.sourceGeneration;
    let raw: RawPowerFlow | null;
    try {
      raw = await this.source.getCurrentPowerFlow(this.siteId);
    } catch (error) {
      if (generation !== this.sourceGeneration) return; // answer for credentials replaced meanwhile
      this.consecutiveErrors += 1;
      const reason = error instanceof Error ? error.message : String(error);
      this.record('read-error', { error: reason, consecutive: this.consecutiveErrors });
      if (error instanceof LivoltekAuthError) await this.reportAuthorizationFailure(reason);
      else await this.broadcastUnavailable(reason);
      return;
    }
    if (generation !== this.sourceGeneration) return;
    this.consecutiveErrors = 0;
    this.authorizationReported = false;
    const recovering = this.unavailableReported;
    this.unavailableReported = false;

    this.record('read', { raw });
    const sample = normalizeSample(raw);
    const delivered = sample !== null && await this.accept(sample);
    await this.checkStale();
    if (recovering && !delivered && !this.staleReported) await this.redeliverLast();
  }

  /**
   * After an error the devices are unavailable until a snapshot arrives; when the read that
   * recovers brings no new data, the last snapshot is delivered again. It is marked as not fresh
   * and not a grid change, so no flow fires twice for the same point.
   */
  private async redeliverLast(): Promise<void> {
    if (this.lastSnapshot === null) return;
    const snapshot = asOld(this.lastSnapshot);
    await Promise.all([...this.subscribers].map((subscriber) => this.enqueue(subscriber, () => subscriber.onSnapshot(snapshot))));
  }

  /** Returns whether a snapshot was delivered. */
  private async accept(read: PowerSample): Promise<boolean> {
    const { current } = this;
    if (current !== null && read.dataTimestamp < current.dataTimestamp) {
      this.record('older', { dataTimestamp: read.dataTimestamp });
      return false;
    }

    if (current !== null && read.dataTimestamp === current.dataTimestamp) {
      // Placeholders come first; one after real data (never seen in 1094 recorded reads) would
      // overwrite real load and battery values with its own, so it is ignored.
      if (isPlaceholder(read) && !isPlaceholder(current)) {
        this.record('placeholder-ignored', { sample: read });
        return false;
      }
      const merged = mergeSample(current, read);
      if (JSON.stringify(merged) === JSON.stringify(current)) {
        this.record('unchanged', { dataTimestamp: read.dataTimestamp });
        return false;
      }
      this.current = merged;
    } else {
      this.current = read;
      this.currentResult = null;
    }

    if (!isComplete(this.current)) {
      this.record('incomplete', { sample: this.current });
      return false;
    }
    const snapshot = this.currentResult === null ? this.process(this.current) : this.refresh(this.current, this.currentResult);
    this.currentResult = snapshot;
    this.lastSnapshot = snapshot;
    this.staleReported = false;
    await Promise.all([...this.subscribers].map((subscriber) => this.enqueue(subscriber, () => subscriber.onSnapshot(snapshot))));
    this.record(snapshot.fresh ? 'process' : 'refresh', {
      sample: snapshot.sample, grid: snapshot.grid, values: snapshot.values, energy: snapshot.energy,
    });
    return true;
  }

  /** First complete read of a data point: the only time it feeds the estimator and the energy meter. */
  private process(sample: PowerSample): SiteSnapshot {
    const grid = this.estimator.update(sample);
    const values = this.outputs.apply(sample, grid.state, DEFAULT_THRESHOLDS);
    this.socRetriesLeft = values.soc === null ? SOC_RETRIES : 0;
    const energy = this.energy.add(sample.dataTimestamp, values);
    this.saveState();

    this.logger.log(`[site ${this.siteId}] point ${new Date(sample.dataTimestamp).toISOString()}: grid ${grid.state}`
      + ` (${grid.reason}), load ${values.loadW} W, battery ${values.batteryW} W, soc ${values.soc} %`);
    return {
      dataTimestamp: sample.dataTimestamp, fresh: true, sample, values, grid, energy,
    };
  }

  /** A later read of an already processed point that filled in missing fields. */
  private refresh(sample: PowerSample, processed: SiteSnapshot): SiteSnapshot {
    const values = this.outputs.refresh(sample, processed.grid.state, DEFAULT_THRESHOLDS, processed.values);
    if (values.soc !== processed.values.soc) this.saveState(); // a late state of charge moved the SoC filter
    return {
      ...processed, fresh: false, sample, values,
    };
  }

  private loadSaved(): unknown {
    try {
      return this.store.load();
    } catch (error) {
      this.logger.error(`[site ${this.siteId}] saved state unreadable, starting fresh:`, error);
      return null;
    }
  }

  private saveState(): void {
    this.store.save({ estimator: this.estimator.toJSON(), outputs: this.outputs.toJSON(), energy: this.energy.toJSON() });
  }

  /** Runs a delivery after the subscriber's previous one; a failing delivery is logged, never thrown. */
  private enqueue(subscriber: SiteSubscriber, delivery: () => Promise<void>): Promise<void> {
    const previous = this.deliveries.get(subscriber) ?? Promise.resolve();
    const next = previous.then(delivery).catch((error) => this.logger.error(`[site ${this.siteId}] subscriber failed:`, error));
    if (this.subscribers.has(subscriber)) this.deliveries.set(subscriber, next);
    return next;
  }

  private async reportAuthorizationFailure(reason: string): Promise<void> {
    this.unavailableReported = true;
    if (this.authorizationReported) return;
    this.authorizationReported = true;
    this.logger.error(`[site ${this.siteId}] authorization failed: ${reason}`);
    await Promise.all([...this.subscribers].map((subscriber) => this.enqueue(subscriber, () => subscriber.onAuthorizationFailed(reason))));
  }

  private async checkStale(): Promise<void> {
    const latest = this.lastSnapshot?.dataTimestamp;
    if (latest === undefined || this.staleReported || this.now() - latest <= STALE_AFTER_MS) return;
    this.staleReported = true;
    await this.broadcastUnavailable('No fresh data from Livoltek for more than 12 minutes');
  }

  private async broadcastUnavailable(reason: string): Promise<void> {
    this.unavailableReported = true;
    this.logger.error(`[site ${this.siteId}] unavailable: ${reason}`);
    await Promise.all([...this.subscribers].map((subscriber) => this.enqueue(subscriber, () => subscriber.onUnavailable(reason))));
    this.record('unavailable', { reason });
  }

  /** Debug journal (lib/debug), a no-op while it is off; a failing journal never affects the monitor. */
  private record(kind: string, fields: Record<string, unknown>): void {
    try {
      this.journal.add(kind, { site: this.siteId, ...fields });
    } catch (error) {
      this.logger.error(`[site ${this.siteId}] journal failed:`, error);
    }
  }
}
