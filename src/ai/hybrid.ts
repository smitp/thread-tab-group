import type { Intelligence, Progress } from '../core/types';

export interface PreferredEmbeddings {
  embed(texts: string[], signal: AbortSignal, progress: (p: Progress) => void): Promise<number[][] | undefined>;
  release(): void;
}

export class HybridIntelligence implements Intelligence {
  constructor(private local: Intelligence, private preferred: PreferredEmbeddings) {}
  async embed(texts: string[], signal: AbortSignal, progress: (p: Progress) => void): Promise<number[][]> {
    try {
      const vectors = await this.preferred.embed(texts, signal, progress);
      if (vectors) return vectors;
    } catch {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      // Do not expose native exceptions that might contain inference inputs.
      progress({ stage: 'Using the local fallback', detail: 'Firefox’s AI is unavailable. Continuing locally with the same model—no cloud fallback.' });
    }
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    return this.local.embed(texts, signal, progress);
  }
  label(inputs: { keywords: string[]; titles: string[] }[], signal: AbortSignal, progress: (p: Progress) => void) {
    // The trial API has one engine per extension and no supported task switch.
    return this.local.label(inputs, signal, progress);
  }
  release() { this.local.release(); this.preferred.release(); }
}
