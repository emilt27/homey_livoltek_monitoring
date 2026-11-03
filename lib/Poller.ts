export interface TimerApi {
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timeoutId?: NodeJS.Timeout): void;
}

/**
 * Runs an async task repeatedly, scheduling each next run only after the previous one completes.
 *
 * Every start/stop bumps a generation counter: a run that was already in flight when the poller
 * was stopped or restarted finishes without scheduling a new timer, so at most one chain is alive.
 */
export class Poller {
  private readonly timers: TimerApi;
  private readonly task: () => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private generation = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(timers: TimerApi, task: () => Promise<void>, onError: (error: unknown) => void) {
    this.timers = timers;
    this.task = task;
    this.onError = onError;
  }

  /**
   * Stop any running chain, run the task immediately and keep running it every intervalMs
   */
  async start(intervalMs: number): Promise<void> {
    this.stop();
    await this.runAndReschedule(this.generation, intervalMs);
  }

  stop(): void {
    this.generation += 1;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async runAndReschedule(generation: number, intervalMs: number): Promise<void> {
    try {
      await this.task();
    } catch (error) {
      this.onError(error);
    }

    if (generation !== this.generation) return;

    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.runAndReschedule(generation, intervalMs).catch(this.onError);
    }, intervalMs);
  }
}
