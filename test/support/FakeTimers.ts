import assert from 'node:assert/strict';
import { TimerApi } from '../../lib/Poller';
import flush from './flush';

interface PendingTimer {
  callback: () => void;
  ms: number;
  cleared: boolean;
}

/** Records scheduled timeouts; tests fire them explicitly instead of waiting. */
export default class FakeTimers implements TimerApi {
  readonly timers: PendingTimer[] = [];

  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    this.timers.push({ callback, ms, cleared: false });
    return (this.timers.length - 1) as unknown as NodeJS.Timeout;
  }

  clearTimeout(timeoutId?: NodeJS.Timeout): void {
    const timer = this.timers[timeoutId as unknown as number];
    if (timer) timer.cleared = true;
  }

  active(): PendingTimer[] {
    return this.timers.filter((timer) => !timer.cleared);
  }

  fire(index: number): void {
    const timer = this.timers[index];
    timer.cleared = true;
    timer.callback();
  }

  /** Fires the most recently scheduled pending timer and lets the resulting work settle. */
  async fireNext(): Promise<void> {
    const timer = this.active().at(-1);
    assert.ok(timer, 'no pending timer');
    timer.cleared = true;
    timer.callback();
    await flush();
  }
}
