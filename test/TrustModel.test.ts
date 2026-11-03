import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRUST_CONFIG, TrustModel } from '../lib/grid/TrustModel';

const SIGNAL = 'grid-zero-idle-load';

test('every signal starts enabled with a weak prior', () => {
  const model = new TrustModel(DEFAULT_TRUST_CONFIG, null);

  assert.equal(model.isEnabled(SIGNAL), true);
  assert.equal(model.isEnabled('small-discharge'), true);
});

test('one refutation keeps the signal, the second one disables it', () => {
  const model = new TrustModel(DEFAULT_TRUST_CONFIG, null);

  model.record(SIGNAL, 'refuted');
  assert.equal(model.isEnabled(SIGNAL), true);

  model.record(SIGNAL, 'refuted');
  assert.equal(model.isEnabled(SIGNAL), false);
});

test('signals are tracked independently', () => {
  const model = new TrustModel(DEFAULT_TRUST_CONFIG, null);

  model.record(SIGNAL, 'refuted');
  model.record(SIGNAL, 'refuted');

  assert.equal(model.isEnabled('discharge-unknown-load'), true);
});

test('a disabled signal is re-enabled only above the higher threshold (hysteresis)', () => {
  const model = new TrustModel(DEFAULT_TRUST_CONFIG, null);
  model.record(SIGNAL, 'refuted');
  model.record(SIGNAL, 'refuted');

  model.record(SIGNAL, 'confirmed');
  model.record(SIGNAL, 'confirmed');
  assert.equal(model.score(SIGNAL) > DEFAULT_TRUST_CONFIG.disableBelow, true);
  assert.equal(model.isEnabled(SIGNAL), false, 'must not re-enable just above the disable threshold');

  for (let i = 0; i < 3; i += 1) model.record(SIGNAL, 'confirmed');
  assert.equal(model.isEnabled(SIGNAL), true);
});

test('old outcomes fade, so a long good history does not block reacting to new errors', () => {
  const model = new TrustModel(DEFAULT_TRUST_CONFIG, null);
  for (let i = 0; i < 200; i += 1) model.record(SIGNAL, 'confirmed');

  let refutations = 0;
  while (model.isEnabled(SIGNAL)) {
    model.record(SIGNAL, 'refuted');
    refutations += 1;
  }

  assert.equal(refutations <= 12, true, `needed ${refutations} refutations`);
});

test('state survives a JSON round trip', () => {
  const model = new TrustModel(DEFAULT_TRUST_CONFIG, null);
  model.record(SIGNAL, 'refuted');
  model.record(SIGNAL, 'refuted');

  const restored = new TrustModel(DEFAULT_TRUST_CONFIG, JSON.parse(JSON.stringify(model.toJSON())));

  assert.equal(restored.isEnabled(SIGNAL), false);
  assert.equal(restored.score(SIGNAL), model.score(SIGNAL));
});
