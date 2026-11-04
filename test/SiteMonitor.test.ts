import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawPowerFlow } from '../lib/LivoltekAPI';
import LivoltekAuthError from '../lib/LivoltekAuthError';
import { SiteMonitor, SiteSnapshot, SiteSubscriber } from '../lib/site/SiteMonitor';
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

function raw(minutesFromT0: number, values: {
  grid: number | null; load: number | null; battery: number | null; soc?: number; status?: string | null;
}): RawPowerFlow {
  return {
    powerGridPower: values.grid,
    loadPower: values.load,
    energyPower: values.battery,
    energySoc: values.soc ?? 90,
    pvPower: 0,
    energyStatus: values.status === undefined ? 'idel' : values.status,
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

test('during an outage (no grid power at all) a processed point is not re-read every few seconds', async () => {
  const { source, monitor, timers } = setup();
  source.responses.push(raw(0, { grid: null, load: 0.077, battery: -0.254 }));

  monitor.subscribe(new Recorder());
  await flush();

  const [next] = timers.active();
  assert.equal(next.ms, 5 * MINUTE + 90_000 - 2 * MINUTE, 'sleeps until the next point is due');
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
    async onAuthorizationFailed() {
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

// Recorded 2026-11-04 00:20: load and battery real, status "disCharging", SoC 0 in all 16 reads.
const OUTAGE_SOC_0 = {
  grid: null, load: 0.056, battery: -0.231, soc: 0, status: 'disCharging',
};

test('a point with a real status but SoC 0 is decided at once; the charge stays unknown (devices keep the previous one)', async () => {
  const { source, monitor } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, OUTAGE_SOC_0));

  monitor.subscribe(recorder);
  await flush();

  assert.equal(recorder.snapshots.length, 1);
  assert.equal(recorder.snapshots[0].fresh, true);
  assert.equal(recorder.snapshots[0].grid.state, 'off');
  assert.equal(recorder.snapshots[0].values.batteryW, -231);
  assert.equal(recorder.snapshots[0].values.soc, null);
});

test('SoC arriving in a later read of that point is published without deciding the point again', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, OUTAGE_SOC_0));
  source.responses.push(raw(0, { ...OUTAGE_SOC_0, soc: 99 }));

  monitor.subscribe(recorder);
  await flush();
  assert.equal(timers.active()[0].ms, 10_000, 'the missing SoC is re-read quickly');
  await timers.fireNext();

  assert.equal(recorder.snapshots.length, 2);
  assert.equal(recorder.snapshots[1].fresh, false);
  assert.equal(recorder.snapshots[1].values.soc, 99);
  assert.equal(recorder.snapshots[1].grid.state, 'off');
});

test('a missing SoC is re-read at most 5 times, then the next point is awaited', async () => {
  const { source, monitor, timers } = setup();
  for (let i = 0; i < 6; i += 1) source.responses.push(raw(0, OUTAGE_SOC_0));

  monitor.subscribe(new Recorder());
  await flush();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(timers.active()[0].ms, 10_000, `retry ${i + 1}`);
    await timers.fireNext();
  }

  assert.ok(timers.active()[0].ms > 60_000, 'sleeps until the next point after the retries');
  assert.equal(source.calls, 6);
});

test('a placeholder (no real status, SoC 0) is not decided even with load and battery present', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  // Recorded 2026-11-04 00:05: first read with empty status, SoC 0 and battery 0; full record 10 s later
  source.responses.push(raw(0, {
    grid: null, load: 0.176, battery: 0, soc: 0, status: null,
  }));
  source.responses.push(raw(0, {
    grid: 0.176, load: 0.176, battery: 0, soc: 100, status: 'Importing',
  }));

  monitor.subscribe(recorder);
  await flush();
  assert.equal(recorder.snapshots.length, 0);

  await timers.fireNext();
  assert.equal(recorder.snapshots.length, 1);
  assert.equal(recorder.snapshots[0].values.soc, 100);
});

test('energy is still counted across one completely missing point (15 minutes)', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, { grid: 1.2, load: 1.2, battery: 0 }));
  source.responses.push(raw(15, { grid: 1.2, load: 1.2, battery: 0 }));

  monitor.subscribe(recorder);
  await flush();
  await timers.fireNext();

  const last = recorder.snapshots.at(-1);
  assert.ok(last);
  assert.ok(Math.abs(last.energy.gridImportedKWh - 0.3) < 1e-9, `${last.energy.gridImportedKWh}`);
});

