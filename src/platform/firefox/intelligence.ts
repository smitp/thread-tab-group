import type { PreferredEmbeddings } from '../../ai/hybrid';
import { EMBEDDING_MODEL, FIREFOX_EMBEDDING_REVISION } from '../../ai/models';
import type { Progress } from '../../core/types';

interface TrialML {
  createEngine(options: Record<string, unknown>): Promise<void>;
  runEngine(options: Record<string, unknown>): Promise<unknown>;
  onProgress: { addListener(fn: () => void): void; removeListener(fn: () => void): void };
}
type NativeBrowser = typeof browser & { trial?: { ml?: TrialML } };
const cancelled = () => new DOMException('Cancelled', 'AbortError');
function check(signal: AbortSignal) { if (signal.aborted) throw cancelled(); }

function decode(result: unknown, count: number): number[][] {
  const rows = Array.isArray(result) ? result : (result as { output?: unknown } | null)?.output;
  if (!Array.isArray(rows) || rows.length !== count) throw new Error('Incompatible native embeddings.');
  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== 384 || !row.every(n => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error('Incompatible native embeddings.');
    }
    const norm = Math.sqrt(row.reduce((sum: number, n: number) => sum + n * n, 0));
    if (Math.abs(norm - 1) > 0.02) throw new Error('Unnormalized native embeddings.');
    return row.map(n => n / norm);
  });
}

// Cancellation stops waiting/using results. The trial API cannot stop an
// in-flight inference/download; Firefox owns its lifetime and idle cleanup.
function wait<T>(work: Promise<T>, signal: AbortSignal, abandon: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { abandon(); cleanup(); reject(cancelled()); };
    const timeout = setTimeout(() => { abandon(); cleanup(); reject(new Error('Firefox AI took too long.')); }, 8 * 60_000);
    const cleanup = () => { signal.removeEventListener('abort', abort); clearTimeout(timeout); };
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class FirefoxEmbeddings implements PreferredEmbeddings {
  private ready = false;
  private pending?: Promise<number[][]>;
  private cache = new Map<string, number[]>();
  private idle?: ReturnType<typeof setTimeout>;

  async embed(texts: string[], signal: AbortSignal, progress: (p: Progress) => void): Promise<number[][] | undefined> {
    check(signal);
    if (!await browser.permissions.contains({ permissions: ['trialML'] })) return undefined;
    check(signal);
    const api = (browser as NativeBrowser).trial?.ml;
    // A cancelled native operation may still be running. Do not queue more
    // native work behind it; the existing local implementation remains usable.
    if (!api || this.pending) return undefined;
    clearTimeout(this.idle);
    const downloading = () => {
      if (!signal.aborted) progress({ stage: 'Firefox’s on-device AI', detail: 'Preparing Firefox’s local runtime and model. Your tabs stay on this device.' });
    };
    downloading();
    api.onProgress.addListener(downloading);
    const controller = new AbortController();
    const work = this.compute(api, texts, controller.signal, progress);
    this.pending = work;
    // Always observe the underlying promise, including after cancellation.
    void work.then(() => { if (this.pending === work) this.pending = undefined; }, () => {
      if (this.pending === work) this.pending = undefined;
      this.cache.clear();
    });
    try { return await wait(work, signal, () => controller.abort()); }
    finally {
      api.onProgress.removeListener(downloading);
      this.idle = setTimeout(() => this.release(), 90_000);
    }
  }

  private async compute(api: TrialML, texts: string[], signal: AbortSignal, progress: (p: Progress) => void): Promise<number[][]> {
    if (!this.ready) {
      try {
        await api.createEngine({
          taskName: 'feature-extraction', modelHub: 'mozilla', modelId: EMBEDDING_MODEL,
          modelRevision: FIREFOX_EMBEDDING_REVISION, tokenizerId: EMBEDDING_MODEL,
          tokenizerRevision: FIREFOX_EMBEDDING_REVISION, processorId: EMBEDDING_MODEL,
          processorRevision: FIREFOX_EMBEDDING_REVISION,
          dtype: 'q8', device: 'wasm', numThreads: 1, timeoutMS: 90_000,
        });
      } catch (error) {
        // Firefox can retain our one embedding engine across event-page wakes.
        // This extension never creates a different native task/model.
        if (!(error instanceof Error) || error.message !== 'Engine already created') throw error;
      }
      this.ready = true;
    }
    check(signal);
    const missing = [...new Set(texts.filter(t => !this.cache.has(t)))];
    const result = new Map(this.cache);
    for (let i = 0; i < missing.length; i += 12) {
      check(signal);
      const batch = missing.slice(i, i + 12);
      const output = await api.runEngine({ args: [batch], options: { pooling: 'mean', normalize: true } });
      check(signal);
      const vectors = decode(output, batch.length);
      batch.forEach((t, j) => result.set(t, vectors[j]));
      progress({ stage: 'Analyzing tabs', detail: 'Using Firefox’s on-device AI. Titles and addresses stay here.',
        percent: Math.round(Math.min(i + 12, missing.length) / missing.length * 100) });
    }
    check(signal);
    this.cache = new Map(result);
    while (this.cache.size > 1200) this.cache.delete(this.cache.keys().next().value!);
    return texts.map(t => result.get(t)!);
  }
  release() {
    clearTimeout(this.idle);
    this.cache.clear();
    // No deleteCachedModels: Firefox's disk cache is not an inference-text cache.
  }
}
