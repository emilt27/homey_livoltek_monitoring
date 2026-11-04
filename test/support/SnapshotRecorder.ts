import { SiteSnapshot, SiteSubscriber } from '../../lib/site/SiteMonitor';

/** Subscriber that records everything it receives. */
export default class SnapshotRecorder implements SiteSubscriber {
  readonly snapshots: SiteSnapshot[] = [];
  readonly unavailable: string[] = [];
  readonly authorizationFailures: string[] = [];

  async onSnapshot(snapshot: SiteSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }

  async onUnavailable(reason: string): Promise<void> {
    this.unavailable.push(reason);
  }

  async onAuthorizationFailed(reason: string): Promise<void> {
    this.authorizationFailures.push(reason);
  }
}
