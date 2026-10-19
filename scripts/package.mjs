import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const target = process.argv.find(arg => arg.startsWith('--browser='))?.split('=')[1] ?? 'firefox';
if (!['firefox', 'chrome', 'all'].includes(target)) throw new Error('Use --browser=firefox, --browser=chrome, or --browser=all.');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('artifacts', { recursive: true });
for (const browser of target === 'all' ? ['firefox', 'chrome'] : [target]) {
  const directory = browser === 'chrome' ? 'dist-chrome' : 'dist';
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  if (manifest.version !== version || !!manifest.background.service_worker !== (browser === 'chrome')) throw new Error(`Rebuild ${browser} before packaging.`);
  const filename = `thread-${browser}-${version}.zip`;
  execFileSync('zip', ['-q', '-r', '-FS', `../artifacts/${filename}`, '.'], { cwd: directory });
  console.log(`artifacts/${filename} — ${browser === 'chrome' ? 'Chrome Web Store upload' : 'unsigned Firefox package'}`);
}
const source = `artifacts/thread-source-${version}.zip`;
execFileSync('zip', ['-q', '-r', '-FS', source, 'src', 'public', 'manifests', 'assets', 'scripts', 'docs',
  'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', '.gitignore']);
console.log(`${source} — matching readable source for both builds`);
