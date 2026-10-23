import { access, readFile, readdir } from 'node:fs/promises';
import { validateRuntime } from '../src/engine.js';

const root = new URL('../', import.meta.url);
const data = JSON.parse(await readFile(new URL('data/runtime.json', root), 'utf8'));
validateRuntime(data);
const config = JSON.parse(await readFile(new URL('data/presentation.json', root), 'utf8'));
if (!config.dataset_version || config.narrator.id !== 'seiga') throw new Error('Invalid presentation configuration');
const questionMoods = config.narrator.question_moods;
if (!Array.isArray(questionMoods) || questionMoods.length < 2
    || new Set(questionMoods).size !== questionMoods.length
    || questionMoods.some(mood => !config.narrator.images[mood] || ['recommend', 'celebrate', 'ending'].includes(mood))) {
  throw new Error('Invalid question portrait pool');
}
for (const imagePath of Object.values(config.narrator.images)) {
  if (!/^assets\/[a-zA-Z0-9_./-]+\.(png|webp)$/.test(imagePath) || imagePath.includes('..')) throw new Error('Invalid portrait path');
  await access(new URL(imagePath, root));
}
if (config.narrator.robot) {
  const robot = config.narrator.robot;
  if (typeof robot.name !== 'string' || !robot.name.trim()) throw new Error('Invalid substitute narrator name');
  for (const imagePath of [robot.images?.idle, robot.images?.broken]) {
    if (typeof imagePath !== 'string' || !/^assets\/[a-zA-Z0-9_./-]+\.(png|webp|svg)$/.test(imagePath) || imagePath.includes('..')) throw new Error('Invalid substitute portrait path');
    await access(new URL(imagePath, root));
  }
}
const forbidden = new Set(['editorial_evidence', 'evidence', 'source_version', 'source_basis', 'calibration_evidence', 'values_evidence', 'entry_penalty_note', 'serious_load', 'approval']);
function inspect(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`Private field present: ${key}`);
    inspect(item);
  }
}
inspect(data);
for (const [workId, ids] of Object.entries(config.public_cast_by_work)) {
  const work = data.works.find(w => w.id === workId);
  if (!work || !Array.isArray(ids) || ids.some(id => !work.characters.some(c => c.id === id))) throw new Error('Unknown public cast');
}
for (const [workId, art] of Object.entries(config.work_art_by_work || {})) {
  if (!data.works.some(work => work.id === workId) || !art || typeof art.alt !== 'string' || !art.alt.trim()
      || !Number.isSafeInteger(art.width) || art.width <= 0 || !Number.isSafeInteger(art.height) || art.height <= 0) {
    throw new Error('Invalid work illustration');
  }
  for (const imagePath of [art.preview, art.full]) {
    if (typeof imagePath !== 'string' || !/^assets\/works\/[a-zA-Z0-9_-]+\.(png|webp|jpe?g)$/.test(imagePath)) throw new Error('Invalid work illustration path');
    await access(new URL(imagePath, root));
  }
}
for (const file of await readdir(new URL('src/', root))) {
  if (!file.endsWith('.js')) throw new Error(`Unexpected app file: ${file}`);
}
console.log(`Data checked: ${data.questions.length} questions, ${data.works.length} works.`);
