import { SiteValues } from '../powerflow/outputs';

export interface EnergyTotals {
  gridImportedKWh: number;
  batteryChargedKWh: number;
  batteryDischargedKWh: number;
}

interface LastPoint {
  at: number;
  gridW: number;
  batteryW: number;
}

export interface EnergyMeterState {
  totals: EnergyTotals;
  last: LastPoint | null;
}

const MS_PER_HOUR = 3_600_000;

const ZERO: EnergyTotals = { gridImportedKWh: 0, batteryChargedKWh: 0, batteryDischargedKWh: 0 };

/** kWh between two points from the average of their powers (trapezoidal rule). */
function trapezoidKWh(fromW: number, toW: number, ms: number): number {
  return ((fromW + toW) / 2 / 1000) * (ms / MS_PER_HOUR);
}

/**
 * Cumulative kWh counters from the 5-minute data points. Gaps longer than maxGapMs (Homey or the
 * inverter offline) and points with unknown values are not bridged, so no energy is invented.
 */
export class EnergyMeter {
  private readonly maxGapMs: number;
  private readonly totals: EnergyTotals;
  private last: LastPoint | null;

  constructor(state: EnergyMeterState | null, maxGapMs: number) {
    this.maxGapMs = maxGapMs;
    this.totals = { ...(state?.totals ?? ZERO) };
    this.last = state?.last ?? null;
  }

  add(dataTimestamp: number, values: SiteValues): EnergyTotals {
    const { gridImportW, batteryW } = values;
    if (gridImportW === null || batteryW === null) {
      this.last = null;
      return { ...this.totals };
    }
    if (this.last !== null && dataTimestamp <= this.last.at) return { ...this.totals };

    const { last } = this;
    if (last !== null && dataTimestamp - last.at <= this.maxGapMs) {
      const ms = dataTimestamp - last.at;
      this.totals.gridImportedKWh += trapezoidKWh(Math.max(0, last.gridW), Math.max(0, gridImportW), ms);
      this.totals.batteryChargedKWh += trapezoidKWh(Math.max(0, last.batteryW), Math.max(0, batteryW), ms);
      this.totals.batteryDischargedKWh += trapezoidKWh(Math.max(0, -last.batteryW), Math.max(0, -batteryW), ms);
    }
    this.last = { at: dataTimestamp, gridW: gridImportW, batteryW };
    return { ...this.totals };
  }

  /**
   * Raises totals to the meter values a device already shows (its own write survived a lost
   * settings write, or the settings were reset), so the next published value never decreases.
   * Totals are published rounded to 3 decimals; only a lower published value counts.
   */
  raiseFloor(floor: Partial<EnergyTotals>): boolean {
    let raised = false;
    for (const key of Object.keys(floor) as Array<keyof EnergyTotals>) {
      const value = floor[key];
      if (typeof value === 'number' && Number.isFinite(value) && Math.round(this.totals[key] * 1000) < Math.round(value * 1000)) {
        this.totals[key] = value;
        raised = true;
      }
    }
    return raised;
  }

  toJSON(): EnergyMeterState {
    return { totals: { ...this.totals }, last: this.last };
  }
}
