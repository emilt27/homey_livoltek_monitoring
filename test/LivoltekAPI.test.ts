import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { LivoltekAPI, Logger } from '../lib/LivoltekAPI';

const USER_TOKEN = 'secret-user-token';
const KEY = 'secret-key';

function makeJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
  return `header.${payload}.signature`;
}

const ACCESS_TOKEN = makeJwt();

const POWER_FLOW = {
  energyStatus: 'charging',
  energyPower: 0.3,
  energySoc: 85,
  pvStatus: 'on',
  pvPower: 1.2,
  powerGridStatus: 'on',
  powerGridPower: 0,
  loadStatus: 'on',
  loadPower: 1.24,
  timestamp: 1,
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

class CapturingLogger implements Logger {
  readonly lines: string[] = [];

  log(...args: unknown[]): void {
    this.lines.push(args.map(String).join(' '));
  }

  error(...args: unknown[]): void {
    this.lines.push(args.map(String).join(' '));
  }

  text(): string {
    return this.lines.join('\n');
  }
}

const originalFetch = globalThis.fetch;

function stubFetch(calls: FetchCall[]): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const body = url.includes('/login')
      ? { message: 'SUCCESS', code: '200', data: { message: 'SUCCESS', data: ACCESS_TOKEN } }
      : { data: POWER_FLOW };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function makeApi(logger: Logger): LivoltekAPI {
  return new LivoltekAPI({
    secuid: 'secuid', key: KEY, userToken: USER_TOKEN, region: 'eu',
  }, logger);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('logs a short request line without secrets in normal mode', async () => {
  const calls: FetchCall[] = [];
  stubFetch(calls);
  const logger = new CapturingLogger();

  await makeApi(logger).getCurrentPowerFlow('12345');

  const text = logger.text();
  assert.match(text, /GET \/hess\/api\/site\/12345\/curPowerflow -> 200 \(\d+ ms\)/);
  assert.match(text, /POST \/hess\/api\/login -> 200 \(\d+ ms\)/);
  assert.doesNotMatch(text, /energySoc/);
  assert.ok(!text.includes(USER_TOKEN), 'user token leaked into logs');
  assert.ok(!text.includes(ACCESS_TOKEN), 'access token leaked into logs');
  assert.ok(!text.includes(KEY), 'key leaked into logs');
});

test('logs the full response body in debug mode without secrets', async () => {
  const calls: FetchCall[] = [];
  stubFetch(calls);
  const logger = new CapturingLogger();
  const api = makeApi(logger);
  api.setDebug(true);

  await api.getCurrentPowerFlow('12345');

  const text = logger.text();
  assert.match(text, /energySoc/);
  assert.ok(!text.includes(USER_TOKEN), 'user token leaked into logs');
  assert.ok(!text.includes(ACCESS_TOKEN), 'access token leaked into logs');
  assert.ok(!text.includes(KEY), 'key leaked into logs');
});

test('every request has a timeout signal', async () => {
  const calls: FetchCall[] = [];
  stubFetch(calls);

  await makeApi(new CapturingLogger()).getCurrentPowerFlow('12345');

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.init.signal instanceof AbortSignal, `no timeout signal for ${call.url}`);
  }
});

test('a plain numeric site id produces exactly the same URL as before', async () => {
  const calls: FetchCall[] = [];
  stubFetch(calls);

  await makeApi(new CapturingLogger()).getCurrentPowerFlow('12345');

  assert.equal(
    calls[1].url,
    `https://api-eu.livoltek-portal.com:8081/hess/api/site/12345/curPowerflow?userToken=${USER_TOKEN}`,
  );
});

test('special characters in the site id are encoded and cannot change the request path', async () => {
  const calls: FetchCall[] = [];
  stubFetch(calls);

  await makeApi(new CapturingLogger()).getCurrentPowerFlow('../1?x=y');

  assert.equal(
    calls[1].url,
    `https://api-eu.livoltek-portal.com:8081/hess/api/site/..%2F1%3Fx%3Dy/curPowerflow?userToken=${USER_TOKEN}`,
  );
});
