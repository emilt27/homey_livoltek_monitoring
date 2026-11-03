import { PersistedSiteState, SiteStateStore } from '../../lib/site/SiteMonitor';

/** Site state store that round-trips through JSON like Homey settings do. */
export default class MemoryStore implements SiteStateStore {
  state: PersistedSiteState | null = null;

  load(): PersistedSiteState | null {
    return this.state === null ? null : JSON.parse(JSON.stringify(this.state));
  }

  save(state: PersistedSiteState): void {
    this.state = JSON.parse(JSON.stringify(state));
  }
}
