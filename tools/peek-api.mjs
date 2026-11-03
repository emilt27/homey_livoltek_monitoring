#!/usr/bin/env node
/**
 * Print raw Livoltek API responses for diagnostics.
 *
 * Credentials are read from env.json in the project root (git-ignored):
 *   {
 *     "secuid": "...",
 *     "key": "...",          // value of "key" from the portal JSON, pasted as-is
 *     "userToken": "...",
 *     "region": "eu",        // or "global"
 *     "siteId": "..."        // optional, defaults to the first site
 *   }
 *
 * Usage:
 *   node tools/peek-api.mjs              one-shot dump of every known endpoint
 *   node tools/peek-api.mjs --watch 30   poll curPowerflow every 30 s, print and append to recordings/
 *
 * Tokens and keys are never printed.
 */
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUEST_TIMEOUT_MS = 20_000;

const env = JSON.parse(await readFile(join(ROOT, 'env.json'), 'utf8'));
for (const field of ['secuid', 'key', 'userToken', 'region']) {
  if (!env[field]) throw new Error(`env.json: missing "${field}"`);
}

// LIVOLTEK_REGION=global|eu overrides env.json, e.g. to check which server knows the account
const region = process.env.LIVOLTEK_REGION ?? env.region;
console.error(`region: ${region}`);

const baseUrl = region === 'eu'
  ? 'https://api-eu.livoltek-portal.com:8081'
  : 'https://api.livoltek-portal.com:8081';

let accessToken = null;

async function request(method, path, { body, authorized = true } = {}) {
  const url = new URL(`${baseUrl}${path}`);
  const headers = { 'Content-Type': 'application/json' };
  if (authorized) {
    url.searchParams.append('userToken', env.userToken);
    headers.Authorization = accessToken;
  }
  const startedAt = Date.now();
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, ms: Date.now() - startedAt, text };
}

/**
 * Same rule as normalizeKey() in lib/LivoltekAPI.ts: the API accepts the key only with a CRLF
 * ending, so any pasted line ending (real or typed as "\\n", "\\r\\n") is replaced with CRLF.
 */
function normalizeKey(key) {
  return `${key.trim().replace(/(?:\s|\\+[rn])+$/, '')}\r\n`;
}

async function login() {
  const { status, text } = await request('POST', '/hess/api/login', {
    body: { secuid: env.secuid, key: normalizeKey(env.key) },
    authorized: false,
  });
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON response, reported below
  }
  // The API answers HTTP 200 + "SUCCESS" even for bad credentials and puts an error text
  // (e.g. "null", "\"user not exit\"") where the token should be: accept only a JWT
  const token = data?.data?.data;
  if (status === 200 && data?.message === 'SUCCESS' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token ?? '')) {
    accessToken = token;
    console.error('login OK');
    return;
  }
  const message = data ? `${data.message} / ${data.data?.message ?? data.data?.data}` : text.slice(0, 200);
  throw new Error(`login failed: HTTP ${status} ${message}`);
}

function printResponse(title, { status, ms, text }) {
  console.log(`\n===== ${title}  (HTTP ${status}, ${ms} ms)`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function resolveSiteId() {
  if (env.siteId) return String(env.siteId);
  const sites = await request('GET', '/hess/api/userSites/list?page=1&size=10');
  printResponse('GET /hess/api/userSites/list', sites);
  const site = parseJson(sites.text)?.data?.list?.[0];
  const id = site?.powerStationId ?? site?.siteId ?? site?.id;
  if (!id) throw new Error('no site found');
  return String(id);
}

async function dumpAll() {
  const siteId = await resolveSiteId();
  const site = encodeURIComponent(siteId);

  for (const path of [
    `/hess/api/site/${site}/curPowerflow`,
    `/hess/api/site/${site}/ESS`,
    `/hess/api/site/${site}/overview`,
    `/hess/api/site/${site}/reissueUtilityEnergy`,
  ]) {
    printResponse(`GET ${path}`, await request('GET', path));
  }

  const devicesResponse = await request('GET', `/hess/api/device/${site}/list?page=1&size=10`);
  printResponse(`GET /hess/api/device/${siteId}/list`, devicesResponse);
  const devices = parseJson(devicesResponse.text)?.data?.list ?? [];

  for (const device of devices) {
    const serial = device.inverterSn ?? device.deviceSn ?? device.sn;
    const deviceId = device.id ?? device.deviceId;
    if (serial) {
      const path = `/hess/api/device/${site}/${encodeURIComponent(serial)}/details`;
      printResponse(`GET ${path}`, await request('GET', path));
    }
    if (deviceId) {
      const path = `/hess/api/device/${encodeURIComponent(deviceId)}/realElectricity`;
      printResponse(`GET ${path}`, await request('GET', path));
    }
  }
}

function localTimestamp(date = new Date()) {
  const offsetMs = -date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() + offsetMs).toISOString().replace('Z', '');
}

async function watch(intervalSeconds) {
  const siteId = await resolveSiteId();
  const path = `/hess/api/site/${encodeURIComponent(siteId)}/curPowerflow`;
  const dir = join(ROOT, 'recordings');
  await mkdir(dir, { recursive: true });
  console.error(`polling ${path} every ${intervalSeconds} s, Ctrl+C to stop`);

  for (;;) {
    const at = localTimestamp();
    let record;
    try {
      let response = await request('GET', path);
      if (response.status === 401 || response.status === 403) {
        await login();
        response = await request('GET', path);
      }
      record = { at, status: response.status, ms: response.ms, body: parseJson(response.text) ?? response.text };
      const d = record.body?.data;
      const derivedGrid = d ? Number(d.loadPower) + Number(d.energyPower) - Number(d.pvPower) : NaN;
      console.log(`${at} HTTP ${response.status}  ${JSON.stringify(record.body?.data ?? record.body)}`
        + `  | derived grid ${Number.isFinite(derivedGrid) ? derivedGrid.toFixed(3) : '?'} kW`);
    } catch (error) {
      record = { at, error: String(error) };
      console.log(`${at} ERROR ${error}`);
    }
    await appendFile(join(dir, `${at.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
    await new Promise((resolve) => {
      setTimeout(resolve, intervalSeconds * 1000);
    });
  }
}

await login();
const watchIndex = process.argv.indexOf('--watch');
if (watchIndex === -1) {
  await dumpAll();
} else {
  await watch(Number(process.argv[watchIndex + 1]) || 30);
}
