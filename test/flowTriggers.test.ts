import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossedAbove, crossedBelow } from '../lib/flowTriggers';

test('crossedBelow is true only when the value crosses the threshold downwards', () => {
  assert.equal(crossedBelow(20, 21, 19), true);
  assert.equal(crossedBelow(20, 20, 19), true);
  assert.equal(crossedBelow(20, 85, 84), false);
  assert.equal(crossedBelow(20, 19, 18), false);
  assert.equal(crossedBelow(20, 21, 20), false);
  assert.equal(crossedBelow(20, 19, 21), false);
});

test('crossedAbove is true only when the value crosses the threshold upwards', () => {
  assert.equal(crossedAbove(3000, 2900, 3100), true);
  assert.equal(crossedAbove(3000, 3000, 3100), true);
  assert.equal(crossedAbove(3000, 500, 600), false);
  assert.equal(crossedAbove(3000, 3100, 3200), false);
  assert.equal(crossedAbove(3000, 2900, 3000), false);
  assert.equal(crossedAbove(3000, 3100, 2900), false);
});
