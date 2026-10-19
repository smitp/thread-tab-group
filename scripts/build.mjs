import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const browser = process.argv.find(arg => arg.startsWith('--browser='))?.split('=')[1] ?? 'firefox';
if (!['firefox', 'chrome'].includes(browser)) throw new Error('Use --browser=firefox or --browser=chrome.');
const chrome = browser === 'chrome';
const outdir = chrome ? 'dist-chrome' : 'dist';
await rm(outdir, { recursive: true, force: true });
await mkdir(`${outdir}/vendor`, { recursive: true });
await cp('public', outdir, { recursive: true });
if (chrome) {
  await cp('manifests/chrome.json', `${outdir}/manifest.json`);
  await cp('src/platform/chrome/offscreen.html', `${outdir}/offscreen.html`);
}
await cp('LICENSE', `${outdir}/LICENSE.txt`);
for (const name of ['transformers', 'tokenizers', 'jinja']) {
  await cp(`node_modules/@huggingface/${name}/LICENSE`, `${outdir}/licenses/${name}.txt`);
}
const ortDir = path.dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
for (const file of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  await cp(path.join(ortDir, file), `${outdir}/vendor/${file}`);
}
const options = {
  entryPoints: { background: chrome ? 'src/platform/chrome/background.ts' : 'src/background.ts', popup: 'src/ui/popup.ts', 'ai/worker': 'src/ai/worker.ts',
    ...(chrome ? { offscreen: 'src/platform/chrome/offscreen.ts' } : {}) },
  outdir, bundle: true, format: 'esm', platform: 'browser', target: chrome ? 'chrome121' : 'firefox140',
  conditions: ['browser', 'onnxruntime-web-use-extern-wasm'],
  alias: { 'onnxruntime-web/webgpu': 'onnxruntime-web/wasm', '@platform/client': `./src/platform/${browser}/client.ts` },
  minify: !process.argv.includes('--watch'), legalComments: 'linked', logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`Watching ${browser} TypeScript in ${outdir}. Restart after changing manifests or public assets.`);
} else {
  await build(options);
}
