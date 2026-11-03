import { SiteDeviceDriver } from '../../lib/devices/SiteDeviceDriver';

class LivoltekBatteryDriver extends SiteDeviceDriver {
  protected readonly deviceNameSuffix = 'Battery';
}

module.exports = LivoltekBatteryDriver;
