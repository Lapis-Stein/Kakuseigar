// Requires Sharp, available through a local installation or NODE_PATH.
// Usage: node scripts/prepare-images.mjs --works-dir <directory of original PNGs>
// Only titles listed in the public runtime are read from that directory.
import { createRequire } from 'node:module';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--works-dir' || !args[1]) {
  throw new Error('Usage: node scripts/prepare-images.mjs --works-dir <directory of original PNGs>');
}
const worksDir = path.resolve(args[1]);
const runtime = JSON.parse(await readFile(path.join(root, 'data/runtime.json'), 'utf8'));
const presentationPath = path.join(root, 'data/presentation.json');
const presentation = JSON.parse(await readFile(presentationPath, 'utf8'));
const worksOutput = path.join(root, 'assets/works');
const report = [];

function safeName(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/:*?"<>|]/u.test(value)) {
    throw new Error('Image filenames must be plain basenames');
  }
  return value;
}

async function convert(input, relativeOutput, width, height, quality, preserveAlpha = false) {
  const output = path.join(root, relativeOutput);
  const before = await sharp(input).metadata();
  await sharp(input)
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, alphaQuality: 100, effort: 6 })
    .toFile(output);
  const after = await sharp(output).metadata();
  if (preserveAlpha && (!before.hasAlpha || !after.hasAlpha)) {
    throw new Error(`Portrait alpha channel was not retained: ${relativeOutput}`);
  }
  report.push({
    file: relativeOutput,
    width: after.width,
    height: after.height,
    alpha: after.hasAlpha,
    originalBytes: (await stat(input)).size,
    bytes: (await stat(output)).size,
  });
  return after;
}

// Validate every source before writing, without importing unrelated images.
const workSources = runtime.works.map(work => ({
  work,
  input: path.join(worksDir, `${safeName(work.title)}.png`),
  id: safeName(work.id),
}));
const portraitSources = Object.entries(presentation.narrator.images).map(([mood, relative]) => {
  if (!/^assets\/seiga\/[a-z-]+\.(?:png|webp)$/u.test(relative)) {
    throw new Error(`Unexpected portrait path: ${relative}`);
  }
  return { mood, input: path.join(root, relative.replace(/\.webp$/u, '.png')) };
});
for (const { input } of [...workSources, ...portraitSources]) await stat(input);

await mkdir(worksOutput, { recursive: true });
const workArt = {};
for (const { work, input, id } of workSources) {
  const preview = `assets/works/${id}-preview.webp`;
  const full = `assets/works/${id}.webp`;
  await convert(input, preview, 480, 720, 82);
  const metadata = await convert(input, full, 1024, 1536, 88);
  workArt[work.id] = {
    preview,
    full,
    width: metadata.width,
    height: metadata.height,
    alt: `『${work.title}』のイメージ画`,
  };
}
for (const { mood, input } of portraitSources) {
  const output = `assets/seiga/${safeName(mood)}.webp`;
  await convert(input, output, 768, 1152, 85, true);
  presentation.narrator.images[mood] = output;
}
presentation.work_art_by_work = workArt;
await writeFile(presentationPath, `${JSON.stringify(presentation, null, 2)}\n`);
console.table(report);
