import { SiteDeviceDriver } from '../../lib/devices/SiteDeviceDriver';

class LivoltekGridDriver extends SiteDeviceDriver {
  protected readonly deviceNameSuffix = 'Grid';
}

module.exports = LivoltekGridDriver;
