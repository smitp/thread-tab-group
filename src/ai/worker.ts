import { env, pipeline, LogLevel, type FeatureExtractionPipeline, type Text2TextGenerationPipeline } from '@huggingface/transformers';
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
        embedder = await pipeline('feature-extraction', EMBEDDING_MODEL, {
          revision: EMBEDDING_REVISION, dtype: 'q8', device: 'wasm', progress_callback: download,
        });
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
        labeler = await pipeline('text2text-generation', LABEL_MODEL, {
          revision: LABEL_REVISION, dtype: 'q8', device: 'wasm', progress_callback: download,
        });
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
    self.postMessage({ id, error: 'The local AI could not finish. Check your connection for the first download, then try again. No cloud fallback was used.' });
  }
};
