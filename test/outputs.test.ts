import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputFilter } from '../lib/powerflow/outputs';
import { DEFAULT_THRESHOLDS } from '../lib/grid/evidence';
import { GridState } from '../lib/grid/GridStateEstimator';
import { PowerSample } from '../lib/powerflow/sample';

function sample(values: Partial<PowerSample>): PowerSample {
  return {
    dataTimestamp: 1, gridW: null, loadW: 700, batteryW: 0, pvW: 0, soc: 99, energyStatus: null, ...values,
  };
}

function apply(filter: OutputFilter, values: Partial<PowerSample>, grid: GridState = 'on') {
  return filter.apply(sample(values), grid, DEFAULT_THRESHOLDS);
}

test('grid import is 0 while the grid is off, whatever the API reports', () => {
  assert.equal(apply(new OutputFilter(null), { gridW: 2488, loadW: 722, batteryW: -931 }, 'off').gridImportW, 0);
});

test('grid import uses the reported value only when it matches the balance', () => {
  assert.equal(apply(new OutputFilter(null), { gridW: 690, loadW: 703, batteryW: 0 }).gridImportW, 690);
  assert.equal(apply(new OutputFilter(null), { gridW: 0, loadW: 703, batteryW: 0 }).gridImportW, 703);
  assert.equal(apply(new OutputFilter(null), { gridW: null, loadW: 703, batteryW: 0 }).gridImportW, 703);
  assert.equal(apply(new OutputFilter(null), { gridW: 690, loadW: null, batteryW: 0 }).gridImportW, 690);
  assert.equal(apply(new OutputFilter(null), { gridW: null, loadW: null, batteryW: 0 }).gridImportW, null);
});

test('a sudden state-of-charge drop to 0 is held until the next point confirms it', () => {
  const filter = new OutputFilter(null);
  assert.equal(apply(filter, { soc: 99 }).soc, 99);

  assert.equal(apply(filter, { soc: 0 }).soc, 99);
  assert.equal(apply(filter, { soc: 99 }).soc, 99);

  apply(filter, { soc: 0 });
  assert.equal(apply(filter, { soc: 0 }).soc, 0, 'confirmed by the next point');
});

test('a drop of more than 20 points is held, normal changes pass immediately', () => {
  const filter = new OutputFilter(null);
  apply(filter, { soc: 90 });

  assert.equal(apply(filter, { soc: 65 }).soc, 90);
  assert.equal(apply(filter, { soc: 89 }).soc, 89);
  assert.equal(apply(filter, { soc: 97 }).soc, 97);
});

test('missing state of charge stays missing', () => {
  assert.equal(apply(new OutputFilter(null), { soc: null }).soc, null);
});

test('battery status comes from battery power, the status text is only a fallback', () => {
  const filter = new OutputFilter(null);

  assert.equal(apply(filter, { batteryW: 2700, energyStatus: 'idel' }).batteryStatus, 'charging');
  assert.equal(apply(filter, { batteryW: -300, energyStatus: 'idel' }).batteryStatus, 'discharging');
  assert.equal(apply(filter, { batteryW: 10, energyStatus: 'discharging' }).batteryStatus, 'idle');
  assert.equal(apply(filter, { batteryW: null, energyStatus: 'discharging' }).batteryStatus, 'discharging');
  assert.equal(apply(filter, { batteryW: null, energyStatus: 'idel' }).batteryStatus, null);
});

test('state survives a JSON round trip', () => {
  const filter = new OutputFilter(null);
  apply(filter, { soc: 99 });
  apply(filter, { soc: 0 });

  const restored = new OutputFilter(JSON.parse(JSON.stringify(filter.toJSON())));

  assert.equal(apply(restored, { soc: 0 }).soc, 0);
});
