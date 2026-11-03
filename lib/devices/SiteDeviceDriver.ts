import Homey from 'homey';
import { LivoltekCredentials } from '../LivoltekAPI';
import { SiteDeviceData } from './SiteDevice';

export const INVERTER_DRIVER_ID = 'livoltek-inverter';
export const SITE_DRIVER_IDS = [INVERTER_DRIVER_ID, 'livoltek-battery', 'livoltek-grid'];

/**
 * Driver of a device that shows a site of an already paired inverter (battery, grid meter):
 * pairing lists those sites and copies their credentials, so they are not entered again.
 */
export abstract class SiteDeviceDriver extends Homey.Driver {
  protected abstract readonly deviceNameSuffix: string;

  async onPairListDevices() {
    const inverters = this.homey.drivers.getDriver(INVERTER_DRIVER_ID).getDevices();
    if (inverters.length === 0) throw new Error(this.homey.__('pair.no_inverter'));

    return inverters.map((inverter) => {
      const { siteId } = inverter.getData() as SiteDeviceData;
      return {
        name: `${inverter.getName()} ${this.deviceNameSuffix}`,
        data: { id: siteId, siteId },
        store: inverter.getStore() as LivoltekCredentials,
      };
    });
  }
}

/** Writes new credentials to every device of the site (inverter, battery, grid). */
export async function saveSiteCredentials(
  homey: Homey.Driver['homey'],
  siteId: string,
  credentials: Pick<LivoltekCredentials, 'secuid' | 'key' | 'userToken'>,
): Promise<void> {
  const devices = SITE_DRIVER_IDS
    .flatMap((driverId) => homey.drivers.getDriver(driverId).getDevices())
    .filter((device) => (device.getData() as SiteDeviceData).siteId === siteId);

  await Promise.all(devices.map(async (device) => {
    await device.setStoreValue('secuid', credentials.secuid);
    await device.setStoreValue('key', credentials.key);
    await device.setStoreValue('userToken', credentials.userToken);
  }));
}
