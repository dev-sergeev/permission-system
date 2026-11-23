import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import buildGate from './build-gate.mjs';
import buildReviewer from './build-reviewer.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
await mkdir(dist, { recursive: true });
await Promise.all([buildGate(dist), buildReviewer(dist)]);
for (const [name, entry] of [
  ['gate', '@gotgenes/pi-permission-system'],
  ['reviewer', '@mzwing/pi-permission-auto-review'],
]) {
  const entryDir = dirname(fileURLToPath(import.meta.resolve(entry)));
  await copyFile(join(entryDir, '../LICENSE'), join(dist, `LICENSE-${name}`));
}
