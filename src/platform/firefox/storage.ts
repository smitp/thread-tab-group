import { initialState, type AppState, type Repository } from '../../core/types';

export class FirefoxRepository implements Repository {
  private queue: Promise<unknown> = Promise.resolve();
  private state?: AppState;
  private async load(): Promise<AppState> {
    if (!this.state) {
      const stored = (await browser.storage.local.get('threadState')).threadState;
      if (stored && stored.version !== 1) throw new Error('This version of Thread cannot read the saved data.');
      this.state = stored ?? initialState();
    }
    return this.state!;
  }
  async read(): Promise<AppState> {
    await this.queue;
    return structuredClone(await this.load());
  }
  update(fn: (state: AppState) => void): Promise<void> {
    const task = this.queue.then(async () => {
      const draft = structuredClone(await this.load());
      fn(draft);
      await browser.storage.local.set({ threadState: draft });
      this.state = draft;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
