import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyMeter, EnergyTotals } from '../lib/energy/EnergyMeter';
import { SiteValues } from '../lib/powerflow/outputs';

const MINUTE = 60_000;
const MAX_GAP = 11 * MINUTE;

function values(gridImportW: number | null, batteryW: number | null): SiteValues {
  return {
    gridImportW, loadW: 100, batteryW, soc: 90, batteryStatus: null,
  };
}

function assertTotals(actual: EnergyTotals, expected: EnergyTotals): void {
  for (const key of Object.keys(expected) as Array<keyof EnergyTotals>) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} != ${expected[key]}`);
  }
}

test('integrates grid import with the trapezoidal rule between data points', () => {
  const meter = new EnergyMeter(null, MAX_GAP);

  meter.add(0, values(1200, 0));
  const totals = meter.add(5 * MINUTE, values(1200, 0));

  assertTotals(totals, { gridImportedKWh: 0.1, batteryChargedKWh: 0, batteryDischargedKWh: 0 });
});

test('a ramp counts the average of both points', () => {
  const meter = new EnergyMeter(null, MAX_GAP);

  meter.add(0, values(0, 0));

  assertTotals(meter.add(5 * MINUTE, values(1200, 0)), {
    gridImportedKWh: 0.05, batteryChargedKWh: 0, batteryDischargedKWh: 0,
  });
});

test('battery charge and discharge are counted separately', () => {
  const meter = new EnergyMeter(null, MAX_GAP);

  meter.add(0, values(0, 600));
  meter.add(5 * MINUTE, values(0, 600));
  const totals = meter.add(10 * MINUTE, values(0, -600));

  assertTotals(totals, { gridImportedKWh: 0, batteryChargedKWh: 0.075, batteryDischargedKWh: 0.025 });
});

test('a gap longer than the limit is not integrated (Homey or the inverter was off)', () => {
  const meter = new EnergyMeter(null, MAX_GAP);

  meter.add(0, values(1200, -1360));
  const totals = meter.add(8 * 60 * MINUTE, values(1200, -1360));

  assertTotals(totals, { gridImportedKWh: 0, batteryChargedKWh: 0, batteryDischargedKWh: 0 });
});

test('a point with unknown values breaks the integration instead of bridging over it', () => {
  const meter = new EnergyMeter(null, MAX_GAP);

  meter.add(0, values(1200, 0));
  meter.add(5 * MINUTE, values(null, 0));
  const totals = meter.add(10 * MINUTE, values(1200, 0));

  assertTotals(totals, { gridImportedKWh: 0, batteryChargedKWh: 0, batteryDischargedKWh: 0 });
});

test('repeated or older data points are not counted twice', () => {
  const meter = new EnergyMeter(null, MAX_GAP);

  meter.add(0, values(1200, 0));
  meter.add(5 * MINUTE, values(1200, 0));
  meter.add(5 * MINUTE, values(1200, 0));
  const totals = meter.add(MINUTE, values(1200, 0));

  assertTotals(totals, { gridImportedKWh: 0.1, batteryChargedKWh: 0, batteryDischargedKWh: 0 });
});

test('state survives a JSON round trip and integration continues', () => {
  const meter = new EnergyMeter(null, MAX_GAP);
  meter.add(0, values(1200, 0));
  meter.add(5 * MINUTE, values(1200, 0));

  const restored = new EnergyMeter(JSON.parse(JSON.stringify(meter.toJSON())), MAX_GAP);

  assertTotals(restored.add(10 * MINUTE, values(1200, 0)), {
    gridImportedKWh: 0.2, batteryChargedKWh: 0, batteryDischargedKWh: 0,
  });
});

test('a floor raises only totals whose published (3-decimal) value is below it', () => {
  const meter = new EnergyMeter({
    totals: { gridImportedKWh: 3.1098, batteryChargedKWh: 1, batteryDischargedKWh: 0.2 },
    last: null,
  }, MAX_GAP);

  assert.equal(meter.raiseFloor({ gridImportedKWh: 3.11, batteryChargedKWh: 1.5 }), true);

  assertTotals(meter.toJSON().totals, { gridImportedKWh: 3.1098, batteryChargedKWh: 1.5, batteryDischargedKWh: 0.2 });
  assert.equal(meter.raiseFloor({ batteryDischargedKWh: 0.1 }), false, 'a lower floor changes nothing');
});
