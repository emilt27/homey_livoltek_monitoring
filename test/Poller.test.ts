import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../lib/Poller';
import FakeTimers from './support/FakeTimers';
import flush from './support/flush';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const failOnError = (error: unknown): never => assert.fail(`unexpected polling error: ${String(error)}`);

test('start runs the task immediately and schedules the next run with the interval', async () => {
  const timers = new FakeTimers();
  let runs = 0;
  const poller = new Poller(timers, async () => {
    runs += 1;
  }, failOnError);

  await poller.start(() => 30_000);

  assert.equal(runs, 1);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].ms, 30_000);
});

test('a fired timer runs the task again and schedules exactly one new timer', async () => {
  const timers = new FakeTimers();
  let runs = 0;
  const poller = new Poller(timers, async () => {
    runs += 1;
  }, failOnError);

  await poller.start(() => 1_000);
  timers.fire(0);
  await flush();

  assert.equal(runs, 2);
  assert.equal(timers.active().length, 1);
});

test('task errors are reported and polling continues', async () => {
  const timers = new FakeTimers();
  const errors: unknown[] = [];
  const poller = new Poller(timers, async () => {
    throw new Error('boom');
  }, (error) => errors.push(error));

  await poller.start(() => 1_000);

  assert.equal(errors.length, 1);
  assert.equal(timers.active().length, 1);
});

test('stop while a scheduled run is in flight prevents rescheduling', async () => {
  const timers = new FakeTimers();
  let inFlight = deferred();
  const poller = new Poller(timers, () => inFlight.promise, failOnError);

  const started = poller.start(() => 1_000);
  inFlight.resolve();
  await started;

  inFlight = deferred();
  timers.fire(0);
  poller.stop();
  inFlight.resolve();
  await flush();

  assert.equal(timers.active().length, 0);
});

test('restart while a run is in flight leaves exactly one polling chain', async () => {
  const timers = new FakeTimers();
  let inFlight = deferred();
  const poller = new Poller(timers, () => inFlight.promise, failOnError);

  const started = poller.start(() => 1_000);
  inFlight.resolve();
  await started;

  const oldRun = deferred();
  inFlight = oldRun;
  timers.fire(0);

  inFlight = deferred();
  const restarted = poller.start(() => 5_000);
  inFlight.resolve();
  await restarted;
  oldRun.resolve();
  await flush();

  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].ms, 5_000);
});

test('stop clears the pending timer', async () => {
  const timers = new FakeTimers();
  const poller = new Poller(timers, async () => {}, failOnError);

  await poller.start(() => 1_000);
  poller.stop();

  assert.equal(timers.active().length, 0);
});

test('the delay function is consulted before every scheduling', async () => {
  const timers = new FakeTimers();
  const delays = [5_000, 7_000];
  const poller = new Poller(timers, async () => {}, failOnError);

  await poller.start(() => delays.shift() ?? 0);
  timers.fire(0);
  await flush();

  assert.deepEqual(timers.timers.map((timer) => timer.ms), [5_000, 7_000]);
});
