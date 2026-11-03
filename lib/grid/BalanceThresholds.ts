import { DEFAULT_THRESHOLDS, Thresholds } from './evidence';

export interface BalanceState {
  offMeanW: number; // average balance while the grid is off: minus the inverter's own consumption
}

/** Measured on the user's Hyper-6000 on 2026-11-03. */
const INITIAL_OFF_MEAN_W = -176;
const LEARNING_RATE = 0.1;
const OFF_THRESHOLD_RANGE = { min: -200, max: -30 };

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Adapts the "grid off" balance threshold to the inverter model. Only the off side is learned:
 * learning the on side from points that already passed the on threshold would confirm itself.
 */
export class BalanceThresholds {
  private offMeanW: number;

  constructor(state: BalanceState | null) {
    this.offMeanW = state?.offMeanW ?? INITIAL_OFF_MEAN_W;
  }

  /** Called for discharging points while the grid is off, whatever evidence put it off. */
  observeOff(balance: number): void {
    this.offMeanW += LEARNING_RATE * (balance - this.offMeanW);
  }

  current(): Pick<Thresholds, 'offBalanceW' | 'onBalanceW'> {
    const half = round1(this.offMeanW / 2);
    return {
      offBalanceW: Math.min(OFF_THRESHOLD_RANGE.max, Math.max(OFF_THRESHOLD_RANGE.min, half)),
      onBalanceW: DEFAULT_THRESHOLDS.onBalanceW,
    };
  }

  toJSON(): BalanceState {
    return { offMeanW: this.offMeanW };
  }
}
