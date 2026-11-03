export interface ScheduleConfig {
  periodMs: number; // the API publishes a new data point every 5 minutes
  expectedLagMs: number; // a point appears ~100–110 s after its own timestamp
  fastMs: number;
  slowMs: number;
  fastWindowMs: number; // how long to keep polling fast when the next point is late
}

/** Measured on 2026-11-03: points every 300 s, visible 100–110 s after their timestamp. */
export const DEFAULT_SCHEDULE: ScheduleConfig = {
  periodMs: 300_000,
  expectedLagMs: 90_000,
  fastMs: 10_000,
  slowMs: 30_000,
  fastWindowMs: 240_000,
};

/**
 * Polls in phase with the API: sleeps until shortly before the next point is due, then polls fast
 * until it arrives, so a new point is seen ~10 s after publication with few requests in between.
 */
export function nextPollDelayMs(
  now: number,
  lastDataTimestamp: number | null,
  lastComplete: boolean,
  config: ScheduleConfig,
): number {
  if (lastDataTimestamp === null) return config.slowMs;
  if (!lastComplete) return config.fastMs;

  const expected = lastDataTimestamp + config.periodMs + config.expectedLagMs;
  if (now < expected) return Math.max(config.fastMs, expected - now);
  return now - expected < config.fastWindowMs ? config.fastMs : config.slowMs;
}
