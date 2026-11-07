import { detectStructured, mergeEntities, splitText, validateText, PII_LABELS } from '../shared/detection.js';

export function createScanner(loadModel) {
  let instance;
  let initializing;
  let state = { state: 'idle' };
  let pending = 0;
  let queue = Promise.resolve();
  const getStatus = () => ({ ...state });

  async function prepare() {
    if (instance) { state = { state: 'ready' }; return instance; }
    if (!initializing) {
      state = { state: 'loading', message: 'Preparing the local detector…' };
      initializing = Promise.resolve().then(loadModel).then((model) => {
        instance = model;
        state = { state: 'ready' };
        return model;
      }).catch(() => {
        state = { state: 'error', message: 'The local detector could not load. Rebuild with the model assets, reload the extension, then try again.' };
        throw new Error(state.message);
      }).finally(() => { initializing = undefined; });
    }
    return initializing;
  }

  async function execute(text) {
    const model = await prepare();
    const detected = detectStructured(text);
    // The library's internal chunker counts words, not model subword tokens.
    // We instead account for the real tokenizer and never truncate a chunk.
    const chunks = [];
    const addChunk = (chunk) => {
      if (model.countTokens(chunk.text) <= 448) { chunks.push(chunk); return; }
      if (chunk.text.length <= 8) throw new Error('Text could not be scanned within the model token limit.');
      const size = Math.ceil(chunk.text.length / 2);
      const overlap = Math.min(80, Math.floor(size / 4));
      for (const child of splitText(chunk.text, size, overlap)) addChunk({ text: child.text, start: chunk.start + child.start });
    };
    for (const chunk of splitText(text)) if (chunk.text.trim()) addChunk(chunk);
    for (const chunk of chunks) {
      const results = await model.inference({ texts: [chunk.text], entities: [...PII_LABELS], flatNer: true, threshold: 0.45 });
      if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(results[0])) throw new Error('The detector returned an invalid result.');
      const localEntities = mergeEntities(chunk.text, results[0]);
      for (const entity of localEntities) detected.push({ ...entity, start: entity.start + chunk.start, end: entity.end + chunk.start, source: 'model' });
    }
    state = { state: 'ready' };
    return mergeEntities(text, detected);
  }

  function scan(text) {
    validateText(text);
    if (pending >= 8) return Promise.reject(new Error('The local detector is busy. Please try pasting again shortly.'));
    pending += 1;
    const task = queue.then(() => execute(text));
    // A failed scan must not poison subsequent requests or silently return [].
    queue = task.catch(() => { state = { state: 'error', message: 'The last scan failed. Try preparing the detector again.' }; });
    return task.finally(() => { pending -= 1; });
  }
  return { prepare, scan, getStatus };
}
