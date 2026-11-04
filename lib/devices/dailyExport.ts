/**
 * Workaround for a Homey Energy bug: the Home tile shows "— kWh" for every period in which a home
 * battery discharged while the cumulative meter exported nothing. The site never exports, so the
 * Grid device adds 1 Wh (the smallest step Homey keeps: meter_power has 3 decimals) to its export
 * meter once per local day, right after midnight, before the first discharge of the day, and the
 * same 1 Wh to its import meter, so Grid (import − export) and Home stay exact.
 * Reported in https://community.homey.app/t/home-tile-always-shows-kwh-although-the-day-report-has-complete-data/161771
 */
export const DAILY_EXPORT_KWH = 0.001;

/** The calendar day ("YYYY-MM-DD") of `ms` in the given IANA time zone. */
export function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ms);
}

/** The new export meter value when `today` has no daily export yet; null when it already has one. */
export function dailyExport(exportedKWh: number | null, lastDay: string | null, today: string): { exportedKWh: number; day: string } | null {
  if (lastDay === today) return null;
  return { exportedKWh: Math.round(((exportedKWh ?? 0) + DAILY_EXPORT_KWH) * 1000) / 1000, day: today };
}
