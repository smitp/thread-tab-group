import type { Intelligence, Progress } from '../core/types';

export class LocalIntelligence implements Intelligence {
  private worker?: Worker;
  private activeReject?: (reason: Error) => void;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private readonly workerURL: string) {}
  private request<T>(task: string, inputs: unknown[], signal: AbortSignal, progress: (p: Progress) => void): Promise<T> {
    if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    clearTimeout(this.idle);
    this.worker ??= new Worker(this.workerURL, { type: 'module' });
    const worker = this.worker;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        worker.removeEventListener('message', receive);
        worker.removeEventListener('error', error);
        this.activeReject = undefined;
        clearTimeout(timeout);
        this.idle = setTimeout(() => this.release(), 90_000);
      };
      const fail = (reason: Error) => { cleanup(); this.release(); reject(reason); };
      const abort = () => fail(new DOMException('Cancelled', 'AbortError'));
      const error = () => fail(new Error('The on-device AI stopped. Try again; your tabs have not been sent anywhere.'));
      const receive = (event: MessageEvent) => {
        if (event.data.id !== id) return;
        if (event.data.progress) progress(event.data.progress);
        else if (event.data.error) fail(new Error(event.data.error));
        else { cleanup(); resolve(event.data.result as T); }
      };
      const timeout = setTimeout(() => fail(new Error('The local AI took too long. Try again when your device has more available memory.')), 8 * 60_000);
      this.activeReject = fail;
      worker.addEventListener('message', receive);
      worker.addEventListener('error', error);
      signal.addEventListener('abort', abort, { once: true });
      worker.postMessage({ id, task, inputs });
    });
  }
  embed(texts: string[], signal: AbortSignal, progress: (p: Progress) => void) {
    return this.request<number[][]>('embed', texts, signal, progress);
  }
  label(inputs: { keywords: string[]; titles: string[] }[], signal: AbortSignal, progress: (p: Progress) => void) {
    return this.request<string[]>('label', inputs, signal, progress);
  }
  release() {
    clearTimeout(this.idle);
    this.worker?.terminate(); this.worker = undefined;
    const reject = this.activeReject; this.activeReject = undefined;
    if (reject) reject(new Error('Local AI was stopped.'));
  }
}
