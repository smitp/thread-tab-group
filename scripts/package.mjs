import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const filename = `thread-firefox-${version}.zip`;
await mkdir('artifacts', { recursive: true });
execFileSync('zip', ['-q', '-r', '-FS', `../artifacts/${filename}`, '.'], { cwd: 'dist' });
console.log(`artifacts/${filename} — unsigned Firefox package`);
const source = `artifacts/thread-source-${version}.zip`;
execFileSync('zip', ['-q', '-r', '-FS', source, 'src', 'public', 'assets', 'scripts', 'docs',
  'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', '.gitignore']);
console.log(`${source} — matching readable source for Mozilla review`);
