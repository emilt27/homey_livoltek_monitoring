import { EnergyMeterState, EnergyTotals } from '../energy/EnergyMeter';
import { LIKELY_OFF_SIGNALS, LikelyOffSignal } from '../grid/evidence';
import { RestoredEstimatorState } from '../grid/GridStateEstimator';
import { SignalTrust, TrustState } from '../grid/TrustModel';
import { OutputState } from '../powerflow/outputs';

/** The parts of a saved site state that passed validation; a missing part starts fresh. */
export interface RestoredSiteState {
  estimator?: RestoredEstimatorState;
  outputs?: OutputState;
  energy?: EnergyMeterState;
}

export interface RestoreResult {
  state: RestoredSiteState | null;
  problems: string[]; // one line per part that was dropped
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isNumberOrNull = (value: unknown) => value === null || isFinite(value);

function isSample(value: unknown): boolean {
  return isObject(value) && isFinite(value.dataTimestamp)
    && ['gridW', 'loadW', 'batteryW', 'pvW', 'soc'].every((field) => isNumberOrNull(value[field]))
    && (value.energyStatus === null || typeof value.energyStatus === 'string');
}

function isWeakPoint(value: unknown): boolean {
  return isObject(value) && isNumberOrNull(value.loadW) && isNumberOrNull(value.batteryW);
}

function isSignalTrust(value: unknown): value is SignalTrust {
  return isObject(value) && isFinite(value.confirmed) && value.confirmed >= 0
    && isFinite(value.refuted) && value.refuted >= 0 && typeof value.enabled === 'boolean';
}

function restoreEstimator(saved: unknown, problems: string[]): RestoredEstimatorState | undefined {
  if (!isObject(saved)) {
    problems.push('grid estimator is not an object');
    return undefined;
  }
  const restored: RestoredEstimatorState = {};

  const machineValid = ['on', 'off', 'unknown'].includes(saved.state as string)
    && (saved.lastSample === null || isSample(saved.lastSample))
    && (saved.pendingWeakOn === null || isWeakPoint(saved.pendingWeakOn))
    && (saved.pendingLikelyOff === null || LIKELY_OFF_SIGNALS.includes(saved.pendingLikelyOff as LikelyOffSignal));
  if (machineValid) {
    Object.assign(restored, {
      state: saved.state, lastSample: saved.lastSample, pendingWeakOn: saved.pendingWeakOn, pendingLikelyOff: saved.pendingLikelyOff,
    });
  } else {
    problems.push('grid state machine is invalid');
  }

  if (isObject(saved.trust)) {
    const trust: Partial<TrustState> = {};
    for (const signal of LIKELY_OFF_SIGNALS) {
      const entry = saved.trust[signal];
      if (isSignalTrust(entry)) trust[signal] = entry;
      else if (entry !== undefined) problems.push(`trust of signal ${signal} is invalid`);
    }
    restored.trust = trust;
  } else {
    problems.push('signal trust is invalid');
  }

  if (isObject(saved.balance) && isFinite(saved.balance.offMeanW)) restored.balance = { offMeanW: saved.balance.offMeanW };
  else problems.push('learned outage balance is invalid');

  return restored;
}

function restoreOutputs(saved: unknown, problems: string[]): OutputState | undefined {
  const isSoc = (value: unknown) => value === null || (isFinite(value) && value > 0 && value <= 100);
  if (isObject(saved) && isSoc(saved.lastSoc) && isSoc(saved.pendingSoc)) {
    return { lastSoc: saved.lastSoc as number | null, pendingSoc: saved.pendingSoc as number | null };
  }
  problems.push('state of charge filter is invalid');
  return undefined;
}

function restoreEnergy(saved: unknown, problems: string[]): EnergyMeterState | undefined {
  const totals = isObject(saved) ? saved.totals : undefined;
  const keys: Array<keyof EnergyTotals> = ['gridImportedKWh', 'batteryChargedKWh', 'batteryDischargedKWh'];
  if (!isObject(saved) || !isObject(totals) || !keys.every((key) => isFinite(totals[key]) && (totals[key] as number) >= 0)) {
    problems.push('energy totals are invalid');
    return undefined;
  }
  const restoredTotals = Object.fromEntries(keys.map((key) => [key, totals[key]])) as unknown as EnergyTotals;

  const { last } = saved;
  if (last === null || (isObject(last) && isFinite(last.at) && isFinite(last.gridW) && isFinite(last.batteryW))) {
    return { totals: restoredTotals, last: last === null ? null : { at: last.at as number, gridW: last.gridW as number, batteryW: last.batteryW as number } };
  }
  problems.push('last energy point is invalid');
  return { totals: restoredTotals, last: null };
}

/**
 * Validates a site state read back from app settings. Homey can lose power while it writes them
 * (unexpected reboots when the grid returns), so each part is checked on its own and only a
 * broken part is dropped; the rest of the learned state survives.
 */
export function restoreSiteState(saved: unknown): RestoreResult {
  if (saved === null || saved === undefined) return { state: null, problems: [] };
  if (!isObject(saved)) return { state: null, problems: ['saved site state is not an object'] };

  const problems: string[] = [];
  const state: RestoredSiteState = {};
  const estimator = restoreEstimator(saved.estimator, problems);
  const outputs = restoreOutputs(saved.outputs, problems);
  const energy = restoreEnergy(saved.energy, problems);
  if (estimator !== undefined) state.estimator = estimator;
  if (outputs !== undefined) state.outputs = outputs;
  if (energy !== undefined) state.energy = energy;
  return { state, problems };
}
