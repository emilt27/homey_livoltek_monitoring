import { inverterCapabilities } from '../../lib/devices/mappers';
import { SiteDevice } from '../../lib/devices/SiteDevice';
import { SiteSnapshot } from '../../lib/site/SiteMonitor';

type DeviceSettings = { [key: string]: boolean | string | number | undefined | null };

const DEVICE_CLASS = 'other';

/**
 * Overview device of a Livoltek site: grid state, battery and load values and the flow triggers.
 * Polling and all data interpretation live in the app-level SiteMonitor shared with the
 * battery and grid devices; this device only shows its snapshots.
 */
export default class LivoltekInverterDevice extends SiteDevice {
  protected readonly mapCapabilities = inverterCapabilities;
  private previousBatteryLevel: number | null = null;
  private previousLoadPower: number | null = null;
  private previousBatteryStatus: string | null = null;

  async onInit() {
    await this.migrateCapabilities();
    await super.onInit();
    this.sites().setDebug(this.siteId(), this.getSetting('debug_logging') === true);
    this.log('Livoltek Inverter device initialized');
  }

  async onSettings({ newSettings, changedKeys }: {
    oldSettings: DeviceSettings;
    newSettings: DeviceSettings;
    changedKeys: string[];
  }): Promise<string | void> {
    if (changedKeys.includes('debug_logging')) {
      this.log(`Debug logging ${newSettings.debug_logging ? 'enabled' : 'disabled'}`);
      this.sites().setDebug(this.siteId(), newSettings.debug_logging === true);
    }
  }

  /**
   * Use the credentials the driver saved to the stores of the site's devices during repair
   */
  reloadCredentials() {
    this.sites().updateCredentials(this.siteId(), this.credentials());
    this.log('API client reinitialized with new credentials');
  }

  /** Besides marking the device unavailable: one Homey notification and the flow trigger. */
  async onAuthorizationFailed(reason: string): Promise<void> {
    await super.onAuthorizationFailed(reason);
    await this.homey.notifications.createNotification({
      excerpt: this.homey.__('error.authorization_notification', { name: this.getName() }),
    }).catch(this.error);
    await this.homey.flow.getDeviceTriggerCard('authorization_failed').trigger(this, { reason }).catch(this.error);
  }

  /**
   * Flows fire even when a capability write failed (the grid change exists on this snapshot only);
   * the write error is reported afterwards. Value triggers also run on refreshes: a state of charge
   * filled in later must reach battery_level_below, and unchanged values never fire twice.
   */
  async onSnapshot(snapshot: SiteSnapshot): Promise<void> {
    let writeError: unknown = null;
    await super.onSnapshot(snapshot).catch((error) => {
      writeError = error;
    });
    if (snapshot.grid.changed) await this.triggerGridChange(snapshot);
    await this.triggerValueChanges(snapshot);
    if (writeError !== null) throw writeError;
  }

  /**
   * Devices paired before the Homey Energy integration were "solar panels" whose measure_power was
   * the house load and whose measure_battery made Homey treat them as battery powered; both values
   * now live in own capabilities so Energy does not count them.
   */
  private async migrateCapabilities() {
    if (this.hasCapability('measure_power')) await this.removeCapability('measure_power');
    if (!this.hasCapability('measure_power_load')) await this.addCapability('measure_power_load');
    if (this.hasCapability('measure_battery')) await this.removeCapability('measure_battery');
    if (!this.hasCapability('measure_battery_soc')) await this.addCapability('measure_battery_soc');
    if (this.getClass() !== DEVICE_CLASS) await this.setClass(DEVICE_CLASS);
  }

  private async triggerGridChange({ grid, sample, values }: SiteSnapshot) {
    this.log(`Grid ${grid.state === 'on' ? 'restored' : 'disconnected'}: ${grid.reason}`);
    const debugInfo = `${grid.reason}; reported grid ${sample.gridW} W, load ${sample.loadW} W, `
      + `battery ${sample.batteryW} W, soc ${sample.soc} %, status ${sample.energyStatus}`;
    await this.homey.flow.getDeviceTriggerCard(grid.state === 'on' ? 'grid_restored' : 'grid_disconnected')
      .trigger(this, { battery_level: values.soc ?? this.getCapabilityValue('measure_battery_soc'), debug_info: debugInfo })
      .catch(this.error);
  }

  private async triggerValueChanges({ values }: SiteSnapshot) {
    const { soc, loadW, batteryStatus } = values;

    if (soc !== null) {
      // The app-level run listener fires only flows whose threshold lies between previous and current
      if (this.previousBatteryLevel !== null && soc < this.previousBatteryLevel) {
        await this.homey.flow.getDeviceTriggerCard('battery_level_below')
          .trigger(this, { battery_level: soc }, { previous: this.previousBatteryLevel, current: soc })
          .catch(this.error);
      }
      this.previousBatteryLevel = soc;
    }

    if (loadW !== null) {
      if (this.previousLoadPower !== null && loadW > this.previousLoadPower) {
        await this.homey.flow.getDeviceTriggerCard('load_exceeds')
          .trigger(this, { load_power: loadW }, { previous: this.previousLoadPower, current: loadW })
          .catch(this.error);
      }
      this.previousLoadPower = loadW;
    }

    if (batteryStatus !== null) {
      // The app-level run listener fires only flows whose selected status matches
      if (this.previousBatteryStatus !== null && batteryStatus !== this.previousBatteryStatus) {
        await this.homey.flow.getDeviceTriggerCard('battery_status_changed')
          .trigger(this, { battery_level: soc ?? this.getCapabilityValue('measure_battery_soc') }, { status: batteryStatus })
          .catch(this.error);
      }
      this.previousBatteryStatus = batteryStatus;
    }
  }
}

module.exports = LivoltekInverterDevice;
