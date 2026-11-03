import FakeTimers from './FakeTimers';

/** Timers plus in-memory app settings: the part of the Homey instance the site registry uses. */
export default class FakeHomey extends FakeTimers {
  readonly values = new Map<string, unknown>();

  readonly settings = {
    get: (key: string) => this.values.get(key) ?? null,
    set: (key: string, value: unknown) => {
      this.values.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}
