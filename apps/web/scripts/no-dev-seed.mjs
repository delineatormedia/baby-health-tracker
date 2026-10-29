// Fails the build if the dev seed (#58) reached the production output. The seed module is
// imported only behind import.meta.env.DEV, so a production build must not contain it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKERS = ['Pip Testbaby', 'test scenario?'];
const root = new URL('../build', import.meta.url).pathname;

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(js|html)$/.test(e.name)) yield p;
  }
}

const leaks = [...files(root)].filter((f) => {
  const text = readFileSync(f, 'utf8');
  return MARKERS.some((m) => text.includes(m));
});
if (leaks.length > 0) {
  console.error(`Dev seed data is in the production build:\n${leaks.join('\n')}`);
  process.exit(1);
}
console.log('No dev seed in the production build.');
