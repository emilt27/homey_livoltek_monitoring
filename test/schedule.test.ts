import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCHEDULE, errorBackoffMs, nextPollDelayMs } from '../lib/site/schedule';

const S = DEFAULT_SCHEDULE;
const POINT = 1_000_000_000;
const EXPECTED = POINT + S.periodMs + S.expectedLagMs;

test('without any data yet, polls at the slow interval', () => {
  assert.equal(nextPollDelayMs(POINT, null, false, S), S.slowMs);
});

test('an incomplete point is re-read quickly until the API fills it in', () => {
  assert.equal(nextPollDelayMs(POINT + 100_000, POINT, false, S), S.fastMs);
});

test('after a complete point, sleeps until the next point is expected', () => {
  assert.equal(nextPollDelayMs(POINT + 105_000, POINT, true, S), EXPECTED - (POINT + 105_000));
});

test('never sleeps shorter than the fast interval', () => {
  assert.equal(nextPollDelayMs(EXPECTED - 2_000, POINT, true, S), S.fastMs);
});

test('polls quickly while the next point is due, then falls back to the slow interval', () => {
  assert.equal(nextPollDelayMs(EXPECTED + 1_000, POINT, true, S), S.fastMs);
  assert.equal(nextPollDelayMs(EXPECTED + S.fastWindowMs - 1, POINT, true, S), S.fastMs);
  assert.equal(nextPollDelayMs(EXPECTED + S.fastWindowMs, POINT, true, S), S.slowMs);
});

test('after API errors the delay doubles from the slow interval up to the maximum', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((errors) => errorBackoffMs(errors, S)), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  assert.equal(errorBackoffMs(0, S), 0);
});
