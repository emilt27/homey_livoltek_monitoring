import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DebugJournal, JournalConfig } from '../lib/debug/DebugJournal';
import FakeTimers from './support/FakeTimers';

const HOUR = 3_600_000;

const CONFIG: JournalConfig = {
  retentionMs: 25 * HOUR,
  chunkMs: HOUR,
  maxEntriesPerChunk: 100,
  urgentDelayMs: 2_000,
  persistDelayMs: 600_000,
  urgentKinds: ['process'],
};

function settings() {
  const data = new Map<string, unknown>();
  const writes: string[] = [];
  return {
    data,
    writes,
    get: (key: string) => (data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null),
    set: (key: string, value: unknown) => {
      writes.push(key);
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    unset: (key: string) => {
      data.delete(key);
    },
  };
}

const silent = { log() {}, error() {} };

function enabledSettings() {
  const store = settings();
  store.data.set('debug:journal:enabled', true);
  return store;
}

/** A journal that is switched on, as most tests need one that records. */
function journal(store = enabledSettings(), timers = new FakeTimers(), clock = { t: 0 }) {
  return {
    store, timers, clock, journal: new DebugJournal(store, timers, CONFIG, silent, () => clock.t),
  };
}

function fireAll(timers: FakeTimers) {
  timers.active().forEach((timer) => {
    timer.cleared = true;
    timer.callback();
  });
}

test('keeps 25 hours of entries and deletes the saved chunks that fall out of it', () => {
  const {
    journal: j, store, timers, clock,
  } = journal();

  j.add('read', { n: 1 });
  clock.t = 2 * HOUR;
  j.add('read', { n: 2 });
  fireAll(timers);
  assert.equal(store.data.has('debug:journal:0'), true);

  clock.t = 26 * HOUR;
  j.add('process', { n: 3 });
  fireAll(timers);

  assert.deepEqual(j.list(0).map((entry) => entry.n), [2, 3]);
  assert.equal(store.data.has('debug:journal:0'), false, 'the expired chunk is removed from settings');
});

test('a save writes only the chunk that changed, not the whole journal', () => {
  const {
    journal: j, store, timers, clock,
  } = journal();
  j.add('read', {});
  fireAll(timers);
  clock.t = HOUR;
  store.writes.length = 0;

  j.add('process', {});
  fireAll(timers);

  assert.deepEqual(store.writes.filter((key) => key !== 'debug:journal:index'), [`debug:journal:${HOUR}`]);
});

test('urgent entries of one poll are saved together after a short delay', () => {
  const {
    journal: j, store, timers,
  } = journal();

  j.add('process', {});
  j.add('process', {});
  j.add('read', {});
  const urgent = timers.active().filter((timer) => timer.ms === CONFIG.urgentDelayMs);
  assert.equal(urgent.length, 1, 'one short-delay save for the burst');

  urgent[0].callback();
  assert.equal(store.writes.filter((key) => key === 'debug:journal:0').length, 1);
});

test('a new journal reads the saved chunks back after a restart', () => {
  const store = enabledSettings();
  const first = journal(store, new FakeTimers(), { t: 5 });
  first.journal.add('read', { a: 1 });
  first.journal.add('process', { b: 2 });
  fireAll(first.timers);

  const second = journal(store, new FakeTimers(), { t: 10 });

  assert.deepEqual(second.journal.list(0), [{ at: 5, kind: 'read', a: 1 }, { at: 5, kind: 'process', b: 2 }]);
});

test('a chunk never grows beyond its safety limit', () => {
  const { journal: j } = journal();

  for (let i = 0; i < 150; i += 1) j.add('read', { i });

  assert.equal(j.list(0).length, 100);
  assert.equal(j.list(0)[0].i, 50);
});

test('a failing settings store never breaks the caller', () => {
  const timers = new FakeTimers();
  const broken = {
    get: () => {
      throw new Error('settings unavailable');
    },
    set: () => {
      throw new Error('too large');
    },
    unset: () => undefined,
  };
  const j = new DebugJournal(broken, timers, CONFIG, silent, () => 0);

  assert.doesNotThrow(() => j.add('process', {}));
  assert.doesNotThrow(() => fireAll(timers));
});

test('lists entries from a given time on', () => {
  const { journal: j, clock } = journal();
  for (const t of [10, 20, 30]) {
    clock.t = t;
    j.add('read', {});
  }

  assert.deepEqual(j.list(20).map((entry) => entry.at), [20, 30]);
});

test('the single-key journal of the previous version is removed from settings', () => {
  const store = settings();
  store.data.set('debug:journal', [{ at: 1, kind: 'read' }]);

  journal(store);

  assert.equal(store.data.has('debug:journal'), false);
});

test('the journal is off by default: nothing is recorded or saved', () => {
  const store = settings();
  const timers = new FakeTimers();
  const off = new DebugJournal(store, timers, CONFIG, silent, () => 0);

  off.add('process', { grid: 'off' });
  fireAll(timers);

  assert.equal(off.isEnabled(), false);
  assert.deepEqual(off.list(0), []);
  assert.deepEqual(store.writes, []);
});

test('switching it on is remembered, so a restart records from the first entry on', () => {
  const store = settings();
  new DebugJournal(store, new FakeTimers(), CONFIG, silent, () => 0).setEnabled(true);

  const restarted = new DebugJournal(store, new FakeTimers(), CONFIG, silent, () => 5);
  restarted.add('app-start', {});

  assert.equal(restarted.isEnabled(), true);
  assert.deepEqual(restarted.list(0).map((entry) => entry.kind), ['app-start']);
});

test('switching it off deletes the saved journal and stops recording', () => {
  const { store, timers, journal: on } = journal();
  on.add('process', { grid: 'off' });
  fireAll(timers);
  assert.ok([...store.data.keys()].some((key) => /^debug:journal:\d+$/.test(key)));

  on.setEnabled(false);
  on.add('process', { grid: 'on' });
  fireAll(timers);

  assert.deepEqual(on.list(0), []);
  assert.deepEqual([...store.data.keys()].filter((key) => key.startsWith('debug:journal')), ['debug:journal:enabled']);
  assert.equal(store.data.get('debug:journal:enabled'), false);
});

test('the index is written before a new chunk, so a power loss between the writes leaves no orphan key', () => {
  const { store, timers, journal: j } = journal();

  j.add('process', {});
  fireAll(timers);

  assert.deepEqual(store.writes, ['debug:journal:index', 'debug:journal:0']);
});
