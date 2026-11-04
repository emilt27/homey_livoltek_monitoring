import { SiteSnapshot, SiteSubscriber } from '../site/SiteMonitor';
import { Journal } from './DebugJournal';

/**
 * Debug journal: wraps a device subscriber and records every delivery and its outcome,
 * so the device classes themselves carry no debug code.
 */
export default function journaled(subscriber: SiteSubscriber, name: string, journal: Journal): SiteSubscriber {
  return {
    async onSnapshot(snapshot: SiteSnapshot) {
      let error: string | null = null;
      try {
        await subscriber.onSnapshot(snapshot);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        throw failure;
      } finally {
        journal.add('device', {
          device: name, dataTimestamp: snapshot.dataTimestamp, fresh: snapshot.fresh, error,
        });
      }
    },
    async onUnavailable(reason: string) {
      journal.add('device-unavailable', { device: name, reason });
      await subscriber.onUnavailable(reason);
    },
    async onAuthorizationFailed(reason: string) {
      journal.add('device-authorization-failed', { device: name, reason });
      await subscriber.onAuthorizationFailed(reason);
    },
    energyFloor: subscriber.energyFloor === undefined ? undefined : () => subscriber.energyFloor?.() ?? {},
  };
}
