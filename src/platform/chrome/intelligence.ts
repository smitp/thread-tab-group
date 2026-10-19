import type { Intelligence, Progress } from '../../core/types';

const PAGE = 'offscreen.html';
const abortError = () => new DOMException('Cancelled', 'AbortError');

/** Only inference runs offscreen. Browser changes and journals stay in the worker. */
export class ChromeIntelligence implements Intelligence {
  readonly owner = crypto.randomUUID();
  private creating?: Promise<void>;
  private leases = new Set<string>();
  private closing?: Promise<void>;
  async recover() {
    // A document from an earlier worker cannot own a current request. Close
    // it instead of resetting its idle timer: otherwise its idle message can
    // wake a new worker and renew an unused document forever.
    if (await this.exists()) await chrome.offscreen.closeDocument();
  }
  private async exists() {
    return (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(PAGE)] })).length > 0;
  }
  private async ensure() {
    if (this.closing) await this.closing;
    if (this.creating) return this.creating;
    this.creating = (async () => {
      if (!await this.exists()) {
        await chrome.offscreen.createDocument({ url: PAGE, reasons: [chrome.offscreen.Reason.WORKERS],
          justification: 'Run packaged on-device tab grouping models in a dedicated worker, without reading page contents.' });
        await this.send({ type: 'reset' });
      }
    })();
    try { await this.creating; } finally { this.creating = undefined; }
  }
  private async send(args: Record<string, unknown>) {
    const result = await chrome.runtime.sendMessage({ target: 'thread:offscreen', owner: this.owner, ...args });
    if (!result?.ok) throw new Error('The local AI host stopped. Your tabs stay open; try again.');
    return result.value;
  }
  async begin(id = crypto.randomUUID()): Promise<() => Promise<void>> {
    // Reserve before awaiting: an idle notification must not close a host
    // between ensuring it exists and starting an operation.
    this.leases.add(id);
    try { await this.ensure(); await this.send({ type: 'begin', id }); }
    catch (error) { this.leases.delete(id); throw error; }
    return async () => {
      this.leases.delete(id);
      try { await this.send({ type: 'end', id }); } catch { /* Host already gone; recovery journals remain authoritative. */ }
    };
  }
  async closeIdle(owner: string) {
    if (owner !== this.owner || this.leases.size || this.closing || this.creating) return;
    this.closing = chrome.offscreen.closeDocument().catch(() => undefined);
    try { await this.closing; } finally { this.closing = undefined; }
  }
  private async request<T>(task: string, inputs: unknown[], signal: AbortSignal, progress: (p: Progress) => void): Promise<T> {
    if (signal.aborted) throw abortError();
    const id = crypto.randomUUID();
    const end = await this.begin(id);
    try {
      if (signal.aborted) throw abortError();
      return await new Promise<T>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); chrome.runtime.onMessage.removeListener(receive); };
        const stop = (error: Error) => {
          cleanup();
          void this.send({ type: 'cancel', id }).catch(() => undefined);
          reject(error);
        };
        const abort = () => stop(abortError());
        const receive = (m: { target?: string; owner?: string; id?: string; progress?: Progress; result?: T; error?: boolean }, sender: chrome.runtime.MessageSender) => {
          if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(PAGE) || m.owner !== this.owner || m.id !== id) return false;
          if (m.target === 'thread:progress' && m.progress) progress(m.progress);
          if (m.target === 'thread:result') {
            cleanup();
            if (m.error) reject(new Error('The local AI could not finish. Check model download access in Settings and your connection for the first download, then try again. No cloud fallback was used.'));
            else resolve(m.result as T);
          }
          return false;
        };
        const timeout = setTimeout(() => stop(new Error('The local AI took too long. Try again when your device has more available memory.')), 8 * 60_000);
        signal.addEventListener('abort', abort, { once: true });
        chrome.runtime.onMessage.addListener(receive);
        // The command is acknowledged immediately. Results/progress use new
        // messages, not a response channel held open through a long download.
        void this.send({ type: 'infer', id, task, inputs }).catch(error => { cleanup(); reject(error); });
      });
    } finally { await end(); }
  }
  embed(texts: string[], signal: AbortSignal, progress: (p: Progress) => void) {
    return this.request<number[][]>('embed', texts, signal, progress);
  }
  label(inputs: { keywords: string[]; titles: string[] }[], signal: AbortSignal, progress: (p: Progress) => void) {
    return this.request<string[]>('label', inputs, signal, progress);
  }
  release() { void this.send({ type: 'release' }).catch(() => undefined); }
}
