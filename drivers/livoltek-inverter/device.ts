import Homey from 'homey';
import { LivoltekAPI, CurrentPowerFlow } from '../../lib/LivoltekAPI';
import { Poller } from '../../lib/Poller';

export interface LivoltekDeviceData {
  id: string;
  siteId: string;
}

export interface LivoltekDeviceStore {
  secuid: string;
  key: string;
  userToken: string;
  region: 'global' | 'eu';
}

type DeviceSettings = { [key: string]: boolean | string | number | undefined | null };

const DEFAULT_POLL_INTERVAL_S = 30;

export class LivoltekInverterDevice extends Homey.Device {
  private api!: LivoltekAPI;
  private poller!: Poller;
  private debugLogging = false;
  private previousGridStatus: boolean | null = null;
  private previousBatteryStatus: string | null = null;
  private previousBatteryLevel: number | null = null;
  private previousLoadPower: number | null = null;

  // Battery power threshold in kW (10W) - ignore fluctuations below this value
  private readonly BATTERY_POWER_THRESHOLD_KW = 0.01;

  /**
   * Check if value is valid (not null, undefined, empty string, 'null' string, or NaN)
   */
  private _hasValue(value: unknown): boolean {
    if (value === null) return false;
    if (value === undefined) return false;
    if (value === 'null') return false;
    if (value === '') return false;

    return !(typeof value === 'number' && Number.isNaN(value));
  }

