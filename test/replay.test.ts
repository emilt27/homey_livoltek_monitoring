import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RawPowerFlow } from '../lib/LivoltekAPI';
import { SiteMonitor, SiteSnapshot } from '../lib/site/SiteMonitor';
import FakeTimers from './support/FakeTimers';
import flush from './support/flush';
import MemoryStore from './support/MemoryStore';

/**
 * Raw API responses recorded every 30 s on 2026-11-03 16:17–18:49 (Europe/Kyiv) with
 * tools/peek-api.mjs: outage until ~17:17, grid back at the 17:20 point, incomplete placeholder
 * reads (SoC 0, status "idel") and hourly data: null responses.
 */
interface RecordedRead {
  at: string;
  data: RawPowerFlow | null;
}

const RECORDING: RecordedRead[] = JSON.parse(readFileSync(
  join(__dirname, '..', '..', 'test', 'fixtures', 'recording-2026-11-03.json'),
  'utf8',
));

const GRID_BACK_POINT = Date.parse('2026-11-03T17:20:00+02:00');

test('replay of the recorded outage and grid return', async () => {
  const timers = new FakeTimers();
  const clock = { now: 0 };
  let index = 0;
  const source = {
    async getCurrentPowerFlow() {
      const read = RECORDING[index];
      index += 1;
      clock.now = Date.parse(`${read.at}+02:00`);
      return read.data;
    },
  };
  const snapshots: SiteSnapshot[] = [];
  const monitor = new SiteMonitor('25196', source, timers, new MemoryStore(), { log() {}, error() {} }, () => clock.now);

  monitor.subscribe({
    async onSnapshot(snapshot) {
      snapshots.push(snapshot);
    },
    async onUnavailable(reason) {
      assert.fail(`unexpected unavailable: ${reason}`);
    },
    async onAuthorizationFailed(reason) {
      assert.fail(`unexpected authorization failure: ${reason}`);
    },
  });
  await flush();
  while (index < RECORDING.length) await timers.fireNext();

  const fresh = snapshots.filter((snapshot) => snapshot.fresh);
  for (const snapshot of fresh) {
    const expected = snapshot.dataTimestamp >= GRID_BACK_POINT ? 'on' : 'off';
    assert.equal(snapshot.grid.state, expected, `${new Date(snapshot.dataTimestamp).toISOString()}: ${snapshot.grid.reason}`);
  }
  assert.deepEqual(
    fresh.filter((snapshot) => snapshot.grid.changed).map((snapshot) => snapshot.dataTimestamp),
    [GRID_BACK_POINT],
    'exactly one change: grid back at the first charging point',
  );

  for (const snapshot of snapshots) {
    assert.notEqual(snapshot.values.soc, 0, 'placeholder SoC 0 must never be published');
    if (snapshot.grid.state === 'off') assert.equal(snapshot.values.gridImportW, 0);
  }

  const energy = snapshots.at(-1)?.energy;
  assert.ok(energy);
  assert.ok(energy.batteryDischargedKWh > 0.15 && energy.batteryDischargedKWh < 0.4, `discharged ${energy.batteryDischargedKWh}`);
  assert.ok(energy.batteryChargedKWh > 0.5, `charged ${energy.batteryChargedKWh}`);
  assert.ok(energy.gridImportedKWh > energy.batteryChargedKWh, `imported ${energy.gridImportedKWh}`);
});
