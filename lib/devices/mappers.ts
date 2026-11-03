import { SiteSnapshot } from '../site/SiteMonitor';

/** Capability id -> value. A capability missing here keeps its previous value on the device. */
export type CapabilityValues = Record<string, number | boolean | string>;

const roundKWh = (kWh: number) => Math.round(kWh * 1000) / 1000;

function withoutUnknown(values: Record<string, number | boolean | string | null>): CapabilityValues {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)) as CapabilityValues;
}

/**
 * The inverter shows the charge in measure_battery_soc: the system measure_battery would make
 * Homey treat the inverter as a battery-powered device (it requires energy.batteries).
 */
export function inverterCapabilities({ values, grid }: SiteSnapshot): CapabilityValues {
  return withoutUnknown({
    measure_battery_soc: values.soc,
    measure_power_load: values.loadW,
    measure_power_grid_import: values.gridImportW,
    measure_power_battery_charge: values.batteryW,
    measure_power_battery_consumption: values.batteryW === null ? null : Math.max(0, -values.batteryW),
    battery_status: values.batteryStatus,
    alarm_grid: grid.state === 'unknown' ? null : grid.state === 'off',
  });
}

/** Homey home battery: measure_power is + while charging, − while discharging. */
export function batteryCapabilities({ values, energy }: SiteSnapshot): CapabilityValues {
  return withoutUnknown({
    measure_power: values.batteryW,
    measure_battery: values.soc,
    'meter_power.charged': roundKWh(energy.batteryChargedKWh),
    'meter_power.discharged': roundKWh(energy.batteryDischargedKWh),
  });
}

/** Homey cumulative grid meter: measure_power is the import power. */
export function gridCapabilities({ values, energy }: SiteSnapshot): CapabilityValues {
  return withoutUnknown({
    measure_power: values.gridImportW,
    'meter_power.imported': roundKWh(energy.gridImportedKWh),
  });
}
