import { readFile } from 'node:fs/promises';

// Registry release timestamps are not contained in npm's lockfile. This
// explicit maintenance command verifies every installed version, including
// transitive and optional dependencies, against the three-day cooling rule.
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
const packages = new Map();
for (const [location, metadata] of Object.entries(lock.packages)) {
  if (!location || !metadata.version) continue;
  const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (!packages.has(name)) packages.set(name, new Set());
  packages.get(name).add(metadata.version);
}
const pending = [...packages];
const failures = [];
let verified = 0;
async function worker() {
  while (pending.length) {
    const [name, versions] = pending.pop();
    try {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { time } = await response.json();
      for (const version of versions) {
        const published = Date.parse(time?.[version]);
        if (!Number.isFinite(published) || published > cutoff) failures.push(`${name}@${version}: missing timestamp or younger than 3 days`);
        else verified += 1;
      }
    } catch (error) { failures.push(`${name}: ${error.message}`); }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Verified three-day cooling for ${verified} locked package versions.`);
