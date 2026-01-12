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
      // Validate API response - skip if critical fields are null
      if (powerFlow.energyPower === null && powerFlow.powerGridPower === null && powerFlow.loadPower === null) {
        this.log('⚠️  Skipping poll - API returned invalid data (all power values are null)');
        return; // Skip this poll, keep previous values
      }

      // Make device available if it was unavailable
      if (!this.getAvailable()) {
        await this.setAvailable();
      }

      this.log('📊 Updating capabilities...');

      // Battery level (%)
      if (this.hasCapability('measure_battery')) {
        this.log(`  🔋 Battery: ${powerFlow.energySoc}%`);
        await this.setCapabilityValue('measure_battery', powerFlow.energySoc).catch(this.error);
      }

      // Load power (convert kW to W)
      if (this.hasCapability('measure_power')) {
        const loadPowerW = powerFlow.loadPower * 1000;
        this.log(`  ⚡ Load Power: ${loadPowerW}W (${powerFlow.loadPower}kW)`);
        await this.setCapabilityValue('measure_power', loadPowerW).catch(this.error);
      }

      // Grid import (convert kW to W)
      if (this.hasCapability('measure_power_grid_import')) {
        const gridPowerW = powerFlow.powerGridPower * 1000;
        this.log(`  🔌 Grid Import: ${gridPowerW}W (${powerFlow.powerGridPower}kW)`);
        await this.setCapabilityValue('measure_power_grid_import', gridPowerW).catch(this.error);
      }

      // Battery charge power (convert kW to W)
      if (this.hasCapability('measure_power_battery_charge')) {
        const batteryPowerW = powerFlow.energyPower * 1000;
        let batteryStatusText = 'idle';
        if (batteryPowerW > 0) {
          batteryStatusText = 'charging';
        } else if (batteryPowerW < 0) {
          batteryStatusText = 'discharging';
        }
        this.log(`  🔋⚡ Battery Power: ${batteryPowerW}W (${powerFlow.energyPower}kW) - ${batteryStatusText}`);
        await this.setCapabilityValue('measure_power_battery_charge', batteryPowerW).catch(this.error);
      }

      // Battery consumption - only when discharging (convert kW to W)
      if (this.hasCapability('measure_power_battery_consumption')) {
        const batteryConsumption = Math.max(0, -powerFlow.energyPower * 1000);
        this.log(`  🔋📉 Battery Consumption: ${batteryConsumption}W`);
        await this.setCapabilityValue('measure_power_battery_consumption', batteryConsumption).catch(this.error);
      }

      // Battery status (enum)
      if (this.hasCapability('battery_status')) {
        const status = this.determineBatteryStatus(powerFlow.energyPower, powerFlow.energyStatus);
        this.log(`  🔋📊 Battery Status: ${status}`);
        await this.setCapabilityValue('battery_status', status).catch(this.error);
      }

      // Grid alarm (inverted - alarm when grid is OFF)
      const isGridActive = this.isGridActive(powerFlow);
      if (this.hasCapability('alarm_grid')) {
        this.log(`  🔌⚠️  Grid: ${isGridActive ? 'ACTIVE' : 'DISCONNECTED'}`);
        await this.setCapabilityValue('alarm_grid', !isGridActive).catch(this.error);
      }

      // Trigger flow cards for grid status changes
      await this.handleGridStatusChange(isGridActive, powerFlow);

      // Trigger flow cards for battery status changes
      const batteryStatus = this.determineBatteryStatus(powerFlow.energyPower, powerFlow.energyStatus);
      await this.handleBatteryStatusChange(batteryStatus, powerFlow);

      // Trigger flow cards for battery level changes
      await this.handleBatteryLevelChange(powerFlow.energySoc);

      // Trigger flow cards for load power changes
      await this.handleLoadPowerChange(powerFlow.loadPower * 1000);

    } catch (error) {
      this.error('Failed to update capabilities:', error);
    }
  }

  /**
   * Determine battery status based on power and status string
   */
  private determineBatteryStatus(energyPower: number, energyStatus: string): string {
    // If status is provided by API, use it
    this.log(`  Determine battery status from ${energyStatus} and power ${energyPower}`);

    if (energyStatus) {
      const status = energyStatus.toLowerCase();
      if (status.includes('discharg')) return 'discharging';
      if (status.includes('charg')) return 'charging';
      if (status.includes('idle') || status.includes('standby')) return 'idle';
    }

    // Fallback to power-based detection
    if (energyPower > 0.05) return 'charging'; // More than 50W charging
    if (energyPower < -0.05) return 'discharging'; // More than 50W discharging
    return 'idle';
  }

  /**
   * Check if grid is active
   */
  private isGridActive(powerFlow: CurrentPowerFlow): boolean {
    // Method 1: Check status string
    if (powerFlow.powerGridStatus) {
      const status = powerFlow.powerGridStatus.toLowerCase();
      if (status.includes('active') || status.includes('on') || status.includes('connect')) {
        return true;
      }
      if (status.includes('inactive') || status.includes('off') || status.includes('disconnect')) {
        return false;
      }
    }

    // Method 2: Check energyStatus is Importing
    if (powerFlow.energyStatus.toLowerCase() === 'importing') {
      return true;
    }

    // Method 3: Check power level
    return powerFlow.powerGridPower > 0.05; // More than 50W
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
        `energyStatus: ${powerFlow.energyStatus}`,
        `energyPower: ${powerFlow.energyPower}kW`,
        `energySoc: ${powerFlow.energySoc}%`,
        `pvStatus: ${powerFlow.pvStatus || 'N/A'}`,
        `pvPower: ${powerFlow.pvPower}kW`,
        `powerGridStatus: ${powerFlow.powerGridStatus || 'N/A'}`,
        `powerGridPower: ${powerFlow.powerGridPower}kW`,
        `loadStatus: ${powerFlow.loadStatus}`,
        `loadPower: ${powerFlow.loadPower}kW`,
        `timestamp: ${powerFlow.timestamp}`,
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
