import { DAILY_EXPORT_KWH, dailyExport, localDay } from '../../lib/devices/dailyExport';
import { GRID_METERS, gridCapabilities } from '../../lib/devices/mappers';
import { SiteDevice } from '../../lib/devices/SiteDevice';

const EXPORT_METER = 'meter_power.exported';
const IMPORT_METER = 'meter_power.imported';
const EXPORT_DAY_KEY = 'dailyExportDay';
const IMPORT_DAY_KEY = 'dailyImportDay'; // own key: a day can have its export but not yet its compensation
const EXPORT_CHECK_MS = 60_000;

/** Cumulative grid meter for Homey Energy: import power, imported kWh and the daily-export meter. */
class LivoltekGridDevice extends SiteDevice {
  protected readonly mapCapabilities = gridCapabilities;
  protected readonly meters = GRID_METERS;
  private exportTimer: NodeJS.Timeout | null = null;

  async onInit() {
    if (!this.hasCapability(EXPORT_METER)) await this.addCapability(EXPORT_METER);
    await super.onInit();
    // The timer comes first: a failing first check must not leave the device without it
    this.exportTimer = this.homey.setInterval(() => this.runDailyExport(), EXPORT_CHECK_MS);
    this.runDailyExport();
  }

  private runDailyExport() {
    this.checkDailyExport().catch((error) => this.error('daily export failed:', error));
  }

  async onUninit() {
    this.stopDailyExport();
    await super.onUninit();
  }

  async onDeleted() {
    this.stopDailyExport();
    await super.onDeleted();
  }

  /**
   * On the first check of each local day: adds the 1 Wh export, then the same 1 Wh to the import,
   * so Grid (import − export) and Home stay exact (see dailyExport.ts). Each step has its own day
   * key, written before its meter: a reboot in between skips a step for one day, never doubles it.
   */
  private async checkDailyExport() {
    const today = localDay(Date.now(), this.homey.clock.getTimezone());
    const next = dailyExport(this.getCapabilityValue(EXPORT_METER), this.getStoreValue(EXPORT_DAY_KEY) ?? null, today);
    if (next !== null) {
      await this.setStoreValue(EXPORT_DAY_KEY, next.day);
      await this.setCapabilityValue(EXPORT_METER, next.exportedKWh);
      this.log(`daily export: ${EXPORT_METER} = ${next.exportedKWh} kWh for ${next.day}`);
    }

    if (this.getStoreValue(IMPORT_DAY_KEY) === today) return;
    await this.setStoreValue(IMPORT_DAY_KEY, today);
    // The import is the site's energy total (each point rewrites the meter from it), so it is raised there
    const totals = this.sites().addImportedEnergy(this.siteId(), DAILY_EXPORT_KWH);
    if (totals === null) return;
    const imported = Math.round(totals.gridImportedKWh * 1000) / 1000;
    await this.setCapabilityValue(IMPORT_METER, imported);
    this.log(`daily export compensation: ${IMPORT_METER} = ${imported} kWh for ${today}`);
  }

  private stopDailyExport() {
    if (this.exportTimer !== null) this.homey.clearInterval(this.exportTimer);
    this.exportTimer = null;
  }
}

module.exports = LivoltekGridDevice;
