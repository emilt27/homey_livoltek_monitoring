import { LIKELY_OFF_SIGNALS, LikelyOffSignal } from './evidence';

export interface SignalTrust {
  confirmed: number; // exponentially decayed counts
  refuted: number;
  enabled: boolean;
}

export interface TrustConfig {
  decay: number; // weight kept by older outcomes on every new outcome of the same signal
  prior: { confirmed: number; refuted: number };
  disableBelow: number;
  enableAbove: number; // higher than disableBelow: hysteresis, so the signal itself does not flap
}

/** Weak prior (score 0.75): about two refutations disable a signal; half-life ~10 outcomes. */
export const DEFAULT_TRUST_CONFIG: TrustConfig = {
  decay: 0.93,
  prior: { confirmed: 3, refuted: 1 },
  disableBelow: 0.6,
  enableAbove: 0.75,
};

export type TrustState = Record<LikelyOffSignal, SignalTrust>;

/**
 * Learns how often each "likely outage" signal turns out right. Outcomes are labelled later by
 * certain evidence; disabled signals keep being labelled in the background so they can recover.
 */
export class TrustModel {
  private readonly config: TrustConfig;
  private readonly signals: TrustState;

  constructor(config: TrustConfig, state: Partial<TrustState> | null) {
    this.config = config;
    const initial = this.ratio(0, 0) >= config.enableAbove;
    this.signals = Object.fromEntries(LIKELY_OFF_SIGNALS.map((signal) => [
      signal,
      state?.[signal] ?? { confirmed: 0, refuted: 0, enabled: initial },
    ])) as TrustState;
  }

  isEnabled(signal: LikelyOffSignal): boolean {
    return this.signals[signal].enabled;
  }

  score(signal: LikelyOffSignal): number {
    const { confirmed, refuted } = this.signals[signal];
    return this.ratio(confirmed, refuted);
  }

  record(signal: LikelyOffSignal, outcome: 'confirmed' | 'refuted'): void {
    const trust = this.signals[signal];
    trust.confirmed = trust.confirmed * this.config.decay + (outcome === 'confirmed' ? 1 : 0);
    trust.refuted = trust.refuted * this.config.decay + (outcome === 'refuted' ? 1 : 0);

    const score = this.score(signal);
    if (trust.enabled && score < this.config.disableBelow) trust.enabled = false;
    else if (!trust.enabled && score >= this.config.enableAbove) trust.enabled = true;
  }

  toJSON(): TrustState {
    return JSON.parse(JSON.stringify(this.signals));
  }

  private ratio(confirmed: number, refuted: number): number {
    const { prior } = this.config;
    return (confirmed + prior.confirmed) / (confirmed + refuted + prior.confirmed + prior.refuted);
  }
}
