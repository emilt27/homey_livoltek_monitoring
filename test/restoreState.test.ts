import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GridStateEstimator } from '../lib/grid/GridStateEstimator';
import { restoreSiteState } from '../lib/site/restoreState';

function validState() {
  const estimator = new GridStateEstimator(null);
  estimator.update({
    dataTimestamp: 1, gridW: 0, loadW: 120, batteryW: -300, pvW: 0, soc: 90, energyStatus: 'discharging',
  });
  return JSON.parse(JSON.stringify({
    estimator: estimator.toJSON(),
    outputs: { lastSoc: 90, pendingSoc: null },
    energy: { totals: { gridImportedKWh: 3.11, batteryChargedKWh: 0.156, batteryDischargedKWh: 0.287 }, last: { at: 1, gridW: 0, batteryW: -300 } },
  }));
}

test('a valid saved state is restored unchanged, without problems', () => {
  const saved = validState();

  const { state, problems } = restoreSiteState(saved);

  assert.deepEqual(state, saved);
  assert.deepEqual(problems, []);
});

test('nothing saved yet is not a problem', () => {
  assert.deepEqual(restoreSiteState(null), { state: null, problems: [] });
  assert.deepEqual(restoreSiteState(undefined), { state: null, problems: [] });
});

test('a saved value that is not an object at all is reported and ignored', () => {
  for (const garbage of ['{"estimator":', 42, [], true]) {
    const { state, problems } = restoreSiteState(garbage);
    assert.equal(state, null, JSON.stringify(garbage));
    assert.equal(problems.length, 1, JSON.stringify(garbage));
  }
});

test('broken energy totals reset only the energy part (the device meter floor raises it afterwards)', () => {
  for (const totals of [
    { gridImportedKWh: 'NaN', batteryChargedKWh: 0, batteryDischargedKWh: 0 },
    { gridImportedKWh: -1, batteryChargedKWh: 0, batteryDischargedKWh: 0 },
    { gridImportedKWh: 1, batteryChargedKWh: 0 },
    null,
  ]) {
    const saved = validState();
    saved.energy.totals = totals;

    const { state, problems } = restoreSiteState(saved);

    assert.equal(state?.energy, undefined, JSON.stringify(totals));
    assert.deepEqual(state?.estimator, validState().estimator, 'the estimator is kept');
    assert.deepEqual(state?.outputs, validState().outputs, 'the SoC filter is kept');
    assert.equal(problems.length, 1);
  }
});

test('a broken last energy point keeps the totals and only drops the point', () => {
  const saved = validState();
  saved.energy.last = { at: 'x', gridW: 0 };

  const { state, problems } = restoreSiteState(saved);

  assert.deepEqual(state?.energy, { totals: validState().energy.totals, last: null });
  assert.equal(problems.length, 1);
});

test('a broken SoC filter state is dropped alone', () => {
  for (const outputs of [{ lastSoc: 'ninety', pendingSoc: null }, { lastSoc: 140, pendingSoc: null }, 'x']) {
    const saved = validState();
    saved.outputs = outputs;

    const { state } = restoreSiteState(saved);

    assert.equal(state?.outputs, undefined, JSON.stringify(outputs));
    assert.deepEqual(state?.energy, validState().energy);
  }
});

test('a broken grid state machine is reset, while valid trust and learned balance survive', () => {
  const saved = validState();
  saved.estimator.state = 'maybe';
  saved.estimator.lastSample = { dataTimestamp: 'yesterday' };

  const { state, problems } = restoreSiteState(saved);

  assert.equal(state?.estimator?.state, undefined);
  assert.equal(state?.estimator?.lastSample, undefined);
  assert.deepEqual(state?.estimator?.trust, validState().estimator.trust);
  assert.deepEqual(state?.estimator?.balance, validState().estimator.balance);
  assert.ok(problems.length >= 1);
});

test('a broken trust entry or learned balance is dropped alone', () => {
  const saved = validState();
  saved.estimator.trust['small-discharge'] = { confirmed: 'many', refuted: 0, enabled: true };
  saved.estimator.balance = { offMeanW: null };

  const { state } = restoreSiteState(saved);

  assert.equal(state?.estimator?.trust?.['small-discharge'], undefined);
  assert.deepEqual(state?.estimator?.trust?.['grid-zero-idle-load'], validState().estimator.trust['grid-zero-idle-load']);
  assert.equal(state?.estimator?.balance, undefined);
  assert.equal(state?.estimator?.state, 'off', 'the valid grid state is kept');
});

test('a restored state with dropped parts still builds working pipeline objects', () => {
  const saved = validState();
  saved.estimator.balance = 'x';
  saved.estimator.trust = 7;
  const { state } = restoreSiteState(saved);

  const estimator = new GridStateEstimator(state?.estimator ?? null);

  assert.equal(estimator.toJSON().state, 'off');
  assert.equal(typeof estimator.toJSON().balance.offMeanW, 'number');
});
