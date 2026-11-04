import { EnergyTotals } from '../energy/EnergyMeter';
import { Journal } from '../debug/DebugJournal';
import journaled from '../debug/journaledSubscriber';
import { LivoltekCredentials, Logger } from '../LivoltekAPI';
import { TimerApi } from '../Poller';
import {
  PowerFlowSource, SiteMonitor, SiteStateStore, SiteSubscriber,
} from './SiteMonitor';

export interface DebuggableSource extends PowerFlowSource {
  setDebug(enabled: boolean): void;
}

export interface SettingsStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface RegistryHomey extends TimerApi {
  settings: SettingsStore;
}

interface SiteEntry {
  monitor: SiteMonitor;
  debug: boolean;
  source: DebuggableSource;
}

/** App settings key holding the learned state of one site; survives removing and re-adding devices. */
export function siteStateKey(siteId: string): string {
  return `site:${siteId}`;
}

function settingsStore(settings: SettingsStore, siteId: string): SiteStateStore {
  const key = siteStateKey(siteId);
  return {
    load: () => settings.get(key),
    save: (state) => settings.set(key, state),
  };
}

/**
 * App-level registry of site monitors: every device of a site (inverter, battery, grid) shares one
 * monitor, created on the first acquire and stopped when the last device releases it.
 */
export class SiteRegistry {
  private readonly homey: RegistryHomey;
  private readonly logger: Logger;
  private readonly createSource: (credentials: LivoltekCredentials) => DebuggableSource;
  private readonly sites = new Map<string, SiteEntry>();
  private readonly journal: Journal | undefined;

  constructor(
    homey: RegistryHomey,
    logger: Logger,
    createSource: (credentials: LivoltekCredentials) => DebuggableSource,
    journal?: Journal,
  ) {
    this.journal = journal;
    this.homey = homey;
    this.logger = logger;
    this.createSource = createSource;
  }

  /** Returns the release function the device calls on uninit/delete. */
  acquire(siteId: string, credentials: LivoltekCredentials, subscriber: SiteSubscriber): () => void {
    const entry = this.sites.get(siteId) ?? this.create(siteId, credentials);
    // Debug journal (lib/debug): record what every device receives; a no-op while it is off
    const target = this.journal === undefined ? subscriber : journaled(subscriber, subscriber.constructor.name, this.journal);
    const unsubscribe = entry.monitor.subscribe(target);
    return () => {
      unsubscribe();
      if (entry.monitor.subscriberCount() === 0 && this.sites.get(siteId) === entry) this.sites.delete(siteId);
    };
  }

  updateCredentials(siteId: string, credentials: LivoltekCredentials): void {
    const entry = this.sites.get(siteId);
    if (entry === undefined) return;
    entry.source = this.createSource(credentials);
    entry.source.setDebug(entry.debug);
    entry.monitor.setSource(entry.source);
  }

  /** Adds energy to the site's grid import; null when the site has no running monitor. */
  addImportedEnergy(siteId: string, kWh: number): EnergyTotals | null {
    return this.sites.get(siteId)?.monitor.addImportedEnergy(kWh) ?? null;
  }

  setDebug(siteId: string, enabled: boolean): void {
    const entry = this.sites.get(siteId);
    if (entry === undefined) return;
    entry.debug = enabled;
    entry.source.setDebug(enabled);
  }

  private create(siteId: string, credentials: LivoltekCredentials): SiteEntry {
    const source = this.createSource(credentials);
    const monitor = new SiteMonitor(siteId, source, this.homey, settingsStore(this.homey.settings, siteId), this.logger, Date.now, this.journal);
    const entry: SiteEntry = { monitor, debug: false, source };
    this.sites.set(siteId, entry);
    return entry;
  }
}

export interface SiteRegistryOwner {
  readonly sites: SiteRegistry;
}

/** The registry owned by the app instance; devices reach it through this.homey.app. */
export function siteRegistryOf(app: unknown): SiteRegistry {
  const { sites } = app as Partial<SiteRegistryOwner>;
  if (!(sites instanceof SiteRegistry)) throw new Error('Livoltek app is not initialized: site registry is missing');
  return sites;
}
