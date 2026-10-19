import type { AppState } from '../../core/types';

interface Session { epoch: string; tabs: Record<string, string>; windows: Record<string, string> }
const KEY = 'threadSession';

/** Numeric Chrome IDs are authority only within a single browser session. */
export class ChromeSession {
  private state!: Session;
  private queue: Promise<unknown>;
  readonly ready: Promise<void>;
  constructor() {
    this.ready = this.initialize();
    this.queue = this.ready;
  }
  private async initialize() {
    const stored = (await chrome.storage.session.get(KEY))[KEY] as Session | undefined;
    this.state = stored ?? { epoch: crypto.randomUUID(), tabs: {}, windows: {} };
    if (!stored) await chrome.storage.session.set({ [KEY]: this.state });
    const local = await chrome.storage.local.get(['threadSessionEpoch', 'threadState']);
    if (local.threadSessionEpoch !== this.state.epoch) {
      const saved = local.threadState as AppState | undefined;
      if (saved && saved.version !== 1) throw new Error('This version of Thread cannot read the saved data.');
      // Chrome cannot attach opaque IDs to tabs across full browser restarts.
      // Never match by URL/title: duplicates and reused IDs make that unsafe.
      if (saved) {
        saved.threads = []; saved.windows = {}; saved.links = []; delete saved.job;
        await chrome.storage.local.set({ threadState: saved });
      }
      await chrome.storage.local.set({ threadSessionEpoch: this.state.epoch });
    }
  }
  private update<T>(fn: (state: Session) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = fn(draft);
      await chrome.storage.session.set({ [KEY]: draft });
      this.state = draft;
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  identify(ids: number[], windowId: number) {
    return this.update(s => ({ epoch: s.epoch,
      windowKey: s.windows[windowId] ??= crypto.randomUUID(),
      keys: ids.map(id => s.tabs[id] ??= crypto.randomUUID()),
    }));
  }
  async knownKey(id: number) { await this.queue; return this.state.tabs[id]; }
  async windowKey(id: number) { await this.queue; return this.state.windows[id]; }
  forget(id: number) { return this.update(s => { const key = s.tabs[id]; delete s.tabs[id]; return key; }); }
  forgetWindow(id: number) { return this.update(s => { const key = s.windows[id]; delete s.windows[id]; return key; }); }
}
