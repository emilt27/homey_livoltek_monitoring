import { gridCapabilities } from '../../lib/devices/mappers';
import { SiteDevice } from '../../lib/devices/SiteDevice';

/** Cumulative grid meter for Homey Energy: import power and imported kWh. */
class LivoltekGridDevice extends SiteDevice {
  protected readonly mapCapabilities = gridCapabilities;
}

module.exports = LivoltekGridDevice;
