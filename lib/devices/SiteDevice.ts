import Homey from 'homey';
import { LivoltekCredentials } from '../LivoltekAPI';
import { SiteSnapshot, SiteSubscriber } from '../site/SiteMonitor';
import { SiteRegistry, siteRegistryOf } from '../site/SiteRegistry';
import { EnergyTotals } from '../energy/EnergyMeter';
import { CapabilityValues, MeterMap, meterFloor } from './mappers';

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
  /** Cumulative meters of this device; their shown values are a floor for the site's totals. */
  protected readonly meters: MeterMap = {};
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

  /** Writes every value it can; one failed capability does not skip the others, all are reported. */
  async onSnapshot(snapshot: SiteSnapshot): Promise<void> {
    if (!this.getAvailable()) await this.setAvailable();
    const failed: string[] = [];
    for (const [capability, value] of Object.entries(this.mapCapabilities(snapshot))) {
      if (this.hasCapability(capability)) {
        await this.setCapabilityValue(capability, value).catch((error) => {
          failed.push(`${capability}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
    if (failed.length > 0) throw new Error(`${this.getName()} failed to write ${failed.join('; ')}`);
  }

  energyFloor(): Partial<EnergyTotals> {
    return meterFloor(this.meters, (capability) => (this.hasCapability(capability) ? this.getCapabilityValue(capability) : null));
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
