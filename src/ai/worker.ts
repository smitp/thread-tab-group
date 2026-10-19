import { env, LogLevel, BertTokenizer, T5Tokenizer, AutoModel, AutoModelForSeq2SeqLM, FeatureExtractionPipeline, Text2TextGenerationPipeline } from '@huggingface/transformers';
import { EMBEDDING_MODEL, EMBEDDING_REVISION, LABEL_MODEL, LABEL_REVISION } from './models';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.cacheKey = 'thread-models-v1';
env.useWasmCache = false;
env.logLevel = LogLevel.ERROR;
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.proxy = false;
env.backends.onnx.wasm!.wasmPaths = {
  mjs: new URL('../vendor/ort-wasm-simd-threaded.mjs', import.meta.url).href,
  wasm: new URL('../vendor/ort-wasm-simd-threaded.wasm', import.meta.url).href,
};
// All executable runtime code is packaged; only pinned model/data files are remote.
const realFetch = globalThis.fetch.bind(globalThis);
env.fetch = (input, init) => realFetch(input, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });

// AutoTokenizer's file-discovery helper probes `main` without forwarding the
// requested revision. These two pinned models have known tokenizer classes;
// load their exact JSON files instead, including when the network is offline.
async function tokenizerFiles(model: string, revision: string): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  let cache: Cache | undefined;
  try { cache = await caches.open('thread-models-v1'); } catch { /* Online inference can still work if caching is unavailable. */ }
  const files = await Promise.all(['tokenizer.json', 'tokenizer_config.json'].map(async file => {
    const url = `https://huggingface.co/${model}/resolve/${revision}/${file}`;
    const saved = await cache?.match(url);
    if (saved) return saved.json();
    const response = await env.fetch!(url);
    if (!response.ok) throw new Error('The pinned tokenizer could not be downloaded.');
    if (cache) try { await cache.put(url, response.clone()); } catch { /* Do not fail an otherwise usable model because the disk cache is full. */ }
    return response.json();
  }));
  return files as [Record<string, unknown>, Record<string, unknown>];
}

let embedder: FeatureExtractionPipeline | undefined;
let labeler: Text2TextGenerationPipeline | undefined;
const cache = new Map<string, number[]>();
type Request = { id: string; task: 'embed'; inputs: string[] } |
  { id: string; task: 'label'; inputs: { keywords: string[]; titles: string[] }[] };

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id } = event.data;
  const progress = (stage: string, detail: string, percent?: number) => self.postMessage({ id, progress: { stage, detail, percent } });
  const download = (p: { status: string; progress?: number; file?: string }) => {
    if (p.status === 'progress') progress('Preparing on-device AI', 'Downloading ' + (p.file?.split('/').pop() ?? 'model') + '. Your tabs stay on this device.', p.progress);
    if (p.status === 'initiate') progress('Preparing on-device AI', 'Loading a small, private model. This is saved for next time.');
  };
  try {
    if (event.data.task === 'embed') {
      if (!embedder) {
        progress('Preparing on-device AI', 'The first run downloads the semantic model. No tab data is sent.');
        // Construct the public pipeline directly: the generic pipeline()
        // helper also probes unpinned `main` metadata, even with revision set.
        const options = { revision: EMBEDDING_REVISION, dtype: 'q8' as const, device: 'wasm' as const, progress_callback: download };
        const [model, [json, config]] = await Promise.all([
          AutoModel.from_pretrained(EMBEDDING_MODEL, options), tokenizerFiles(EMBEDDING_MODEL, EMBEDDING_REVISION),
        ]);
        embedder = new FeatureExtractionPipeline({ task: 'feature-extraction', model, tokenizer: new BertTokenizer(json, config) });
      }
      const texts = event.data.inputs;
      const result: number[][] = [];
      for (let i = 0; i < texts.length; i += 12) {
        const batch = texts.slice(i, i + 12);
        const missing = [...new Set(batch.filter(t => !cache.has(t)))];
        if (missing.length) {
          const tensor = await embedder(missing, { pooling: 'mean', normalize: true });
          const rows = tensor.tolist() as number[][];
          missing.forEach((t, j) => cache.set(t, rows[j]));
        }
        result.push(...batch.map(t => cache.get(t)!));
        progress('Analyzing tabs', 'Reading titles and page addresses locally.', Math.round(Math.min(i + 12, texts.length) / texts.length * 100));
      }
      // Cache is memory-only and dies with this worker.
      while (cache.size > 1200) cache.delete(cache.keys().next().value!);
      self.postMessage({ id, result });
    } else {
      if (!labeler) {
        progress('Preparing group names', 'Loading the small naming model. It is saved for next time.');
        const options = { revision: LABEL_REVISION, dtype: 'q8' as const, device: 'wasm' as const, progress_callback: download };
        const [model, [json, config]] = await Promise.all([
          AutoModelForSeq2SeqLM.from_pretrained(LABEL_MODEL, options), tokenizerFiles(LABEL_MODEL, LABEL_REVISION),
        ]);
        labeler = new Text2TextGenerationPipeline({ task: 'text2text-generation', model, tokenizer: new T5Tokenizer(json, config) });
      }
      const result: string[] = [];
      for (const input of event.data.inputs) {
        progress('Naming tab groups', 'Choosing short, recognizable labels.', Math.round(result.length / event.data.inputs.length * 100));
        const prompt = 'Topic from keywords: ' + input.keywords.join(',') + '. titles: \n' + input.titles.join('\n');
        const output = await labeler(prompt, { max_new_tokens: 12, do_sample: false, num_beams: 1 });
        result.push((output[0] as { generated_text: string }).generated_text);
      }
      self.postMessage({ id, result });
    }
  } catch {
    // Do not serialize model errors containing page inputs into storage or logs.
    self.postMessage({ id, error: 'The local AI could not finish. Check model download access in Settings and your connection for the first download, then try again. No cloud fallback was used.' });
  }
};
