import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCHEDULE, nextPollDelayMs } from '../lib/site/schedule';

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
