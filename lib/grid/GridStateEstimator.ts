import { PowerSample } from '../powerflow/sample';
import { BalanceState, BalanceThresholds } from './BalanceThresholds';
import {
  balanceW, classify, DEFAULT_THRESHOLDS, Evidence, LikelyOffSignal, Thresholds,
} from './evidence';
import {
  DEFAULT_TRUST_CONFIG, TrustConfig, TrustModel, TrustState,
} from './TrustModel';

export type GridState = 'on' | 'off' | 'unknown';

export interface GridDecision {
  state: GridState;
  changed: boolean; // only on <-> off; leaving 'unknown' is not a change, so flows do not fire on start
  evidence: Evidence;
  reason: string;
}

interface WeakPoint {
  loadW: number | null;
  batteryW: number | null;
}

export interface EstimatorState {
  state: GridState;
  lastSample: PowerSample | null;
  pendingWeakOn: WeakPoint | null; // first weak "grid on" point, waiting for a second one
  pendingLikelyOff: LikelyOffSignal | null; // likely-outage signal waiting to be labelled
  trust: TrustState;
  balance: BalanceState;
}

/** A saved state after validation: missing parts start fresh. */
export type RestoredEstimatorState = Partial<Omit<EstimatorState, 'trust'>> & { trust?: Partial<TrustState> };

export interface EstimatorConfig {
  thresholds: Thresholds;
  trust: TrustConfig;
}

const DEFAULT_CONFIG: EstimatorConfig = { thresholds: DEFAULT_THRESHOLDS, trust: DEFAULT_TRUST_CONFIG };

function describe(evidence: Evidence): string {
  switch (evidence.kind) {
    case 'off-certain': return `battery covers the load and the inverter (balance ${evidence.balanceW} W)`;
    case 'off-likely': return `likely outage: ${evidence.signal}`;
    case 'on-certain': return 'battery charging without PV';
    case 'on-weak': return `battery idle, load served (balance ${evidence.balanceW} W)`;
    case 'conflict': return `conflicting data: ${evidence.reason}`;
    default: return `no data: ${evidence.reason}`;
  }
}

/**
 * Asymmetric grid state machine: switches to "off" at the first certain or trusted likely sign of
 * an outage, but back to "on" only on certain evidence (battery charging) or on two consecutive
 * weak points whose values changed (a frozen record repeats the same values).
 */
export class GridStateEstimator {
  private readonly config: EstimatorConfig;
  private readonly trust: TrustModel;
  private readonly balance: BalanceThresholds;
  private state: GridState;
  private lastSample: PowerSample | null;
  private pendingWeakOn: WeakPoint | null;
  private pendingLikelyOff: LikelyOffSignal | null;

  constructor(state: RestoredEstimatorState | null, config: EstimatorConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.trust = new TrustModel(config.trust, state?.trust ?? null);
    this.balance = new BalanceThresholds(state?.balance ?? null);
    this.state = state?.state ?? 'unknown';
    this.lastSample = state?.lastSample ?? null;
    this.pendingWeakOn = state?.pendingWeakOn ?? null;
    this.pendingLikelyOff = state?.pendingLikelyOff ?? null;
  }

  update(sample: PowerSample): GridDecision {
    const thresholds = { ...this.config.thresholds, ...this.balance.current() };
    const evidence = classify(sample, this.lastSample, thresholds);
    const previous = this.state;
    let note = '';

    switch (evidence.kind) {
      case 'off-certain':
        this.resolveLikelyOff('confirmed');
        this.pendingWeakOn = null;
        this.state = 'off';
        break;
      case 'off-likely':
        this.pendingWeakOn = null;
        if (previous !== 'off') {
          this.pendingLikelyOff ??= evidence.signal;
          if (this.trust.isEnabled(evidence.signal)) {
            this.state = 'off';
          } else {
            note = ` (ignored, trust ${this.trust.score(evidence.signal).toFixed(2)})`;
          }
        }
        break;
      case 'on-certain':
        this.resolveLikelyOff('refuted');
        this.pendingWeakOn = null;
        this.state = 'on';
        break;
      case 'on-weak':
        if (this.weakOnConfirmed(sample)) {
          this.resolveLikelyOff('refuted');
          this.state = 'on';
        } else if (previous === 'unknown') {
          this.state = 'on';
        }
        break;
      default:
        break;
    }

    this.learnOffBalance(sample, thresholds);
    this.lastSample = sample;

    return {
      state: this.state,
      changed: previous !== 'unknown' && this.state !== 'unknown' && previous !== this.state,
      evidence,
      reason: `${describe(evidence)}${note}`,
    };
  }

  toJSON(): EstimatorState {
    return {
      state: this.state,
      lastSample: this.lastSample,
      pendingWeakOn: this.pendingWeakOn,
      pendingLikelyOff: this.pendingLikelyOff,
      trust: this.trust.toJSON(),
      balance: this.balance.toJSON(),
    };
  }

  /** True when this weak point follows another weak point with different values. */
  private weakOnConfirmed(sample: PowerSample): boolean {
    const pending = this.pendingWeakOn;
    const current = { loadW: sample.loadW, batteryW: sample.batteryW };
    if (pending !== null && (pending.loadW !== current.loadW || pending.batteryW !== current.batteryW)) {
      this.pendingWeakOn = null;
      return true;
    }
    this.pendingWeakOn = current;
    return false;
  }

  private resolveLikelyOff(outcome: 'confirmed' | 'refuted'): void {
    if (this.pendingLikelyOff === null) return;
    this.trust.record(this.pendingLikelyOff, outcome);
    this.pendingLikelyOff = null;
  }

  private learnOffBalance(sample: PowerSample, thresholds: Thresholds): void {
    const balance = balanceW(sample);
    if (this.state === 'off' && balance !== null && sample.batteryW !== null
      && sample.batteryW <= -thresholds.dischargeW) {
      this.balance.observeOff(balance);
    }
  }
}
