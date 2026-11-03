import { EnergyMeter, EnergyMeterState, EnergyTotals } from '../energy/EnergyMeter';
import { DEFAULT_THRESHOLDS } from '../grid/evidence';
import { EstimatorState, GridDecision, GridStateEstimator } from '../grid/GridStateEstimator';
import { Logger, RawPowerFlow } from '../LivoltekAPI';
import { Poller, TimerApi } from '../Poller';
import { OutputFilter, OutputState, SiteValues } from '../powerflow/outputs';
import {
  isComplete, mergeSample, normalizeSample, PowerSample,
} from '../powerflow/sample';
import { DEFAULT_SCHEDULE, nextPollDelayMs } from './schedule';

export interface PowerFlowSource {
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
}

export interface PersistedSiteState {
  estimator: EstimatorState;
  outputs: OutputState;
  energy: EnergyMeterState;
}

export interface SiteStateStore {
  load(): PersistedSiteState | null;
  save(state: PersistedSiteState): void;
}

/** No new data point for this long means the inverter or its cloud link is offline. */
const STALE_AFTER_MS = 12 * 60_000;
/** One missing 5-minute point is bridged by the energy meter, a longer gap is not. */
const ENERGY_MAX_GAP_MS = 11 * 60_000;

/**
 * Polls one Livoltek site for all devices that show it: one request per cycle, one grid state,
 * one set of energy counters. Each data point is processed once, as soon as load, battery and
 * state of charge are known; later reads of the same point only refresh the published values.
 */
export class SiteMonitor {
  private readonly siteId: string;
  private source: PowerFlowSource;
  private readonly store: SiteStateStore;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly poller: Poller;
  private readonly subscribers = new Set<SiteSubscriber>();
  private readonly estimator: GridStateEstimator;
  private readonly outputs: OutputFilter;
  private readonly energy: EnergyMeter;
  private current: PowerSample | null = null; // latest data point, merged over its reads
  private currentResult: SiteSnapshot | null = null; // null until the current point is processed
  private lastSnapshot: SiteSnapshot | null = null;
  private staleReported = false;

  constructor(
    siteId: string,
    source: PowerFlowSource,
    timers: TimerApi,
    store: SiteStateStore,
    logger: Logger,
    now: () => number = Date.now,
  ) {
    this.siteId = siteId;
    this.source = source;
    this.store = store;
    this.logger = logger;
    this.now = now;
    const state = store.load();
    this.estimator = new GridStateEstimator(state?.estimator ?? null);
    this.outputs = new OutputFilter(state?.outputs ?? null);
    this.energy = new EnergyMeter(state?.energy ?? null, ENERGY_MAX_GAP_MS);
    this.poller = new Poller(timers, () => this.poll(), (error) => this.logger.error(`[site ${siteId}] polling error:`, error));
  }

  /** Returns the unsubscribe function; the last unsubscribe stops polling. */
  subscribe(subscriber: SiteSubscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.subscribers.size === 1) {
      this.poller.start(() => this.nextDelayMs()).catch((error) => this.logger.error(error));
    } else if (this.lastSnapshot !== null) {
      this.deliver(subscriber, this.lastSnapshot).catch((error) => this.logger.error(error));
    }
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.poller.stop();
    };
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  setSource(source: PowerFlowSource): void {
    this.source = source;
  }

  private nextDelayMs(): number {
    const complete = this.currentResult !== null && this.current?.gridW !== null;
    return nextPollDelayMs(this.now(), this.current?.dataTimestamp ?? null, complete, DEFAULT_SCHEDULE);
  }

  private async poll(): Promise<void> {
    let raw: RawPowerFlow | null;
    try {
      raw = await this.source.getCurrentPowerFlow(this.siteId);
    } catch (error) {
      await this.broadcastUnavailable(error instanceof Error ? error.message : String(error));
      return;
    }

    const sample = normalizeSample(raw);
    if (sample !== null) await this.accept(sample);
    await this.checkStale();
  }

  private async accept(read: PowerSample): Promise<void> {
    const { current } = this;
    if (current !== null && read.dataTimestamp < current.dataTimestamp) return;

    if (current !== null && read.dataTimestamp === current.dataTimestamp) {
      const merged = mergeSample(current, read);
      if (JSON.stringify(merged) === JSON.stringify(current)) return;
      this.current = merged;
    } else {
      this.current = read;
      this.currentResult = null;
    }

    if (!isComplete(this.current)) return;
    const snapshot = this.currentResult === null ? this.process(this.current) : this.refresh(this.current, this.currentResult);
    this.currentResult = snapshot;
    this.lastSnapshot = snapshot;
    this.staleReported = false;
    await Promise.all([...this.subscribers].map((subscriber) => this.deliver(subscriber, snapshot)));
  }

  /** First complete read of a data point: the only time it feeds the estimator and the energy meter. */
  private process(sample: PowerSample): SiteSnapshot {
    const grid = this.estimator.update(sample);
    const values = this.outputs.apply(sample, grid.state, DEFAULT_THRESHOLDS);
    const energy = this.energy.add(sample.dataTimestamp, values);
    this.store.save({ estimator: this.estimator.toJSON(), outputs: this.outputs.toJSON(), energy: this.energy.toJSON() });

    this.logger.log(`[site ${this.siteId}] point ${new Date(sample.dataTimestamp).toISOString()}: grid ${grid.state}`
      + ` (${grid.reason}), load ${values.loadW} W, battery ${values.batteryW} W, soc ${values.soc} %`);
    return {
      dataTimestamp: sample.dataTimestamp, fresh: true, sample, values, grid, energy,
    };
  }

  /** A later read of an already processed point that filled in missing fields. */
  private refresh(sample: PowerSample, processed: SiteSnapshot): SiteSnapshot {
    const values = this.outputs.refresh(sample, processed.grid.state, DEFAULT_THRESHOLDS, processed.values);
    return {
      ...processed, fresh: false, sample, values,
    };
  }

  private async deliver(subscriber: SiteSubscriber, snapshot: SiteSnapshot): Promise<void> {
    try {
      await subscriber.onSnapshot(snapshot);
    } catch (error) {
      this.logger.error(`[site ${this.siteId}] subscriber failed:`, error);
    }
  }

  private async checkStale(): Promise<void> {
    const latest = this.lastSnapshot?.dataTimestamp;
    if (latest === undefined || this.staleReported || this.now() - latest <= STALE_AFTER_MS) return;
    this.staleReported = true;
    await this.broadcastUnavailable('No fresh data from Livoltek for more than 12 minutes');
  }

  private async broadcastUnavailable(reason: string): Promise<void> {
    this.logger.error(`[site ${this.siteId}] unavailable: ${reason}`);
    await Promise.all([...this.subscribers].map(async (subscriber) => {
      try {
        await subscriber.onUnavailable(reason);
      } catch (error) {
        this.logger.error(`[site ${this.siteId}] subscriber failed:`, error);
      }
    }));
  }
}
