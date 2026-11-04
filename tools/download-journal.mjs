#!/usr/bin/env node
/**
 * Download the app's debug journal from Homey (see "Debug journal" in the README).
 *
 * Uses the Homey CLI login: run `npx homey login` once and select your Homey.
 *
 * Usage:
 *   node tools/download-journal.mjs [--hours 25] [--out journal.json]
 *
 * Writes the entries as JSON (one array, oldest first) and prints a short summary.
 * The Homey token is never printed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const hours = Number(option('--hours', 25));
const out = option('--out', `journal-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`);

const cli = JSON.parse(await readFile(`${homedir()}/.athom-cli/settings.json`, 'utf8').catch(() => {
  throw new Error('Homey CLI settings not found: run `npx homey login` first');
}));
const homeyId = cli.activeHomey?.id;
const token = cli.homeyApi?.[`homey-${homeyId}`]?.token;
if (!homeyId || !token) throw new Error('No active Homey in the CLI settings: run `npx homey login` and select your Homey');

const since = Date.now() - hours * 3_600_000;
const url = `https://${homeyId}.connect.athom.com/api/app/com.temirov.livoltek/journal?since=${since}`;
const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
if (!response.ok) throw new Error(`Homey answered HTTP ${response.status}: ${await response.text()}`);
const entries = await response.json();

await writeFile(out, JSON.stringify(entries, null, 2));
const kinds = {};
for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
console.log(`${entries.length} entries since ${new Date(since).toISOString()} -> ${out}`);
console.log(entries.length === 0 ? 'Empty: is "Debug journal" switched on in the inverter settings?' : kinds);
