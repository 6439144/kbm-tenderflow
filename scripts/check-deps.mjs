// Runs before `npm run build` and `npm start`: every dependency in package.json must be installed.
// After pulling a new version, new packages need `npm install` — this says so plainly instead of a compiler error.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const missing = [];
for (const ws of ['.', 'services/api', 'apps/web']) {
  const pj = path.join(root, ws, 'package.json');
  if (!existsSync(pj)) continue;
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (name.startsWith('@tenderflow/')) continue;
    const found = [path.join(root, ws, 'node_modules', name), path.join(root, 'node_modules', name)].some((p) => existsSync(path.join(p, 'package.json')));
    if (!found) missing.push(`${name} (${ws === '.' ? 'root' : ws})`);
  }
}
if (missing.length) {
  console.error('\nTenderFlow: these packages are not installed yet:\n  - ' + missing.join('\n  - '));
  console.error('\nThis version added dependencies. Run:\n\n  npm install\n\nthen run the command again.\n');
  process.exit(1);
}
