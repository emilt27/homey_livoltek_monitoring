import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isComplete, mergeSample, normalizeSample, parseNumber, PowerSample,
} from '../lib/powerflow/sample';

test('parseNumber treats null-like values as missing and parses numeric strings', () => {
  for (const missing of [null, undefined, 'null', '', '  ', NaN, 'abc', {}, Infinity]) {
    assert.equal(parseNumber(missing), null, JSON.stringify(missing));
  }
  assert.equal(parseNumber(0), 0);
  assert.equal(parseNumber(-0), 0);
  assert.equal(parseNumber('0'), 0);
  assert.equal(parseNumber('0.0'), 0);
  assert.equal(parseNumber('0.68'), 0.68);
  assert.equal(parseNumber(-0.298), -0.298);
  assert.equal(parseNumber('91.0'), 91);
});

test('normalizeSample converts kW to whole watts and lowercases the status', () => {
  const sample = normalizeSample({
    pvStatus: null,
    pvPower: 0,
    powerGridStatus: null,
    powerGridPower: '0.68',
    loadStatus: 'consuming',
    loadPower: 0.177,
    energyStatus: 'disCharging',
    energyPower: -0.298,
    energySoc: 91,
    timestamp: 1793715000000,
  });

  assert.deepEqual(sample, {
    dataTimestamp: 1793715000000,
    gridW: 680,
    loadW: 177,
    batteryW: -298,
    pvW: 0,
    soc: 91,
    energyStatus: 'discharging',
  });
});

test('normalizeSample keeps missing fields as null', () => {
  const sample = normalizeSample({
    powerGridPower: null, loadPower: 'null', energyPower: '', energySoc: NaN, energyStatus: 'null', timestamp: 1,
  });

  assert.deepEqual(sample, {
    dataTimestamp: 1, gridW: null, loadW: null, batteryW: null, pvW: null, soc: null, energyStatus: null,
  });
});

test('normalizeSample rejects a response without data or without a timestamp', () => {
  assert.equal(normalizeSample(null), null);
  assert.equal(normalizeSample({ loadPower: 0.1 }), null);
  assert.equal(normalizeSample({ loadPower: 0.1, timestamp: 'null' }), null);
});

const BASE: PowerSample = {
  dataTimestamp: 1, gridW: null, loadW: 105, batteryW: -266, pvW: 0, soc: 91, energyStatus: 'discharging',
};

test('mergeSample fills missing fields of the same point without overwriting known ones', () => {
  const later: PowerSample = { ...BASE, gridW: 0, loadW: 999 };

  assert.deepEqual(mergeSample(BASE, later), { ...BASE, gridW: 0 });
});

test('isComplete requires load, battery and state of charge', () => {
  assert.equal(isComplete(BASE), true);
  assert.equal(isComplete({ ...BASE, loadW: null }), false);
  assert.equal(isComplete({ ...BASE, batteryW: null }), false);
  assert.equal(isComplete({ ...BASE, soc: null }), false);
});
