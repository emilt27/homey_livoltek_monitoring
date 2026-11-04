import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_EXPORT_KWH, dailyExport, localDay } from '../lib/devices/dailyExport';

test('the local day follows the Homey time zone, not UTC', () => {
  const lateUtc = Date.UTC(2026, 10, 4, 22, 30); // 2026-11-04 22:30 UTC = 2026-11-05 00:30 in Kyiv
  assert.equal(localDay(lateUtc, 'Europe/Kyiv'), '2026-11-05');
  assert.equal(localDay(lateUtc, 'UTC'), '2026-11-04');
});

test('the first check of a day adds the daily export once', () => {
  assert.deepEqual(dailyExport(0.005, '2026-11-04', '2026-11-05'), { exportedKWh: 0.006, day: '2026-11-05' });
});

test('later checks on the same day add nothing', () => {
  assert.equal(dailyExport(0.006, '2026-11-05', '2026-11-05'), null);
});

test('a device that never added the export (new or just updated) adds it right away', () => {
  assert.deepEqual(dailyExport(null, null, '2026-11-05'), { exportedKWh: DAILY_EXPORT_KWH, day: '2026-11-05' });
});

test('the export meter keeps 3 decimals, like Homey stores meter_power', () => {
  assert.equal(dailyExport(0.1 + 0.2, null, '2026-11-05')?.exportedKWh, 0.301);
});
