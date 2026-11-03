import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LivoltekCredentials, RawPowerFlow } from '../lib/LivoltekAPI';
import { SiteRegistry } from '../lib/site/SiteRegistry';
import FakeHomey from './support/FakeHomey';
import flush from './support/flush';
import SnapshotRecorder from './support/SnapshotRecorder';

const CREDENTIALS: LivoltekCredentials = {
  secuid: 'secuid', key: 'key', userToken: 'token', region: 'eu',
};

interface FakeSource {
  credentials: LivoltekCredentials;
  calls: number;
  debug: boolean;
  getCurrentPowerFlow(): Promise<RawPowerFlow | null>;
  setDebug(enabled: boolean): void;
}

function fakeSource(credentials: LivoltekCredentials): FakeSource {
  const source: FakeSource = {
    credentials,
    calls: 0,
    debug: false,
    async getCurrentPowerFlow() {
      source.calls += 1;
      return {
        powerGridPower: 0.703, loadPower: 0.703, energyPower: 0, energySoc: 99, pvPower: 0, timestamp: 1793714400000,
      };
    },
    setDebug(enabled: boolean) {
      source.debug = enabled;
    },
  };
  return source;
}

function setup() {
  const homey = new FakeHomey();
  const sources: FakeSource[] = [];
  const registry = new SiteRegistry(homey, { log() {}, error() {} }, (credentials) => {
    const source = fakeSource(credentials);
    sources.push(source);
    return source;
  });
  return { homey, sources, registry };
}

function recorder(): SnapshotRecorder {
  return new SnapshotRecorder();
}

test('devices of the same site share one monitor and one API client', async () => {
  const { sources, registry } = setup();
  const inverter = recorder();
  const battery = recorder();

  registry.acquire('25196', CREDENTIALS, inverter);
  registry.acquire('25196', CREDENTIALS, battery);
  await flush();

  assert.equal(sources.length, 1);
  assert.equal(sources[0].calls, 1);
  assert.equal(inverter.snapshots.length, 1);
  assert.equal(battery.snapshots.length, 1);
});

test('different sites get separate monitors', async () => {
  const { sources, registry } = setup();

  registry.acquire('1', CREDENTIALS, recorder());
  registry.acquire('2', CREDENTIALS, recorder());
  await flush();

  assert.equal(sources.length, 2);
});

test('releasing the last device stops polling and frees the monitor', async () => {
  const { homey, sources, registry } = setup();
  const releaseA = registry.acquire('25196', CREDENTIALS, recorder());
  const releaseB = registry.acquire('25196', CREDENTIALS, recorder());
  await flush();

  releaseA();
  assert.equal(homey.active().length, 1, 'still polling for the other device');
  releaseB();
  assert.equal(homey.active().length, 0);

  registry.acquire('25196', CREDENTIALS, recorder());
  assert.equal(sources.length, 2, 'a new monitor after everything was released');
});

test('new credentials replace the API client and keep the debug setting', async () => {
  const { homey, sources, registry } = setup();
  registry.acquire('25196', CREDENTIALS, recorder());
  await flush();
  registry.setDebug('25196', true);

  registry.updateCredentials('25196', { ...CREDENTIALS, key: 'new-key' });
  homey.timers.filter((timer) => !timer.cleared).at(-1)?.callback();
  await flush();

  assert.equal(sources.length, 2);
  assert.equal(sources[1].credentials.key, 'new-key');
  assert.equal(sources[1].debug, true);
  assert.equal(sources[1].calls, 1, 'the next poll uses the new client');
});

test('the site state is persisted in app settings per site', async () => {
  const { homey, registry } = setup();

  registry.acquire('25196', CREDENTIALS, recorder());
  await flush();

  const saved = homey.values.get('site:25196') as { estimator: { state: string } } | undefined;
  assert.equal(saved?.estimator.state, 'on');
});
