import { test } from 'node:test';
import assert from 'node:assert/strict';
import journaled from '../lib/debug/journaledSubscriber';
import { SiteSnapshot, SiteSubscriber } from '../lib/site/SiteMonitor';

function journal() {
  const entries: Array<Record<string, unknown>> = [];
  return { entries, add: (kind: string, fields: Record<string, unknown>) => entries.push({ kind, ...fields }) };
}

const SNAPSHOT = { dataTimestamp: 42, fresh: true } as SiteSnapshot;

test('records each delivery to a device and passes it through', async () => {
  const log = journal();
  const received: number[] = [];
  const device: SiteSubscriber = {
    async onSnapshot(snapshot) {
      received.push(snapshot.dataTimestamp);
    },
    onUnavailable: () => Promise.resolve(),
    onAuthorizationFailed: () => Promise.resolve(),
    energyFloor: () => ({ gridImportedKWh: 1 }),
  };

  const wrapped = journaled(device, 'Grid', log);
  await wrapped.onSnapshot(SNAPSHOT);
  await wrapped.onUnavailable('offline');

  assert.deepEqual(received, [42]);
  assert.deepEqual(wrapped.energyFloor?.(), { gridImportedKWh: 1 });
  assert.deepEqual(log.entries, [
    {
      kind: 'device', device: 'Grid', dataTimestamp: 42, fresh: true, error: null,
    },
    { kind: 'device-unavailable', device: 'Grid', reason: 'offline' },
  ]);
});

test('a failing delivery is recorded with its error and still reported to the caller', async () => {
  const log = journal();
  const device: SiteSubscriber = {
    async onSnapshot() {
      throw new Error('measure_power: device unavailable');
    },
    onUnavailable: () => Promise.resolve(),
    onAuthorizationFailed: () => Promise.resolve(),
  };

  await assert.rejects(journaled(device, 'Grid', log).onSnapshot(SNAPSHOT), /device unavailable/);
  assert.equal(log.entries[0].error, 'measure_power: device unavailable');
});
