import { RawPowerFlow } from '../LivoltekAPI';

/**
 * One Livoltek data point normalized to watts. A null field means the API did not deliver
 * a usable value for it (null, "null", "", NaN...), never "zero".
 */
export interface PowerSample {
  dataTimestamp: number;
  gridW: number | null;
  loadW: number | null;
  batteryW: number | null; // + charging, − discharging
  pvW: number | null;
  soc: number | null;
  energyStatus: string | null; // lowercased, e.g. "discharging", "idel"
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value + 0 : null; // + 0 turns −0 into 0
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed + 0 : null;
}

function kwToW(value: unknown): number | null {
  const kw = parseNumber(value);
  return kw === null ? null : Math.round(kw * 1000) + 0;
}

/**
 * A state of charge of 0 is the placeholder of an incomplete record (recorded 2026-11-03: the first
 * read of a new point has SoC 0, the full record ~30 s later the real value). A real 0 % does not
 * occur: the inverter shuts down at its discharge cut-off around 10 %.
 */
function parseSoc(value: unknown): number | null {
  const soc = parseNumber(value);
  return soc === 0 ? null : soc;
}

function parseStatus(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const status = value.trim().toLowerCase();
  return status === '' || status === 'null' ? null : status;
}

/**
 * Returns null when the API delivered no data object or no usable data timestamp:
 * without the timestamp a point cannot be told apart from a repeated or stale one.
 */
export function normalizeSample(raw: RawPowerFlow | null): PowerSample | null {
  if (raw === null) return null;
  const dataTimestamp = parseNumber(raw.timestamp);
  if (dataTimestamp === null) return null;

  return {
    dataTimestamp,
    gridW: kwToW(raw.powerGridPower),
    loadW: kwToW(raw.loadPower),
    batteryW: kwToW(raw.energyPower),
    pvW: kwToW(raw.pvPower),
    soc: parseSoc(raw.energySoc),
    energyStatus: parseStatus(raw.energyStatus),
  };
}

/**
 * The API publishes a new point as a placeholder (fields missing, status "idel") and the full
 * record ~30 s later: values of the later read win, fields it still misses keep the earlier value.
 */
export function mergeSample(earlier: PowerSample, later: PowerSample): PowerSample {
  return {
    dataTimestamp: earlier.dataTimestamp,
    gridW: later.gridW ?? earlier.gridW,
    loadW: later.loadW ?? earlier.loadW,
    batteryW: later.batteryW ?? earlier.batteryW,
    pvW: later.pvW ?? earlier.pvW,
    soc: later.soc ?? earlier.soc,
    energyStatus: later.energyStatus ?? earlier.energyStatus,
  };
}

/** Statuses that only real records carry; placeholders have "idel" or none. */
const REAL_STATUSES: readonly string[] = ['charging', 'discharging', 'importing'];

/**
 * A point can be decided once load and battery power are known and the read is not a placeholder:
 * it has a state of charge or a real status. The API often reports SoC 0 for a real record
 * (32 of 78 points on 2026-11-03/04, one point never got it); the charge is then re-read
 * separately and devices keep the previous one meanwhile.
 */
function hasRealStatus(sample: PowerSample): boolean {
  return sample.energyStatus !== null && REAL_STATUSES.includes(sample.energyStatus);
}

/** A read that carries neither a state of charge nor a real status: the API's placeholder shape. */
export function isPlaceholder(sample: PowerSample): boolean {
  return sample.soc === null && !hasRealStatus(sample);
}

export function isComplete(sample: PowerSample): boolean {
  if (sample.loadW === null || sample.batteryW === null) return false;
  return !isPlaceholder(sample);
}
