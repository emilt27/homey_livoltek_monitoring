import Homey from 'homey';
import { LivoltekAPI, LivoltekSite } from '../../lib/LivoltekAPI';

interface PairSession {
  secuid?: string;
  key?: string;
  userToken?: string;
  region?: 'global' | 'eu';
  api?: LivoltekAPI;
}

class LivoltekInverterDriver extends Homey.Driver {
  private pairSessions: Map<string, PairSession> = new Map();

  async onInit() {
    this.log('Livoltek Inverter driver initialized');
  }

  async onPair(session: Homey.Driver.PairSession) {
    const sessionId = Math.random().toString(36).substring(7);
    const pairData: PairSession = {};
    this.pairSessions.set(sessionId, pairData);

    this.log('Pairing session started:', sessionId);

    // Handle region selection
    session.setHandler('region_selected', async (data: { region: 'global' | 'eu' }) => {
      this.log('Region selected:', data.region);
      pairData.region = data.region;

      return true;
    });

    // Handle login (credentials validation from login form)
    session.setHandler('login', async (data: { secuid: string; key: string; userToken: string }) => {
      try {
        this.log('Validating credentials...');

        // Store credentials
        pairData.secuid = data.secuid;
        pairData.key = data.key;
        pairData.userToken = data.userToken;

        // Ensure region is set (fallback to EU if not selected)
        if (!pairData.region) {
          this.log('Region not set, defaulting to EU');
          pairData.region = 'eu';
        }

        this.log('Credentials stored, region:', pairData.region);

        // Create API instance
        pairData.api = new LivoltekAPI({
          secuid: pairData.secuid,
          key: pairData.key,
          userToken: pairData.userToken,
          region: pairData.region,
        }, this.homey);

        // Test login
        await pairData.api.login();

        this.log('Credentials validated successfully');

        return true;
      } catch (error) {
        this.error('Validation failed:', error);
        throw new Error(this.homey.__('pair.login_failed'));
      }
    });

    // Handle list devices
    session.setHandler('list_devices', async () => {
      try {
        this.log('Fetching sites list');

        if (!pairData.api) {
          throw new Error('API not initialized');
        }

        const sites = await pairData.api.getSites();
        this.log(`Found ${sites.length} sites`);

        // Convert sites to Homey device format
        const devices = sites.map((site: LivoltekSite) => ({
          name: site.name,
          data: {
            id: site.id,
            siteId: site.id,
          },
          store: {
            secuid: pairData.secuid,
            key: pairData.key,
            userToken: pairData.userToken,
            region: pairData.region,
          },
          settings: {
            poll_interval: 30, // Default 30 seconds
          },
        }));

        return devices;
      } catch (error) {
        this.error('Failed to list devices:', error);
        throw new Error(this.homey.__('pair.list_failed'));
      }
    });

    // Cleanup on disconnect
    session.setHandler('disconnect', async () => {
      this.log('Pairing session ended:', sessionId);
      this.pairSessions.delete(sessionId);
    });
  }

  async onRepair(session: Homey.Driver.PairSession, device: Homey.Device) {
    this.log('Repair session started for device:', device.getName());

    // Handle validate during repair
    session.setHandler('login', async (data: { secuid: string; key: string; userToken: string }) => {
      try {
        this.log('Repair credentials validation');

        // Create API instance to test credentials
        const api = new LivoltekAPI({
          secuid: data.secuid,
          key: data.key,
          userToken: data.userToken,
          region: device.getStoreValue('region') || 'eu',
        }, this.homey);

        // Test login
        await api.login();

        // Update device store with new credentials
        await device.setStoreValue('secuid', data.secuid);
        await device.setStoreValue('key', data.key);
        await device.setStoreValue('userToken', data.userToken);

        this.log('Repair credentials validated successfully');
        return true;
      } catch (error) {
        this.error('Repair validation failed:', error);
        throw new Error(this.homey.__('pair.login_failed'));
      }
    });
  }
}

module.exports = LivoltekInverterDriver;
