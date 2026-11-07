import { build } from 'esbuild';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MODEL_FILES, MODEL_REPOSITORY, MODEL_REVISION } from './model-config.js';
import { verifyModelFile } from './model-files.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
const assets = resolve(root, 'assets/models/pii');
const allowMissingModel = process.argv.includes('--allow-missing-model');
let modelAvailable = true;
for (const file of MODEL_FILES) {
  try { await verifyModelFile(resolve(assets, file.local), file); }
  catch (error) {
    modelAvailable = false;
    if (!allowMissingModel) throw new Error(`${error.message}. Run npm run setup:model before building.`);
    break;
  }
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'public'), output, { recursive: true });
await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'));
const wasmModule = resolve(root, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs');
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  minify: false,
  legalComments: 'external',
  loader: { '.css': 'text' },
  logLevel: 'warning',
};
await build({ ...common, entryPoints: ['src/content/index.js'], outfile: resolve(output, 'content.js'), format: 'iife' });
await build({ ...common, entryPoints: ['src/background.js'], outfile: resolve(output, 'background.js'), format: 'esm' });
await build({ ...common, entryPoints: ['src/popup.js'], outfile: resolve(output, 'popup.js'), format: 'esm' });
await build({
  ...common,
  entryPoints: ['src/offscreen/index.js'],
  outfile: resolve(output, 'offscreen.js'),
  format: 'esm',
  // GLiNER imports all providers at module scope. We deliberately support
  // only WASM, avoiding unnecessary WebGPU/WebGL code and duplicate runtimes.
  alias: {
    'onnxruntime-web': wasmModule,
    'onnxruntime-web/webgpu': wasmModule,
    'onnxruntime-web/webgl': wasmModule,
  },
});
await mkdir(resolve(output, 'wasm'), { recursive: true });
for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await cp(resolve(root, 'node_modules/onnxruntime-web/dist', file), resolve(output, 'wasm', file));
}
await mkdir(resolve(output, 'vendor'), { recursive: true });
await cp(resolve(root, 'node_modules/@picocss/pico/css/pico.min.css'), resolve(output, 'vendor/pico.min.css'));
await mkdir(resolve(output, 'licenses'), { recursive: true });
for (const [source, destination] of [
  ['node_modules/gliner/LICENSE', 'gliner-LICENSE.txt'],
  ['node_modules/@xenova/transformers/LICENSE', 'transformers-LICENSE.txt'],
  ['node_modules/@picocss/pico/LICENSE.md', 'pico-LICENSE.txt'],
]) await cp(resolve(root, source), resolve(output, 'licenses', destination));
if (modelAvailable) {
  await cp(assets, resolve(output, 'models/pii'), { recursive: true, filter: (source) => !source.endsWith('.download') });
  await writeFile(resolve(output, 'models/pii/provenance.json'), JSON.stringify({ repository: MODEL_REPOSITORY, revision: MODEL_REVISION, license: 'Apache-2.0', files: MODEL_FILES }, null, 2));
}
const files = await readdir(output);
console.log(`Built ${files.length} top-level entries in dist/. ${modelAvailable ? 'Verified model included; ready to load unpacked.' : 'MODEL OMITTED: testing scan failures only; do not distribute.'}`);
