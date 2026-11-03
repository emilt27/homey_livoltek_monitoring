import { batteryCapabilities } from '../../lib/devices/mappers';
import { SiteDevice } from '../../lib/devices/SiteDevice';

/** Home battery for Homey Energy: power (+ charging), state of charge, charged/discharged kWh. */
class LivoltekBatteryDevice extends SiteDevice {
  protected readonly mapCapabilities = batteryCapabilities;
}

module.exports = LivoltekBatteryDevice;
