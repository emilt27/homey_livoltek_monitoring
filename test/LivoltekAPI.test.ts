import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { LivoltekAPI, Logger, normalizeKey } from '../lib/LivoltekAPI';
import LivoltekAuthError from '../lib/LivoltekAuthError';

const USER_TOKEN = 'secret-user-token';
const KEY = 'secret-key';

function makeJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJl`;
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

interface LoginReply {
  message: string | null;
  data: string;
}

const LOGIN_OK: LoginReply = { message: 'SUCCESS', data: ACCESS_TOKEN };

function stubFetch(calls: FetchCall[], loginReply: LoginReply = LOGIN_OK): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const body = url.includes('/login')
      ? { message: 'SUCCESS', code: '200', data: loginReply }
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

const KEY_CORE = '2PN+abc/DEF==';

test('normalizeKey ends the key with exactly one CRLF however the line ending was pasted', () => {
  for (const pasted of [
    KEY_CORE,
    `${KEY_CORE}\n`,
    `${KEY_CORE}\r\n`,
    `${KEY_CORE}\r`,
    `${KEY_CORE}\\n`,
    `${KEY_CORE}\\r\\n`,
    `${KEY_CORE}\\r`,
    `  ${KEY_CORE} \r\n `,
    `${KEY_CORE}\n\r`,
    `${KEY_CORE}\r\n\r\n`,
    `${KEY_CORE}\\n\\r`,
    `${KEY_CORE}\\r\n`,
    `${KEY_CORE}\r\\n`,
    `${KEY_CORE}\\\\r\\\\n`,
    `${KEY_CORE}\t`,
  ]) {
    assert.equal(normalizeKey(pasted), `${KEY_CORE}\r\n`, JSON.stringify(pasted));
  }
});

test('login sends the key with a CRLF ending', async () => {
  const calls: FetchCall[] = [];
  stubFetch(calls);

  await new LivoltekAPI({
    secuid: 'secuid', key: `${KEY_CORE}\\n`, userToken: USER_TOKEN, region: 'eu',
  }, new CapturingLogger()).login();

  assert.equal(JSON.parse(String(calls[0].init.body)).key, `${KEY_CORE}\r\n`);
});

test('login rejects a "SUCCESS" reply whose token is an error text instead of a JWT', async () => {
  for (const junk of ['"user not exit"', 'null', '']) {
    stubFetch([], { message: null, data: junk });

    await assert.rejects(
      makeApi(new CapturingLogger()).login(),
      (error: Error) => error.message.includes('Login failed'),
      `accepted ${JSON.stringify(junk)} as a token`,
    );
  }
});

// Recorded 2026-11-04 on the EU server: a bad access token and a bad userToken are both HTTP 401
const SESSION_EXPIRED = { status: 401, body: { code: '401', message: 'Please login', data: null } };
const USER_TOKEN_REJECTED = { status: 401, body: { code: '2001', message: 'token.invalid', data: null } };
const OK = { status: 200, body: { code: '200', message: 'SUCCESS', data: POWER_FLOW } };

function scriptedFetch(replies: Array<{ status: number; body: unknown }>, loginReply: LoginReply = LOGIN_OK) {
  const counts = { logins: 0, flows: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes('/login')) {
      counts.logins += 1;
      return new Response(JSON.stringify({ message: 'SUCCESS', code: '200', data: loginReply }), { status: 200 });
    }
    counts.flows += 1;
    const reply = replies.shift() ?? OK;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return counts;
}

test('an expired session ("Please login") logs in again once and repeats the request', async () => {
  const counts = scriptedFetch([SESSION_EXPIRED, OK]);

  const flow = await makeApi(new CapturingLogger()).getCurrentPowerFlow('25196');

  assert.equal(flow?.loadPower, POWER_FLOW.loadPower);
  assert.deepEqual(counts, { logins: 2, flows: 2 });
});

test('a session still rejected after logging in again is an authorization error', async () => {
  scriptedFetch([SESSION_EXPIRED, SESSION_EXPIRED]);

  await assert.rejects(makeApi(new CapturingLogger()).getCurrentPowerFlow('25196'), LivoltekAuthError);
});

test('a rejected user token is an authorization error at once, without logging in again', async () => {
  const counts = scriptedFetch([USER_TOKEN_REJECTED]);

  await assert.rejects(makeApi(new CapturingLogger()).getCurrentPowerFlow('25196'), LivoltekAuthError);
  assert.deepEqual(counts, { logins: 1, flows: 1 });
});

test('rejected credentials at login are an authorization error', async () => {
  scriptedFetch([], { message: null, data: '"user not exit"' });

  await assert.rejects(makeApi(new CapturingLogger()).getCurrentPowerFlow('25196'), LivoltekAuthError);
});

test('a server or network failure is not an authorization error', async () => {
  scriptedFetch([{ status: 502, body: 'Bad Gateway' }]);

  await assert.rejects(makeApi(new CapturingLogger()).getCurrentPowerFlow('25196'), (error: Error) => !(error instanceof LivoltekAuthError));
});

test('a 401 without a readable error code (HTML, numeric code) is treated as an expired session first', async () => {
  for (const body of ['<html>401 Unauthorized</html>', { code: 401, message: 'Please login' }]) {
    const counts = scriptedFetch([{ status: 401, body }, OK]);

    const flow = await makeApi(new CapturingLogger()).getCurrentPowerFlow('25196');

    assert.equal(flow?.loadPower, POWER_FLOW.loadPower, JSON.stringify(body));
    assert.deepEqual(counts, { logins: 2, flows: 2 }, 'one new login and one retry');
  }
});

test('a login reply with a message other than SUCCESS is a server problem, not refused credentials', async () => {
  scriptedFetch([], { message: 'system busy', data: '' });

  await assert.rejects(makeApi(new CapturingLogger()).getCurrentPowerFlow('25196'), (error: Error) => !(error instanceof LivoltekAuthError));
});

test('a login answered with "Wrong secuid or key" is refused credentials, so the user is asked to repair', async () => {
  scriptedFetch([], { message: 'Wrong secuid or key', data: '' });

  await assert.rejects(makeApi(new CapturingLogger()).getCurrentPowerFlow('25196'), LivoltekAuthError);
});
