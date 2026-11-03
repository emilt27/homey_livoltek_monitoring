import { PowerSample } from '../powerflow/sample';

/**
 * What a single data point says about the grid. The inverter runs in UPS (backup) mode, where
 * the battery discharges only when the grid is gone, so battery power is the primary signal.
 * The reported grid power alone never decides anything: the API freezes it or returns 0 at random.
 */
export type LikelyOffSignal =
  | 'discharge-unknown-load' // battery discharging, load unknown
  | 'discharge-exceeds-balance' // battery discharging, yet the balance says the grid supplies power
  | 'small-discharge' // small discharge that still exceeds the load
  | 'status-or-soc-drop' // battery power unknown, status "discharging" or the charge dropped
  | 'grid-zero-idle-load'; // grid 0 while the battery is idle and the load is high

export const LIKELY_OFF_SIGNALS: readonly LikelyOffSignal[] = [
  'discharge-unknown-load',
  'discharge-exceeds-balance',
  'small-discharge',
  'status-or-soc-drop',
  'grid-zero-idle-load',
];

export type Evidence =
  | { kind: 'off-certain'; balanceW: number }
  | { kind: 'off-likely'; signal: LikelyOffSignal }
  | { kind: 'on-certain' }
  | { kind: 'on-weak'; balanceW: number }
  | { kind: 'conflict'; reason: string }
  | { kind: 'no-data'; reason: string };

export interface Thresholds {
  dischargeW: number; // battery power below −this is a discharge
  smallDischargeW: number; // |battery power| below this is idle
  offBalanceW: number; // balance at or below this means the battery also feeds the inverter itself
  onBalanceW: number; // balance at or above this means something else (the grid) feeds the load
  idleLoadW: number; // load that cannot be served by an idle battery
  pvPresentW: number; // PV power above this can charge the battery on its own
  gridMatchW: number; // reported grid agrees with the balance within max(this, ratio × balance)
  gridMatchRatio: number;
  maxSocDrop: number; // larger drops of the state of charge between points are treated as garbage
}

/** Measured on the user's Hyper-6000 on 2026-11-03 (inverter self-consumption −144…−209 W). */
export const DEFAULT_THRESHOLDS: Thresholds = {
  dischargeW: 100,
  smallDischargeW: 30,
  offBalanceW: -88,
  onBalanceW: 30,
  idleLoadW: 100,
  pvPresentW: 50,
  gridMatchW: 150,
  gridMatchRatio: 0.2,
  maxSocDrop: 20,
};

/** Power the battery and PV cannot account for: ≈ grid power minus the inverter's own consumption. */
export function balanceW(sample: PowerSample): number | null {
  if (sample.loadW === null || sample.batteryW === null) return null;
  return sample.loadW + sample.batteryW - (sample.pvW ?? 0);
}

export function gridMatches(gridW: number | null, balance: number, t: Thresholds): boolean {
  if (gridW === null) return true;
  return Math.abs(gridW - balance) <= Math.max(t.gridMatchW, t.gridMatchRatio * Math.abs(balance));
}

function socDropped(sample: PowerSample, previous: PowerSample | null, t: Thresholds): boolean {
  if (sample.soc === null || previous?.soc == null || sample.soc === 0) return false;
  const drop = previous.soc - sample.soc;
  return drop >= 1 && drop <= t.maxSocDrop;
}

function classifyUnknownBattery(sample: PowerSample, previous: PowerSample | null, t: Thresholds): Evidence {
  if (sample.energyStatus === 'discharging' || socDropped(sample, previous, t)) {
    return { kind: 'off-likely', signal: 'status-or-soc-drop' };
  }
  return { kind: 'no-data', reason: 'battery power unknown' };
}

function classifyDischarge(balance: number | null, t: Thresholds): Evidence {
  if (balance === null) return { kind: 'off-likely', signal: 'discharge-unknown-load' };
  if (balance <= t.offBalanceW) return { kind: 'off-certain', balanceW: balance };
  return { kind: 'off-likely', signal: 'discharge-exceeds-balance' };
}

function classifyCharge(sample: PowerSample, balance: number | null, t: Thresholds): Evidence {
  if ((sample.pvW ?? 0) <= t.pvPresentW) return { kind: 'on-certain' };
  if (balance === null) return { kind: 'no-data', reason: 'load unknown while PV charges the battery' };
  if (balance <= t.offBalanceW) return { kind: 'off-certain', balanceW: balance };
  if (balance >= t.onBalanceW) return { kind: 'on-weak', balanceW: balance };
  return { kind: 'conflict', reason: `PV charging with ambiguous balance ${balance} W` };
}

function classifyIdle(sample: PowerSample, balance: number | null, t: Thresholds): Evidence {
  if (balance === null) return { kind: 'no-data', reason: 'load unknown' };
  if (sample.gridW === 0 && sample.loadW !== null && sample.loadW >= t.idleLoadW) {
    return { kind: 'off-likely', signal: 'grid-zero-idle-load' };
  }
  if (balance < t.onBalanceW) return { kind: 'conflict', reason: `balance ${balance} W too low to tell` };
  if (!gridMatches(sample.gridW, balance, t)) {
    return { kind: 'conflict', reason: `grid ${sample.gridW} W does not match balance ${balance} W` };
  }
  return { kind: 'on-weak', balanceW: balance };
}

export function classify(sample: PowerSample, previous: PowerSample | null, t: Thresholds): Evidence {
  const battery = sample.batteryW;
  if (battery === null) return classifyUnknownBattery(sample, previous, t);

  const balance = balanceW(sample);
  if (battery <= -t.dischargeW) return classifyDischarge(balance, t);
  if (battery >= t.dischargeW) return classifyCharge(sample, balance, t);
  if (battery <= -t.smallDischargeW) {
    if (balance !== null && balance <= -t.smallDischargeW) return { kind: 'off-likely', signal: 'small-discharge' };
    return { kind: 'conflict', reason: `small discharge ${battery} W with balance ${balance} W` };
  }
  return classifyIdle(sample, balance, t);
}