test('a missing SoC retry is used up by an API error or an empty response too', async () => {
  const { source, monitor, timers } = setup();
  source.responses.push(raw(0, OUTAGE_SOC_0), new Error('timeout'), null, new Error('timeout'), null, null);

  monitor.subscribe(new Recorder());
  await flush();
  for (let i = 0; i < 5; i += 1) await timers.fireNext();

  assert.ok(timers.active()[0].ms >= 60_000, `polling must slow down after the retries, got ${timers.active()[0].ms} ms`);
});

test('polling backs off after consecutive API errors, at most to 5 minutes, and recovers on success', async () => {
  const { source, monitor, timers } = setup();
  for (let i = 0; i < 6; i += 1) source.responses.push(new Error('network down'));
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));

  monitor.subscribe(new Recorder());
  await flush();
  const delays: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    delays.push(timers.active()[0].ms);
    await timers.fireNext();
  }

  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  assert.equal(timers.active()[0].ms, 5 * MINUTE + 90_000 - 2 * MINUTE, 'a success returns to the normal schedule');
});

test('a late SoC is saved, so a restart does not compare the next point with an older charge', async () => {
  const {
    source, monitor, timers, store,
  } = setup();
  source.responses.push(raw(0, { ...OUTAGE_SOC_0, soc: 60 }));
  source.responses.push(raw(5, OUTAGE_SOC_0));
  source.responses.push(raw(5, { ...OUTAGE_SOC_0, soc: 45 }));

  monitor.subscribe(new Recorder());
  await flush();
  await timers.fireNext();
  await timers.fireNext();

  assert.equal(store.state?.outputs.lastSoc, 45);
});

test('deliveries to one subscriber never overlap and keep their order', async () => {
  const { source, monitor, timers } = setup();
  const events: string[] = [];
  let release: () => void = () => undefined;
  const slow = {
    async onSnapshot(snapshot: SiteSnapshot) {
      events.push(`start ${(snapshot.dataTimestamp - T0) / MINUTE}`);
      if (events.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      events.push(`end ${(snapshot.dataTimestamp - T0) / MINUTE}`);
    },
    onUnavailable: () => Promise.resolve(),
    onAuthorizationFailed: () => Promise.resolve(),
  };
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));
  source.responses.push(raw(5, { grid: 0.5, load: 0.5, battery: 0 }));
  monitor.subscribe(new Recorder());
  await flush();

  monitor.subscribe(slow); // a device initialising late gets the last snapshot while the next poll runs
  await flush();
  await timers.fireNext();
  release();
  await flush();

  assert.deepEqual(events, ['start 0', 'end 0', 'start 5', 'end 5']);
});

test('a meter value shown by a device raises a lower restored total, so meters never decrease', async () => {
  const store = new MemoryStore();
  const { source, monitor } = setup(store);
  const recorder = new Recorder();
  const device = Object.assign(recorder, { energyFloor: () => ({ gridImportedKWh: 5.2 }) });
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));

  monitor.subscribe(device);
  await flush();

  assert.ok(recorder.snapshots[0].energy.gridImportedKWh >= 5.2, `${recorder.snapshots[0].energy.gridImportedKWh}`);
});
test('a corrupted saved state does not stop the monitor; meters continue from what the device shows', async () => {
  const timers = new FakeTimers();
  const source = fakeSource();
  const errors: string[] = [];
  const corrupted = { load: () => ({ estimator: 'x', outputs: null, energy: { totals: { gridImportedKWh: 'NaN' } } }), save: () => undefined };
  const monitor = new SiteMonitor('25196', source, timers, corrupted, { log() {}, error: (message: string) => errors.push(message) }, () => T0 + 2 * MINUTE);
  const recorder = new Recorder();
  const device = Object.assign(recorder, { energyFloor: () => ({ gridImportedKWh: 3.11 }) });
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));

  monitor.subscribe(device);
  await flush();

  assert.equal(recorder.snapshots.length, 1);
  assert.equal(recorder.snapshots[0].grid.state, 'on');
  assert.equal(recorder.snapshots[0].energy.gridImportedKWh, 3.11);
  assert.ok(errors.some((message) => message.includes('energy totals are invalid')), errors.join('\n'));
});

