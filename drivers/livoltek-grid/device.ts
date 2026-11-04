import { GRID_METERS, gridCapabilities } from '../../lib/devices/mappers';
import { SiteDevice } from '../../lib/devices/SiteDevice';

const EXPORT_METER = 'meter_power.exported';

/** Cumulative grid meter for Homey Energy: import power, imported kWh and a zero export meter. */
class LivoltekGridDevice extends SiteDevice {
  protected readonly mapCapabilities = gridCapabilities;
  protected readonly meters = GRID_METERS;

  async onInit() {
    if (!this.hasCapability(EXPORT_METER)) await this.addCapability(EXPORT_METER);
    await super.onInit();
  }
}

module.exports = LivoltekGridDevice;
