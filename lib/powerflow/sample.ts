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
    soc: parseNumber(raw.energySoc),
    energyStatus: parseStatus(raw.energyStatus),
  };
}

/**
 * The API publishes a new point incomplete and fills it in within ~30 s: later reads of the
 * same point only fill the fields that were still missing.
 */
export function mergeSample(earlier: PowerSample, later: PowerSample): PowerSample {
  return {
    dataTimestamp: earlier.dataTimestamp,
    gridW: earlier.gridW ?? later.gridW,
    loadW: earlier.loadW ?? later.loadW,
    batteryW: earlier.batteryW ?? later.batteryW,
    pvW: earlier.pvW ?? later.pvW,
    soc: earlier.soc ?? later.soc,
    energyStatus: earlier.energyStatus ?? later.energyStatus,
  };
}

export function isComplete(sample: PowerSample): boolean {
  return sample.loadW !== null && sample.batteryW !== null && sample.soc !== null;
}
