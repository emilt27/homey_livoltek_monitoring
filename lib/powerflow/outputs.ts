import { balanceW, gridMatches, Thresholds } from '../grid/evidence';
import { GridState } from '../grid/GridStateEstimator';
import { PowerSample } from './sample';

export type BatteryStatus = 'charging' | 'discharging' | 'idle';

/** Values published to devices. null means "unknown, keep the previous capability value". */
export interface SiteValues {
  gridImportW: number | null;
  loadW: number | null;
  batteryW: number | null;
  soc: number | null;
  batteryStatus: BatteryStatus | null;
}

export interface OutputState {
  lastSoc: number | null;
  pendingSoc: number | null;
}

const STATUS_TEXTS: readonly string[] = ['charging', 'discharging', 'idle'];

/**
 * Turns a sample into published values: no grid import while the grid is off (the API keeps a
 * frozen value), and a suspicious large state-of-charge drop only after the next point repeats it.
 */
export class OutputFilter {
  private lastSoc: number | null;
  private pendingSoc: number | null;

  constructor(state: OutputState | null) {
    this.lastSoc = state?.lastSoc ?? null;
    this.pendingSoc = state?.pendingSoc ?? null;
  }

  apply(sample: PowerSample, grid: GridState, t: Thresholds): SiteValues {
    return {
      gridImportW: OutputFilter.gridImport(sample, grid, t),
      loadW: sample.loadW,
      batteryW: sample.batteryW,
      soc: this.filterSoc(sample.soc, t),
      batteryStatus: OutputFilter.batteryStatus(sample, t),
    };
  }

  /**
   * Values for a later read of an already processed point: recomputes what depends only on this
   * read and keeps the state of charge decided for the point, so a repeated read confirms nothing.
   * A point processed without a state of charge takes it from the first read that has one.
   */
  refresh(sample: PowerSample, grid: GridState, t: Thresholds, processed: SiteValues): SiteValues {
    return {
      gridImportW: OutputFilter.gridImport(sample, grid, t),
      loadW: sample.loadW,
      batteryW: sample.batteryW,
      soc: processed.soc ?? this.filterSoc(sample.soc, t),
      batteryStatus: OutputFilter.batteryStatus(sample, t),
    };
  }

  toJSON(): OutputState {
    return { lastSoc: this.lastSoc, pendingSoc: this.pendingSoc };
  }

  private static gridImport(sample: PowerSample, grid: GridState, t: Thresholds): number | null {
    if (grid === 'off') return 0;
    const balance = balanceW(sample);
    if (balance === null) return sample.gridW;
    if (sample.gridW !== null && gridMatches(sample.gridW, balance, t)) return sample.gridW;
    return Math.max(0, balance);
  }

  private static batteryStatus(sample: PowerSample, t: Thresholds): BatteryStatus | null {
    if (sample.batteryW !== null) {
      if (sample.batteryW >= t.smallDischargeW) return 'charging';
      if (sample.batteryW <= -t.smallDischargeW) return 'discharging';
      return 'idle';
    }
    const status = sample.energyStatus;
    return status !== null && STATUS_TEXTS.includes(status) ? status as BatteryStatus : null;
  }

  private filterSoc(soc: number | null, t: Thresholds): number | null {
    if (soc === null) return null;
    const suspicious = this.lastSoc !== null && this.lastSoc - soc > t.maxSocDrop;
    if (suspicious && this.pendingSoc !== soc) {
      this.pendingSoc = soc;
      return this.lastSoc;
    }
    this.lastSoc = soc;
    this.pendingSoc = null;
    return soc;
  }
}
