import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawPowerFlow } from '../lib/LivoltekAPI';
import { SiteMonitor, SiteSubscriber } from '../lib/site/SiteMonitor';
import FakeTimers from './support/FakeTimers';
import flush from './support/flush';
import MemoryStore from './support/MemoryStore';
import Recorder from './support/SnapshotRecorder';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 3, 14, 0);

interface FakeSource {
  responses: Array<RawPowerFlow | null | Error>;
  calls: number;
  getCurrentPowerFlow(): Promise<RawPowerFlow | null>;
}

function fakeSource(): FakeSource {
  const source: FakeSource = {
    responses: [],
    calls: 0,
    async getCurrentPowerFlow() {
      source.calls += 1;
      const next = source.responses.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
  };
  return source;
}

const silent = { log() {}, error() {} };

function raw(minutesFromT0: number, values: { grid: number | null; load: number | null; battery: number | null; soc?: number }): RawPowerFlow {
  return {
    powerGridPower: values.grid,
    loadPower: values.load,
    energyPower: values.battery,
    energySoc: values.soc ?? 90,
    pvPower: 0,
    energyStatus: 'idel',
    timestamp: T0 + minutesFromT0 * MINUTE,
  };
}

function setup(store = new MemoryStore()) {
  const timers = new FakeTimers();
  const source = fakeSource();
  const clock = { now: T0 + 2 * MINUTE };
  const monitor = new SiteMonitor('25196', source, timers, store, silent, () => clock.now);
  return {
    timers, source, clock, monitor, store,
  };
}

test('one API request per poll serves every subscriber', async () => {
  const { source, monitor } = setup();
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));
  const a = new Recorder();
  const b = new Recorder();

  monitor.subscribe(a);
  monitor.subscribe(b);
  await flush();

  assert.equal(source.calls, 1);
  assert.equal(a.snapshots.length, 1);
  assert.equal(b.snapshots.length, 1, 'late subscriber gets the last snapshot');
  assert.equal(a.snapshots[0].grid.state, 'on');
});

test('a point without grid power is decided at once and refreshed when the grid value arrives', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, { grid: null, load: 0.703, battery: 0 }));
  source.responses.push(raw(0, { grid: 0.69, load: 0.703, battery: 0 }));

  monitor.subscribe(recorder);
  await flush();
  await timers.fireNext();

  assert.equal(recorder.snapshots.length, 2);
  assert.equal(recorder.snapshots[0].fresh, true);
  assert.equal(recorder.snapshots[0].values.gridImportW, 703);
  assert.equal(recorder.snapshots[1].fresh, false);
  assert.equal(recorder.snapshots[1].values.gridImportW, 690);
});

test('an incomplete point is not processed until load, battery and charge are known', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, { grid: 0, load: 0.105, battery: null }));
  source.responses.push(raw(0, { grid: 0, load: 0.105, battery: -0.266 }));

  monitor.subscribe(recorder);
  await flush();
  assert.equal(recorder.snapshots.length, 0);
  assert.equal(timers.active()[0].ms, 10_000, 'incomplete points are re-read quickly');

  await timers.fireNext();
  assert.equal(recorder.snapshots.length, 1);
  assert.equal(recorder.snapshots[0].grid.state, 'off');
});

test('the same point read again unchanged is not published twice', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));

  monitor.subscribe(recorder);
  await flush();
  await timers.fireNext();

  assert.equal(recorder.snapshots.length, 1);
});

test('API errors make subscribers unavailable, the next point makes them available again', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(new Error('HTTP 502'));
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));

  monitor.subscribe(recorder);
  await flush();
  assert.equal(recorder.unavailable.length, 1);
  assert.match(recorder.unavailable[0], /502/);

  await timers.fireNext();
  assert.equal(recorder.snapshots.length, 1);
});

test('data older than 12 minutes is reported as stale once', async () => {
  const {
    source, monitor, timers, clock,
  } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));

  monitor.subscribe(recorder);
  await flush();
  clock.now = T0 + 13 * MINUTE;
  await timers.fireNext();
  await timers.fireNext();

  assert.equal(recorder.unavailable.length, 1);
  assert.match(recorder.unavailable[0], /stale|fresh/i);
});

test('a failing subscriber does not affect the others', async () => {
  const { source, monitor } = setup();
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));
  const healthy = new Recorder();
  const broken: SiteSubscriber = {
    async onSnapshot() {
      throw new Error('boom');
    },
    async onUnavailable() {
      throw new Error('boom');
    },
  };

  monitor.subscribe(broken);
  monitor.subscribe(healthy);
  await flush();

  assert.equal(healthy.snapshots.length, 1);
});

test('the last unsubscribe stops polling', async () => {
  const { source, monitor, timers } = setup();
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));

  const release = monitor.subscribe(new Recorder());
  await flush();
  release();

  assert.equal(timers.active().length, 0);
  assert.equal(monitor.subscriberCount(), 0);
});

test('the grid state and learning survive a restart through the store', async () => {
  const store = new MemoryStore();
  const first = setup(store);
  first.source.responses.push(raw(0, { grid: 0, load: 0.12, battery: -0.3 }));
  first.monitor.subscribe(new Recorder());
  await flush();
  assert.equal(store.state?.estimator.state, 'off');

  const second = setup(store);
  const recorder = new Recorder();
  second.source.responses.push(raw(5, { grid: 0.703, load: 0.703, battery: 0 }));
  second.monitor.subscribe(recorder);
  await flush();

  assert.equal(recorder.snapshots[0].grid.state, 'off', 'one weak point after restart must not switch on');
});

test('energy counters advance with fresh points only', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, { grid: 1.2, load: 1.2, battery: 0 }));
  source.responses.push(raw(5, { grid: 1.2, load: 1.2, battery: 0 }));
  source.responses.push(raw(5, { grid: 1.2, load: 1.2, battery: 0 }));

  monitor.subscribe(recorder);
  await flush();
  await timers.fireNext();
  await timers.fireNext();

  const last = recorder.snapshots.at(-1);
  assert.ok(last);
  assert.ok(Math.abs(last.energy.gridImportedKWh - 0.1) < 1e-9);
});
