import { cp, mkdir, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, 'dist');
// Only the generated dist directory belonging to this checkout may be replaced.
if (path.dirname(output) !== path.resolve(root) || path.basename(output) !== 'dist') throw new Error('Unsafe output path');
try { if ((await lstat(output)).isSymbolicLink()) throw new Error('dist must not be a link'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of ['index.html', 'styles.css', 'src', 'data', 'assets']) {
  await cp(path.join(root, entry), path.join(output, entry), { recursive: true, dereference: false });
}
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Static site built in dist/');