  async onInit() {
    this.log('Livoltek Inverter device initialized');

    this.createApi();
    this.applyDebugSetting(this.getSetting('debug_logging') === true);

    this.poller = new Poller(
      this.homey,
      () => this.poll(),
      (error) => this.error('Polling error:', error),
    );
    const intervalMs = this.pollIntervalMs(this.getSettings());
    await this.poller.start(() => intervalMs);

    this.log('Device initialized successfully');
  }

  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: DeviceSettings;
    newSettings: DeviceSettings;
    changedKeys: string[];
  }): Promise<string | void> {
    this.log('Livoltek Inverter device settings changed');

    if (changedKeys.includes('debug_logging')) {
      this.log(`Debug logging ${newSettings.debug_logging ? 'enabled' : 'disabled'}`);
      this.applyDebugSetting(newSettings.debug_logging === true);
    }

    // getSettings() still returns the old values here, so the new interval is taken from newSettings
    if (changedKeys.includes('poll_interval')) {
      this.log(`Poll interval changed from ${oldSettings.poll_interval} to ${newSettings.poll_interval}`);
      const intervalMs = this.pollIntervalMs(newSettings);
      await this.poller.start(() => intervalMs);
    }
  }

  /**
   * Recreate the API client with the credentials the driver saved to the store during repair
   */
  reloadCredentials() {
    this.createApi();
    this.applyDebugSetting(this.debugLogging);
    this.log('API client reinitialized with new credentials');
  }

  async onUninit() {
    this.log('Livoltek Inverter device is being uninitialized');
    this.poller.stop();
  }

  async onDeleted() {
    this.log('Livoltek Inverter device has been deleted');
    this.poller.stop();
  }

  private createApi() {
    const store = this.getStore() as LivoltekDeviceStore;

    this.api = new LivoltekAPI({
      secuid: store.secuid,
      key: store.key,
      userToken: store.userToken,
      region: store.region,
    }, this.homey);
  }

  private applyDebugSetting(enabled: boolean) {
    this.debugLogging = enabled;
    this.api.setDebug(enabled);
  }

  /**
   * Log only when debug logging is enabled in device settings
   */
  private debug(...args: unknown[]) {
    if (this.debugLogging) {
      this.log(...args);
    }
  }

  private pollIntervalMs(settings: DeviceSettings): number {
    return ((settings.poll_interval as number) || DEFAULT_POLL_INTERVAL_S) * 1000;
  }

  /**
   * Poll the Livoltek API and update capabilities
   */
  private async poll() {
    const timestamp = new Date().toISOString();
    this.debug(`[${timestamp}] 🔄 Starting poll...`);

    try {
      const data = this.getData() as LivoltekDeviceData;
      this.debug(`[${timestamp}] 📡 Fetching data for site: ${data.siteId}`);

      const powerFlow = await this.api.getCurrentPowerFlow(data.siteId);

      this.debug(`[${timestamp}] ✅ Power flow data received:`, JSON.stringify(powerFlow, null, 2));

      await this.updateCapabilities(powerFlow);

      this.log(`Poll OK: SoC ${powerFlow.energySoc}%, load ${powerFlow.loadPower} kW, `
        + `grid ${powerFlow.powerGridPower} kW, battery ${powerFlow.energyPower} kW, energyStatus ${powerFlow.energyStatus}`);
    } catch (error) {
      this.error(`[${timestamp}] ❌ Failed to poll Livoltek API:`, error);

      // Set device as unavailable
      if (this.getAvailable()) {
        await this.setUnavailable(this.homey.__('error.connection_failed'));
      }
    }
  }

  /**
   * Update all device capabilities based on power flow data
   */
  private async updateCapabilities(powerFlow: CurrentPowerFlow) {
    try {
      // Make device available if it was unavailable
      if (!this.getAvailable()) {
        await this.setAvailable();
      }

      this.debug('📊 Updating capabilities...');

      // Battery level (%)
      if (this.hasCapability('measure_battery') && this._hasValue(powerFlow.energySoc)) {
        this.debug(`  🔋 Battery: ${powerFlow.energySoc}%`);
        await this.setCapabilityValue('measure_battery', powerFlow.energySoc).catch(this.error);
        // Trigger flow cards for battery level changes
        await this.handleBatteryLevelChange(powerFlow.energySoc);
      }

      // Load power (convert kW to W)
      if (this.hasCapability('measure_power') && this._hasValue(powerFlow.loadPower)) {
        const loadPowerW = powerFlow.loadPower * 1000;
        this.debug(`  ⚡ Load Power: ${loadPowerW}W (${powerFlow.loadPower}kW)`);
        await this.setCapabilityValue('measure_power', loadPowerW).catch(this.error);
        // Trigger flow cards for load power changes
        await this.handleLoadPowerChange(loadPowerW);
      }

      // Grid import (convert kW to W)
      if (this.hasCapability('measure_power_grid_import') && this._hasValue(powerFlow.powerGridPower)) {
        const gridPowerW = powerFlow.powerGridPower * 1000;
        this.debug(`  🔌 Grid Import: ${gridPowerW}W (${powerFlow.powerGridPower}kW)`);
        await this.setCapabilityValue('measure_power_grid_import', gridPowerW).catch(this.error);
      }

      // Battery charge power (convert kW to W)
      if (this.hasCapability('measure_power_battery_charge') && this._hasValue(powerFlow.energyPower)) {
        const batteryPowerW = powerFlow.energyPower * 1000;
        this.debug(`  🔋⚡ Battery Power: ${batteryPowerW}W (${powerFlow.energyPower}kW)`);
        await this.setCapabilityValue('measure_power_battery_charge', batteryPowerW).catch(this.error);
      }

      // Battery consumption - only when discharging (convert kW to W)
      if (this.hasCapability('measure_power_battery_consumption') && this._hasValue(powerFlow.energyPower)) {
        const batteryConsumption = Math.max(0, -powerFlow.energyPower * 1000);
        this.debug(`  🔋📉 Battery Consumption: ${batteryConsumption}W`);
        await this.setCapabilityValue('measure_power_battery_consumption', batteryConsumption).catch(this.error);
      }

      // Battery status (enum)
      if (this.hasCapability('battery_status')) {
        const status = this.determineBatteryStatus(powerFlow.energyPower, powerFlow.energyStatus);
        if (status !== null) {
          this.debug(`  🔋📊 Battery Status: ${status}`);
          await this.setCapabilityValue('battery_status', status).catch(this.error);
          // Trigger flow cards for battery status changes
          await this.handleBatteryStatusChange(status, powerFlow);
        }
      }

      // Grid alarm (inverted - alarm when grid is OFF)
      const isGridActive = this.isGridActive(powerFlow);

      // Only update if we have valid status (not null)
      if (isGridActive !== null) {
        if (this.hasCapability('alarm_grid')) {
          this.debug(`  🔌⚠️  Grid: ${isGridActive ? 'ACTIVE' : 'DISCONNECTED'}`);
          await this.setCapabilityValue('alarm_grid', !isGridActive).catch(this.error);
        }

        // Trigger flow cards for grid status changes
        await this.handleGridStatusChange(isGridActive, powerFlow);
      } else {
        this.log('  🔌⚠️  Grid: UNKNOWN (keeping previous status)');
      }

    } catch (error) {
      this.error('Failed to update capabilities:', error);
    }
  }

  /**
   * Determine battery status based on power and status string
   * Returns null if status cannot be determined (keep previous value)
   */
  private determineBatteryStatus(energyPower: number, energyStatus: string): string | null {
    this.debug(`  Determine battery status from ${energyStatus} and power ${energyPower}`);

    if (energyStatus) {
      const status = energyStatus.trim().toLowerCase();

      if (status === 'charging') {
        return 'charging';
      }
      if (status === 'discharging') {
        return 'discharging';
      }
      if (status === 'idle') {
        return 'idle';
      }
      // "idel" (API typo) - skip to fallback
    }

    // Fallback to power-based detection
    if (this._hasValue(energyPower)) {
      if (energyPower > this.BATTERY_POWER_THRESHOLD_KW) return 'charging';
      if (energyPower < -this.BATTERY_POWER_THRESHOLD_KW) return 'discharging';
      return 'idle';
    }

    // Cannot determine - keep previous value
    this.log('⚠️  Cannot determine battery status - keeping previous value');
    return null;
  }

  /**
   * Check if grid is active based on energyStatus
   * Returns null if status cannot be determined (API returned invalid data)
   */
  private isGridActive(powerFlow: CurrentPowerFlow): boolean | null {
    if (!this._hasValue(powerFlow.energyStatus) || powerFlow.energyStatus.trim().toLowerCase() === 'idel') {
      this.debug('⚠️  energyStatus is null or "idel" - cannot determine grid status');
      return null;
    }

    const energyStatus = powerFlow.energyStatus.trim().toLowerCase();

    // Grid is ACTIVE when:
    // - "Importing" - importing power from grid
    // - "charging" - battery charging from grid
    if (energyStatus === 'importing' || energyStatus === 'charging') {
      return true;
    }

    // All other cases - grid is INACTIVE
    return false;
  }

  /**
   * Handle grid status changes and trigger flow cards
   */
  private async handleGridStatusChange(isGridActive: boolean, powerFlow: CurrentPowerFlow) {
    // Check if status changed
    if (this.previousGridStatus === null) {
      // First run - just store status
      this.previousGridStatus = isGridActive;
      return;
    }

    if (this.previousGridStatus !== isGridActive) {
      this.log(`Grid status changed: ${this.previousGridStatus ? 'ON' : 'OFF'} -> ${isGridActive ? 'ON' : 'OFF'}`);

      // Build debug info string with ALL fields from API
      const debugInfo = [
        `energyStatus: ${powerFlow.energyStatus} (${typeof powerFlow.energyStatus})`,
        `energyPower: ${powerFlow.energyPower}kW (${typeof powerFlow.energyPower})`,
        `energySoc: ${powerFlow.energySoc}% (${typeof powerFlow.energySoc})`,
        `pvStatus: ${powerFlow.pvStatus} (${typeof powerFlow.pvStatus})`,
        `pvPower: ${powerFlow.pvPower}kW (${typeof powerFlow.pvPower})`,
        `powerGridStatus: ${powerFlow.powerGridStatus} (${typeof powerFlow.powerGridStatus})`,
        `powerGridPower: ${powerFlow.powerGridPower}kW (${typeof powerFlow.powerGridPower})`,
        `loadStatus: ${powerFlow.loadStatus} (${typeof powerFlow.loadStatus})`,
        `loadPower: ${powerFlow.loadPower}kW (${typeof powerFlow.loadPower})`,
        `timestamp: ${powerFlow.timestamp} (${typeof powerFlow.timestamp})`,
      ].join('; ');

      if (isGridActive) {
        // Grid restored
        await this.homey.flow.getDeviceTriggerCard('grid_restored').trigger(this, {
          battery_level: powerFlow.energySoc,
          debug_info: debugInfo,
        }).catch(this.error);
      } else {
        // Grid disconnected
        await this.homey.flow.getDeviceTriggerCard('grid_disconnected').trigger(this, {
          battery_level: powerFlow.energySoc,
          debug_info: debugInfo,
        }).catch(this.error);
      }

      this.previousGridStatus = isGridActive;
    }
  }

  /**
   * Handle battery status changes and trigger flow cards
   */
  private async handleBatteryStatusChange(batteryStatus: string, powerFlow: CurrentPowerFlow) {
    // Check if status changed
    if (this.previousBatteryStatus === null) {
      // First run - just store status
      this.previousBatteryStatus = batteryStatus;
      return;
    }

    if (this.previousBatteryStatus !== batteryStatus) {
      this.log(`Battery status changed: ${this.previousBatteryStatus} -> ${batteryStatus}`);

      // The app-level run listener fires only flows whose selected status matches
      await this.homey.flow.getDeviceTriggerCard('battery_status_changed').trigger(this, {
        battery_level: powerFlow.energySoc,
      }, {
        status: batteryStatus,
      }).catch(this.error);

      this.previousBatteryStatus = batteryStatus;
    }
  }

  /**
   * Handle battery level changes and trigger flow cards
   */
  private async handleBatteryLevelChange(batteryLevel: number) {
    // Check if level crossed below threshold
    if (this.previousBatteryLevel === null) {
      // First run - just store level
      this.previousBatteryLevel = batteryLevel;
      return;
    }

    // The app-level run listener fires only flows whose threshold lies between previous and current
    if (this.previousBatteryLevel > batteryLevel) {
      await this.homey.flow.getDeviceTriggerCard('battery_level_below').trigger(this, {
        battery_level: batteryLevel,
      }, {
        previous: this.previousBatteryLevel,
        current: batteryLevel,
      }).catch(this.error);
    }

    this.previousBatteryLevel = batteryLevel;
  }

  /**
   * Handle load power changes and trigger flow cards
   */
  private async handleLoadPowerChange(loadPower: number) {
    // Check if load crossed above threshold
    if (this.previousLoadPower === null) {
      // First run - just store power
      this.previousLoadPower = loadPower;
      return;
    }

    // The app-level run listener fires only flows whose threshold lies between previous and current
    if (this.previousLoadPower < loadPower) {
      await this.homey.flow.getDeviceTriggerCard('load_exceeds').trigger(this, {
        load_power: loadPower,
      }, {
        previous: this.previousLoadPower,
        current: loadPower,
      }).catch(this.error);
    }

    this.previousLoadPower = loadPower;
  }
}

module.exports = LivoltekInverterDevice;