test('a placeholder read after the full record of the same point is ignored', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, {
    grid: 0.176, load: 0.176, battery: -0.25, soc: 98, status: 'disCharging',
  }));
  source.responses.push(raw(0, {
    grid: null, load: 0.2, battery: 0, soc: 0, status: null,
  }));
  source.responses.push(raw(0, {
    grid: null, load: null, battery: null, soc: 0, status: 'idel',
  }));

  monitor.subscribe(recorder);
  await flush();
  await timers.fireNext();
  await timers.fireNext();

  assert.equal(recorder.snapshots.length, 1, 'no refresh from placeholder reads');
  assert.equal(recorder.snapshots[0].values.batteryW, -250);
});

test('a SoC-only completion of a point with a real status is still taken', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(raw(0, OUTAGE_SOC_0));
  source.responses.push(raw(0, { ...OUTAGE_SOC_0, soc: 97, status: null }));

  monitor.subscribe(recorder);
  await flush();
  await timers.fireNext();

  assert.equal(recorder.snapshots.at(-1)?.values.soc, 97);
  assert.equal(recorder.snapshots.at(-1)?.values.batteryW, -231);
});

test('rejected credentials are reported to the devices once per streak, not on every poll', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  const refused = () => new LivoltekAuthError('GET curPowerflow refused: 2001', false);
  source.responses.push(refused(), refused(), refused());
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));
  source.responses.push(refused());

  monitor.subscribe(recorder);
  await flush();
  await timers.fireNext();
  await timers.fireNext();
  assert.equal(recorder.authorizationFailures.length, 1);
  assert.deepEqual(recorder.unavailable, [], 'an authorization failure is not reported as a connection problem');

  await timers.fireNext();
  await timers.fireNext();
  assert.equal(recorder.authorizationFailures.length, 2, 'a new streak after a success is reported again');
});

test('new credentials (repair) are tried at once and re-arm the authorization report', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  source.responses.push(new LivoltekAuthError('login refused', false));
  monitor.subscribe(recorder);
  await flush();

  const repaired = fakeSource();
  repaired.responses.push(new LivoltekAuthError('still refused', false));
  monitor.setSource(repaired);
  await flush();

  assert.equal(repaired.calls, 1, 'polled right after the repair, without waiting for the backoff');
  assert.equal(recorder.authorizationFailures.length, 2);
  assert.ok(timers.active().length <= 1, 'one polling chain only');
});

test('a poll still running with the old credentials cannot report a failure after the repair', async () => {
  const { source, monitor } = setup();
  const recorder = new Recorder();
  let rejectOld: (error: Error) => void = () => undefined;
  source.getCurrentPowerFlow = () => new Promise((_, reject) => {
    rejectOld = reject;
  });
  monitor.subscribe(recorder);
  await flush();

  const repaired = fakeSource();
  repaired.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));
  monitor.setSource(repaired);
  await flush();
  rejectOld(new LivoltekAuthError('old token refused', true));
  await flush();

  assert.equal(recorder.snapshots.length, 1, 'the repaired source delivered its point');
  assert.deepEqual(recorder.authorizationFailures, [], 'the late answer of the old credentials is ignored');
});

test('after an error, a successful read of the same point makes the devices available again without re-triggering', async () => {
  const { source, monitor, timers } = setup();
  const recorder = new Recorder();
  const point = raw(0, {
    grid: 0, load: 0.3, battery: -0.3, status: 'disCharging',
  });
  source.responses.push(point, new Error('HTTP 502'), point);

  monitor.subscribe(recorder);
  await flush();
  await timers.fireNext();
  assert.equal(recorder.unavailable.length, 1);

  await timers.fireNext();

  assert.equal(recorder.snapshots.length, 2, 'the last snapshot is delivered again');
  const again = recorder.snapshots[1];
  assert.equal(again.fresh, false);
  assert.equal(again.grid.changed, false, 'no grid trigger fires twice for the same point');
  assert.equal(again.dataTimestamp, recorder.snapshots[0].dataTimestamp);
});

test('a late subscriber gets the last snapshot as an old one, so it fires no flow for a past grid change', async () => {
  const { source, monitor } = setup();
  source.responses.push(raw(0, { grid: 0.703, load: 0.703, battery: 0 }));
  const first = new Recorder();
  monitor.subscribe(first);
  await flush();
  assert.equal(first.snapshots[0].fresh, true);

  const late = new Recorder();
  monitor.subscribe(late);
  await flush();

  assert.equal(late.snapshots.length, 1);
  assert.equal(late.snapshots[0].fresh, false);
  assert.equal(late.snapshots[0].grid.changed, false);
  assert.equal(late.snapshots[0].dataTimestamp, first.snapshots[0].dataTimestamp);
});
