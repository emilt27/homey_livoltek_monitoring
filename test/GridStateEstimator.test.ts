import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GridStateEstimator } from '../lib/grid/GridStateEstimator';
import { normalizeSample, PowerSample } from '../lib/powerflow/sample';
import { DAY_2026_11_03 } from './fixtures/day-2026-11-03';

let clock = 0;
function sample(values: Partial<PowerSample>): PowerSample {
  clock += 300_000;
  return {
    dataTimestamp: clock, gridW: null, loadW: null, batteryW: null, pvW: 0, soc: 90, energyStatus: null, ...values,
  };
}

const ON_IDLE = (load: number) => sample({ gridW: load, loadW: load, batteryW: 0 });
const OUTAGE = () => sample({ gridW: 0, loadW: 120, batteryW: -300 });
const CHARGING = () => sample({ gridW: 3000, loadW: 300, batteryW: 2700 });
const GRID_ZERO = () => sample({ gridW: 0, loadW: 2000, batteryW: 0 });

test('replay of 2026-11-03: every decided state matches reality, outages detected at the first usable point', () => {
  const estimator = new GridStateEstimator(null);
  const changes: string[] = [];

  for (const point of DAY_2026_11_03) {
    const normalized = normalizeSample(point.raw);
    if (normalized === null) continue;

    const decision = estimator.update(normalized);

    assert.equal(decision.state, point.expected, `${point.time}: ${point.note} (${decision.reason})`);
    if (decision.changed) changes.push(`${point.time}->${decision.state}`);
  }

  assert.deepEqual(changes, ['13:45->off', '14:00->on', '15:10->off']);
});

test('the first decision after start is not reported as a change', () => {
  const estimator = new GridStateEstimator(null);

  const decision = estimator.update(OUTAGE());

  assert.equal(decision.state, 'off');
  assert.equal(decision.changed, false);
});

test('conflicting or missing data keeps the state unknown at start', () => {
  const estimator = new GridStateEstimator(null);

  assert.equal(estimator.update(sample({ gridW: 2488, loadW: 300, batteryW: 0 })).state, 'unknown');
  assert.equal(estimator.update(sample({ loadW: 300, batteryW: null })).state, 'unknown');
});

test('a likely outage switches off immediately, a charging battery switches back on immediately', () => {
  const estimator = new GridStateEstimator(null);
  estimator.update(ON_IDLE(700));

  assert.equal(estimator.update(GRID_ZERO()).state, 'off');
  const back = estimator.update(CHARGING());

  assert.equal(back.state, 'on');
  assert.equal(back.changed, true);
});

test('weak evidence alone never switches back on: a frozen record repeating the same values is ignored', () => {
  const estimator = new GridStateEstimator(null);
  estimator.update(ON_IDLE(700));
  estimator.update(OUTAGE());

  assert.equal(estimator.update(ON_IDLE(2488)).state, 'off');
  assert.equal(estimator.update(ON_IDLE(2488)).state, 'off', 'identical values must not confirm the grid');
  assert.equal(estimator.update(ON_IDLE(2510)).state, 'on', 'changed values confirm the grid');
});

test('weak evidence must come in consecutive points to switch on', () => {
  const estimator = new GridStateEstimator(null);
  estimator.update(ON_IDLE(700));
  estimator.update(OUTAGE());

  estimator.update(ON_IDLE(256));
  estimator.update(OUTAGE());

  assert.equal(estimator.update(ON_IDLE(703)).state, 'off', 'the earlier weak point was interrupted by an outage');
});

test('a refuted likely-outage signal loses trust and stops switching off; a certain outage still does', () => {
  const estimator = new GridStateEstimator(null);
  estimator.update(ON_IDLE(700));

  for (let i = 0; i < 2; i += 1) {
    assert.equal(estimator.update(GRID_ZERO()).state, 'off');
    assert.equal(estimator.update(CHARGING()).state, 'on');
  }

  const ignored = estimator.update(GRID_ZERO());
  assert.equal(ignored.state, 'on', 'signal must be disabled after two refutations');
  assert.match(ignored.reason, /grid-zero-idle-load/);

  assert.equal(estimator.update(OUTAGE()).state, 'off', 'certain evidence is never disabled');
});

test('a disabled signal is still evaluated in the background and comes back once it proves right', () => {
  const estimator = new GridStateEstimator(null);
  estimator.update(ON_IDLE(700));
  for (let i = 0; i < 2; i += 1) {
    estimator.update(GRID_ZERO());
    estimator.update(CHARGING());
  }

  for (let i = 0; i < 6; i += 1) {
    estimator.update(GRID_ZERO());
    estimator.update(OUTAGE());
    estimator.update(CHARGING());
  }

  assert.equal(estimator.update(GRID_ZERO()).state, 'off');
});

test('outage balance is learned from discharging points while the grid is off', () => {
  const estimator = new GridStateEstimator(null);
  estimator.update(ON_IDLE(700));
  for (let i = 0; i < 30; i += 1) estimator.update(sample({ gridW: 0, loadW: 100, batteryW: -500 }));

  assert.equal(estimator.toJSON().balance.offMeanW < -350, true);
});

test('state survives a JSON round trip', () => {
  const estimator = new GridStateEstimator(null);
  estimator.update(ON_IDLE(700));
  estimator.update(OUTAGE());
  estimator.update(ON_IDLE(256));

  const restored = new GridStateEstimator(JSON.parse(JSON.stringify(estimator.toJSON())));

  assert.equal(restored.update(ON_IDLE(703)).state, 'on', 'pending weak point must be restored');
});
