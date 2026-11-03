import Homey from 'homey';
import { LivoltekCredentials } from '../LivoltekAPI';
import { SiteSnapshot, SiteSubscriber } from '../site/SiteMonitor';
import { SiteRegistry, siteRegistryOf } from '../site/SiteRegistry';
import { CapabilityValues } from './mappers';

export interface SiteDeviceData {
  id: string;
  siteId: string;
}

/**
 * A Homey device showing one Livoltek site: subscribes to the shared site monitor and writes the
 * values its mapper derives from every snapshot.
 */
export abstract class SiteDevice extends Homey.Device implements SiteSubscriber {
  protected abstract readonly mapCapabilities: (snapshot: SiteSnapshot) => CapabilityValues;
  private release: (() => void) | null = null;

  async onInit() {
    this.release = this.sites().acquire(this.siteId(), this.credentials(), this);
  }

  async onUninit() {
    this.stopMonitoring();
  }

  async onDeleted() {
    this.stopMonitoring();
  }

  async onSnapshot(snapshot: SiteSnapshot): Promise<void> {
    if (!this.getAvailable()) await this.setAvailable();
    for (const [capability, value] of Object.entries(this.mapCapabilities(snapshot))) {
      if (this.hasCapability(capability)) await this.setCapabilityValue(capability, value).catch(this.error);
    }
  }

  async onUnavailable(reason: string): Promise<void> {
    await this.setUnavailable(`${this.homey.__('error.connection_failed')}: ${reason}`).catch(this.error);
  }

  protected sites(): SiteRegistry {
    return siteRegistryOf(this.homey.app);
  }

  protected siteId(): string {
    return (this.getData() as SiteDeviceData).siteId;
  }

  protected credentials(): LivoltekCredentials {
    return this.getStore() as LivoltekCredentials;
  }

  private stopMonitoring() {
    this.release?.();
    this.release = null;
  }
}
