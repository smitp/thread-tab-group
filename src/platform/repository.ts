import { initialState, type AppState, type Repository } from '../core/types';

interface LocalStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

/** One writer per extension host; never synchronized to a browser account. */
export class LocalRepository implements Repository {
  private queue: Promise<unknown>;
  private state?: AppState;
  constructor(private storage: LocalStorage, ready: Promise<unknown> = Promise.resolve()) { this.queue = ready; }
  private async load(): Promise<AppState> {
    if (!this.state) {
      const stored = (await this.storage.get('threadState')).threadState as AppState | undefined;
      if (stored && stored.version !== 1) throw new Error('This version of Thread cannot read the saved data.');
      this.state = stored ?? initialState();
    }
    return this.state;
  }
  async read(): Promise<AppState> {
    await this.queue;
    return structuredClone(await this.load());
  }
  update(fn: (state: AppState) => void): Promise<void> {
    const task = this.queue.then(async () => {
      const draft = structuredClone(await this.load());
      fn(draft);
      await this.storage.set({ threadState: draft });
      this.state = draft;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
