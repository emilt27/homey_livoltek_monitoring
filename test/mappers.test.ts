import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batteryCapabilities, gridCapabilities, inverterCapabilities } from '../lib/devices/mappers';
import { GridState } from '../lib/grid/GridStateEstimator';
import { SiteValues } from '../lib/powerflow/outputs';
import { SiteSnapshot } from '../lib/site/SiteMonitor';

function snapshot(values: Partial<SiteValues>, state: GridState = 'on'): SiteSnapshot {
  return {
    dataTimestamp: 1,
    fresh: true,
    sample: {
      dataTimestamp: 1, gridW: null, loadW: null, batteryW: null, pvW: 0, soc: null, energyStatus: null,
    },
    values: {
      gridImportW: 493, loadW: 42, batteryW: 263, soc: 95, batteryStatus: 'charging', ...values,
    },
    grid: {
      state, changed: false, evidence: { kind: 'on-certain' }, reason: '',
    },
    energy: { gridImportedKWh: 1.4710833, batteryChargedKWh: 1.1987916, batteryDischargedKWh: 0.255625 },
  };
}

test('inverter: every known value (charge in its own capability, not the device-battery one), grid alarm on when off', () => {
  assert.deepEqual(inverterCapabilities(snapshot({}, 'on')), {
    measure_battery_soc: 95,
    measure_power_load: 42,
    measure_power_grid_import: 493,
    measure_power_battery_charge: 263,
    measure_power_battery_consumption: 0,
    battery_status: 'charging',
    alarm_grid: false,
  });
  assert.equal(inverterCapabilities(snapshot({ batteryW: -300 }, 'off')).measure_power_battery_consumption, 300);
  assert.equal(inverterCapabilities(snapshot({}, 'off')).alarm_grid, true);
});

test('inverter: unknown values and an unknown grid state are left out, so devices keep the previous value', () => {
  const values = inverterCapabilities(snapshot({
    gridImportW: null, loadW: null, batteryW: null, soc: null, batteryStatus: null,
  }, 'unknown'));

  assert.deepEqual(values, {});
});

test('battery: power (+ charging), charge and energy meters rounded to Wh', () => {
  assert.deepEqual(batteryCapabilities(snapshot({})), {
    measure_power: 263,
    measure_battery: 95,
    'meter_power.charged': 1.199,
    'meter_power.discharged': 0.256,
  });
});

test('grid: import power and the cumulative import meter', () => {
  assert.deepEqual(gridCapabilities(snapshot({})), {
    measure_power: 493,
    'meter_power.imported': 1.471,
  });
  assert.deepEqual(gridCapabilities(snapshot({ gridImportW: null })), { 'meter_power.imported': 1.471 });
});
