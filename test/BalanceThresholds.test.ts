import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BalanceThresholds } from '../lib/grid/BalanceThresholds';

test('starts from the inverter self-consumption measured on 2026-11-03', () => {
  assert.deepEqual(new BalanceThresholds(null).current(), { offBalanceW: -88, onBalanceW: 30 });
});

test('the off threshold follows the observed outage balance (half of its average)', () => {
  const thresholds = new BalanceThresholds(null);

  thresholds.observeOff(-400);

  assert.equal(thresholds.current().offBalanceW, -99.2);
  assert.equal(thresholds.current().onBalanceW, 30);
});

test('the off threshold stays within safe bounds', () => {
  const big = new BalanceThresholds(null);
  for (let i = 0; i < 100; i += 1) big.observeOff(-2000);
  assert.equal(big.current().offBalanceW, -200);

  const small = new BalanceThresholds(null);
  for (let i = 0; i < 100; i += 1) small.observeOff(-10);
  assert.equal(small.current().offBalanceW, -30);
});

test('state survives a JSON round trip', () => {
  const thresholds = new BalanceThresholds(null);
  thresholds.observeOff(-400);

  const restored = new BalanceThresholds(JSON.parse(JSON.stringify(thresholds.toJSON())));

  assert.deepEqual(restored.current(), thresholds.current());
});
