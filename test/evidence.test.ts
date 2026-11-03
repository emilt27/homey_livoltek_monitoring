import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceW, classify, DEFAULT_THRESHOLDS, Evidence,
} from '../lib/grid/evidence';
import { PowerSample } from '../lib/powerflow/sample';

function sample(values: Partial<PowerSample>): PowerSample {
  return {
    dataTimestamp: 1, gridW: null, loadW: null, batteryW: null, pvW: 0, soc: 90, energyStatus: null, ...values,
  };
}

function kind(evidence: Evidence): string {
  return evidence.kind === 'off-likely' ? `off-likely:${evidence.signal}` : evidence.kind;
}

test('balanceW is load + battery − pv, or null when load or battery is unknown', () => {
  assert.equal(balanceW(sample({ loadW: 722, batteryW: -931, pvW: 0 })), -209);
  assert.equal(balanceW(sample({ loadW: 100, batteryW: 500, pvW: 300 })), 300);
  assert.equal(balanceW(sample({ loadW: 100, batteryW: 500, pvW: null })), 600);
  assert.equal(balanceW(sample({ loadW: null, batteryW: -300 })), null);
  assert.equal(balanceW(sample({ loadW: 100, batteryW: null })), null);
});

const T = DEFAULT_THRESHOLDS;

const CASES: Array<[string, Partial<PowerSample>, string]> = [
  // E1: certain outage
  ['discharge beyond load (15:15)', { gridW: 2488, loadW: 722, batteryW: -931 }, 'off-certain'],
  ['discharge beyond load (16:10)', { gridW: 0, loadW: 132, batteryW: -298 }, 'off-certain'],
  ['discharge with grid null (16:20)', { gridW: null, loadW: 105, batteryW: -266 }, 'off-certain'],
  // E1b: likely outage
  ['discharge with unknown load', { loadW: null, batteryW: -300 }, 'off-likely:discharge-unknown-load'],
  ['discharge smaller than load', { gridW: 400, loadW: 600, batteryW: -300 }, 'off-likely:discharge-exceeds-balance'],
  ['small discharge beyond load', { loadW: 10, batteryW: -60 }, 'off-likely:small-discharge'],
  ['battery unknown, status discharging', { loadW: 300, batteryW: null, energyStatus: 'discharging' }, 'off-likely:status-or-soc-drop'],
  ['grid 0 while battery idle and load high (15:10)', { gridW: 0, loadW: 2488, batteryW: 0 }, 'off-likely:grid-zero-idle-load'],
  // E2: certain grid
  ['battery charging without PV', {
    gridW: 4052, loadW: 1640, batteryW: 2679, pvW: 0,
  }, 'on-certain'],
  ['battery charging, PV unknown', {
    gridW: 4052, loadW: 1640, batteryW: 2679, pvW: null,
  }, 'on-certain'],
  // E3: weak grid
  ['battery idle, grid matches load', { gridW: 703, loadW: 703, batteryW: 0 }, 'on-weak'],
  ['battery idle, grid null', { gridW: null, loadW: 703, batteryW: 0 }, 'on-weak'],
  ['small charge, grid matches', { gridW: 300, loadW: 240, batteryW: 60 }, 'on-weak'],
  // E4: conflicts
  ['small discharge, grid supplies the rest', { gridW: 150, loadW: 200, batteryW: -50 }, 'conflict'],
  ['battery idle, grid far above balance', { gridW: 2488, loadW: 300, batteryW: 0 }, 'conflict'],
  ['battery idle, balance below the on threshold', { gridW: 20, loadW: 20, batteryW: 0 }, 'conflict'],
  // E5: no data
  ['battery unknown, nothing else', { loadW: 300, batteryW: null }, 'no-data'],
  ['battery idle, load unknown', { loadW: null, batteryW: 0 }, 'no-data'],
];

for (const [name, values, expected] of CASES) {
  test(`classify: ${name} -> ${expected}`, () => {
    assert.equal(kind(classify(sample(values), null, T)), expected);
  });
}

test('classify: a state-of-charge drop with unknown battery power means a likely outage', () => {
  const previous = sample({ soc: 92, loadW: 100, batteryW: -250 });

  assert.equal(kind(classify(sample({ soc: 91, loadW: 100, batteryW: null }), previous, T)), 'off-likely:status-or-soc-drop');
  assert.equal(kind(classify(sample({ soc: 0, loadW: 100, batteryW: null }), previous, T)), 'no-data');
  assert.equal(kind(classify(sample({ soc: 60, loadW: 100, batteryW: null }), previous, T)), 'no-data');
  assert.equal(kind(classify(sample({ soc: 92, loadW: 100, batteryW: null }), previous, T)), 'no-data');
});

test('classify: PV charging the battery during an outage is a certain outage', () => {
  assert.equal(kind(classify(sample({ loadW: 300, batteryW: 1200, pvW: 1680 }), null, T)), 'off-certain');
  assert.equal(kind(classify(sample({ loadW: 300, batteryW: 1200, pvW: 900 }), null, T)), 'on-weak');
});
