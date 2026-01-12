import Homey from 'homey';
import { LivoltekAPI, CurrentPowerFlow } from '../../lib/LivoltekAPI';

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

export class LivoltekInverterDevice extends Homey.Device {
  private api!: LivoltekAPI;
  private pollInterval: NodeJS.Timeout | null = null;
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

    // Get device store
    const store = this.getStore() as LivoltekDeviceStore;

    // Initialize API client
    this.api = new LivoltekAPI({
      secuid: store.secuid,
      key: store.key,
      userToken: store.userToken,
      region: store.region,
    }, this.homey);

    // Register capability listeners for settings
    this.registerCapabilityListener('measure_battery', async () => {
      // Read-only capability
    });

    // Register flow card condition handlers
    this.registerFlowCardConditions();

    // Start polling
    await this.startPolling();

    this.log('Device initialized successfully');
  }

  /**
   * Register flow card condition handlers
   */
  private registerFlowCardConditions() {
    // Grid active condition
    this.homey.flow.getConditionCard('grid_active')
      .registerRunListener(async (args, state) => {
        const isActive = !this.getCapabilityValue('alarm_grid');
        this.log(`Grid active condition checked: ${isActive}`);
        return isActive;
      });

    // Battery status is condition
    this.homey.flow.getConditionCard('battery_status_is')
      .registerRunListener(async (args, state) => {
        const currentStatus = this.getCapabilityValue('battery_status');
        const matches = currentStatus === args.status;
        this.log(`Battery status is ${args.status}: ${matches} (current: ${currentStatus})`);
        return matches;
      });

    // Battery level comparison condition
    this.homey.flow.getConditionCard('battery_level_compare')
      .registerRunListener(async (args, state) => {
        const batteryLevel = this.getCapabilityValue('measure_battery') || 0;
        const result = args.comparison === 'greater'
          ? batteryLevel > args.threshold
          : batteryLevel < args.threshold;
        this.log(`Battery level ${args.comparison} ${args.threshold}%: ${result} (current: ${batteryLevel}%)`);
        return result;
      });

    // Load power comparison condition
    this.homey.flow.getConditionCard('load_compare')
      .registerRunListener(async (args, state) => {
        const loadPower = this.getCapabilityValue('measure_power') || 0;
        const result = args.comparison === 'greater'
          ? loadPower > args.threshold
          : loadPower < args.threshold;
        this.log(`Load power ${args.comparison} ${args.threshold}W: ${result} (current: ${loadPower}W)`);
        return result;
      });
  }

  async onAdded() {
    this.log('Livoltek Inverter device has been added');
  }

  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log('Livoltek Inverter device settings changed');

    // Handle poll_interval change
    if (changedKeys.includes('poll_interval')) {
      this.log(`Poll interval changed from ${oldSettings.poll_interval} to ${newSettings.poll_interval}`);
      await this.stopPolling();
      await this.startPolling();
    }
  }

  async onRenamed(name: string) {
    this.log('Livoltek Inverter device renamed to', name);
  }

  async onDeleted() {
    this.log('Livoltek Inverter device has been deleted');
    await this.stopPolling();
  }

  /**
   * Start polling the Livoltek API
   */
  private async startPolling() {
    const settings = this.getSettings();
    const pollInterval = (settings.poll_interval as number) || 30;

    this.log(`Starting polling with interval: ${pollInterval}s`);

    // Do initial poll
    await this.poll();

    // Set up interval using Homey's timer management
    // This ensures the timer is automatically cleared when the device is destroyed
    this.pollInterval = this.homey.setInterval(() => {
      this.poll().catch((error) => {
        this.error('Polling error:', error);
      });
    }, pollInterval * 1000);
  }

  /**
   * Stop polling
   */
  private async stopPolling() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.log('Polling stopped');
    }
  }

  /**
   * Poll the Livoltek API and update capabilities
   */
  private async poll() {
    const timestamp = new Date().toISOString();
    this.log(`[${timestamp}] 🔄 Starting poll...`);

    try {
      const data = this.getData() as LivoltekDeviceData;
      this.log(`[${timestamp}] 📡 Fetching data for site: ${data.siteId}`);

      const powerFlow = await this.api.getCurrentPowerFlow(data.siteId);

      this.log(`[${timestamp}] ✅ Power flow data received:`, JSON.stringify(powerFlow, null, 2));

      await this.updateCapabilities(powerFlow);

      this.log(`[${timestamp}] ✅ Poll completed successfully`);
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

      this.log('📊 Updating capabilities...');

      // Battery level (%)
      if (this.hasCapability('measure_battery') && this._hasValue(powerFlow.energySoc)) {
        this.log(`  🔋 Battery: ${powerFlow.energySoc}%`);
        await this.setCapabilityValue('measure_battery', powerFlow.energySoc).catch(this.error);
        // Trigger flow cards for battery level changes
        await this.handleBatteryLevelChange(powerFlow.energySoc);
      }

      // Load power (convert kW to W)
      if (this.hasCapability('measure_power') && this._hasValue(powerFlow.loadPower)) {
        const loadPowerW = powerFlow.loadPower * 1000;
        this.log(`  ⚡ Load Power: ${loadPowerW}W (${powerFlow.loadPower}kW)`);
        await this.setCapabilityValue('measure_power', loadPowerW).catch(this.error);
        // Trigger flow cards for load power changes
        await this.handleLoadPowerChange(loadPowerW);
      }

      // Grid import (convert kW to W)
      if (this.hasCapability('measure_power_grid_import') && this._hasValue(powerFlow.powerGridPower)) {
        const gridPowerW = powerFlow.powerGridPower * 1000;
        this.log(`  🔌 Grid Import: ${gridPowerW}W (${powerFlow.powerGridPower}kW)`);
        await this.setCapabilityValue('measure_power_grid_import', gridPowerW).catch(this.error);
      }

      // Battery charge power (convert kW to W)
      if (this.hasCapability('measure_power_battery_charge') && this._hasValue(powerFlow.energyPower)) {
        const batteryPowerW = powerFlow.energyPower * 1000;
        this.log(`  🔋⚡ Battery Power: ${batteryPowerW}W (${powerFlow.energyPower}kW)`);
        await this.setCapabilityValue('measure_power_battery_charge', batteryPowerW).catch(this.error);
      }

      // Battery consumption - only when discharging (convert kW to W)
      if (this.hasCapability('measure_power_battery_consumption') && this._hasValue(powerFlow.energyPower)) {
        const batteryConsumption = Math.max(0, -powerFlow.energyPower * 1000);
        this.log(`  🔋📉 Battery Consumption: ${batteryConsumption}W`);
        await this.setCapabilityValue('measure_power_battery_consumption', batteryConsumption).catch(this.error);
      }

      // Battery status (enum)
      if (this.hasCapability('battery_status')) {
        const status = this.determineBatteryStatus(powerFlow.energyPower, powerFlow.energyStatus);
        if (status !== null) {
          this.log(`  🔋📊 Battery Status: ${status}`);
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
          this.log(`  🔌⚠️  Grid: ${isGridActive ? 'ACTIVE' : 'DISCONNECTED'}`);
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
    this.log(`  Determine battery status from ${energyStatus} and power ${energyPower}`);

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
      this.log('⚠️  energyStatus is null or "idel" - cannot determine grid status');
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

      // Trigger battery_status_changed card with specific status
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

    // Trigger battery_level_below for all thresholds that were just crossed
    // Note: The trigger card has args with threshold, so it will filter based on user's chosen threshold
    if (this.previousBatteryLevel > batteryLevel) {
      // Battery level is dropping
      await this.homey.flow.getDeviceTriggerCard('battery_level_below').trigger(this, {
        battery_level: batteryLevel,
      }, {
        threshold: batteryLevel, // Pass current level for filtering
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

    // Trigger load_exceeds for all thresholds that were just crossed
    // Note: The trigger card has args with threshold, so it will filter based on user's chosen threshold
    if (this.previousLoadPower < loadPower) {
      // Load power is increasing
      await this.homey.flow.getDeviceTriggerCard('load_exceeds').trigger(this, {
        load_power: loadPower,
      }, {
        threshold: loadPower, // Pass current power for filtering
      }).catch(this.error);
    }

    this.previousLoadPower = loadPower;
  }
}

module.exports = LivoltekInverterDevice;
