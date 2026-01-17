'use strict';

import Homey from 'homey';

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Livoltek Monitor app has been initialized');

    // Register flow card condition handlers once for the entire app
    this.registerFlowCardConditions();
  }

  /**
   * Register flow card condition handlers
   * This is done at app level to avoid memory leaks from multiple registrations
   */
  private registerFlowCardConditions() {
    // Grid active condition
    this.homey.flow.getConditionCard('grid_active')
      .registerRunListener(async (args) => {
        const { device } = args;
        const isActive = !device.getCapabilityValue('alarm_grid');
        this.log(`Grid active condition checked: ${isActive}`);
        return isActive;
      });

    // Battery status is condition
    this.homey.flow.getConditionCard('battery_status_is')
      .registerRunListener(async (args) => {
        const { device } = args;
        const currentStatus = device.getCapabilityValue('battery_status');
        const matches = currentStatus === args.status;
        this.log(`Battery status is ${args.status}: ${matches} (current: ${currentStatus})`);
        return matches;
      });

    // Battery level comparison condition
    this.homey.flow.getConditionCard('battery_level_compare')
      .registerRunListener(async (args) => {
        const { device } = args;
        const batteryLevel = device.getCapabilityValue('measure_battery') || 0;
        const result = args.comparison === 'greater'
          ? batteryLevel > args.threshold
          : batteryLevel < args.threshold;
        this.log(`Battery level ${args.comparison} ${args.threshold}%: ${result} (current: ${batteryLevel}%)`);
        return result;
      });

    // Load power comparison condition
    this.homey.flow.getConditionCard('load_compare')
      .registerRunListener(async (args) => {
        const { device } = args;
        const loadPower = device.getCapabilityValue('measure_power') || 0;
        const result = args.comparison === 'greater'
          ? loadPower > args.threshold
          : loadPower < args.threshold;
        this.log(`Load power ${args.comparison} ${args.threshold}W: ${result} (current: ${loadPower}W)`);
        return result;
      });

    this.log('Flow card conditions registered');
  }

};
