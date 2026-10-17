import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
await cp('public', 'dist', { recursive: true });
await cp('LICENSE', 'dist/LICENSE.txt');
for (const name of ['transformers', 'tokenizers', 'jinja']) {
  await cp(`node_modules/@huggingface/${name}/LICENSE`, `dist/licenses/${name}.txt`);
}
const ortDir = path.dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
for (const file of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  await cp(path.join(ortDir, file), `dist/vendor/${file}`);
}
const options = {
  entryPoints: { background: 'src/background.ts', popup: 'src/ui/popup.ts', 'ai/worker': 'src/ai/worker.ts' },
  outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'firefox140',
  conditions: ['browser', 'onnxruntime-web-use-extern-wasm'],
  alias: { 'onnxruntime-web/webgpu': 'onnxruntime-web/wasm' }, minify: !process.argv.includes('--watch'), legalComments: 'linked', logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching TypeScript. Restart this command after changing public assets.');
} else {
  await build(options);
}
