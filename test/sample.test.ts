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

test('normalizeSample treats a state of charge of 0 as missing: it is the placeholder of an incomplete record', () => {
  assert.equal(normalizeSample({ energySoc: 0, timestamp: 1 })?.soc, null);
  assert.equal(normalizeSample({ energySoc: '0', timestamp: 1 })?.soc, null);
  assert.equal(normalizeSample({ energySoc: 11, timestamp: 1 })?.soc, 11);
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

test('mergeSample: a later read of the same point wins, fields it still misses keep the earlier value', () => {
  // first read of a new point is a placeholder (status "idel"), ~30 s later the full record arrives
  const partial: PowerSample = {
    ...BASE, gridW: null, loadW: null, pvW: null, energyStatus: 'idel',
  };
  const full: PowerSample = { ...BASE, gridW: 0, batteryW: null };

  // grid, load, pv and status come from the full read; battery only from the partial one
  assert.deepEqual(mergeSample(partial, full), { ...BASE, gridW: 0 });
});

test('isComplete requires load and battery, plus a state of charge or a real status', () => {
  assert.equal(isComplete(BASE), true);
  assert.equal(isComplete({ ...BASE, loadW: null }), false);
  assert.equal(isComplete({ ...BASE, batteryW: null }), false);
  for (const status of ['discharging', 'charging', 'importing']) {
    assert.equal(isComplete({ ...BASE, soc: null, energyStatus: status }), true, status);
  }
  for (const placeholder of ['idel', null]) {
    assert.equal(isComplete({ ...BASE, soc: null, energyStatus: placeholder }), false, String(placeholder));
  }
});
