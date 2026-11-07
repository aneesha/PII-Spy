import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { MODEL_REPOSITORY, MODEL_REVISION, MODEL_FILES } from './model-config.js';
import { verifyModelFile } from './model-files.js';

const directory = fileURLToPath(new URL('../assets/models/pii/', import.meta.url));
await mkdir(directory, { recursive: true });
for (const file of MODEL_FILES) {
  const path = `${directory}/${file.local}`;
  try {
    await verifyModelFile(path, file);
    console.log(`Verified ${file.local}`);
    continue;
  } catch { /* Missing/incomplete files are safely replaced after verification. */ }
  const temporaryPath = `${path}.download`;
  try {
    console.log(`Downloading ${file.remote} (${(file.size / 1e6).toFixed(1)} MB)…`);
    const response = await fetch(`https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/${file.remote}`, { signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
    await verifyModelFile(temporaryPath, file);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(`Cannot prepare ${file.local}: ${error.message}`);
  }
}
await writeFile(`${directory}/provenance.json`, JSON.stringify({ repository: MODEL_REPOSITORY, revision: MODEL_REVISION, license: 'Apache-2.0', files: MODEL_FILES }, null, 2));
console.log('Model assets are ready. Run npm run build. Runtime inference uses only packaged files.');
