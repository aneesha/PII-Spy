import { Gliner } from 'gliner';
import { AutoTokenizer, env } from '@xenova/transformers';
import * as ort from 'onnxruntime-web';
import { PII_LABELS } from '../shared/detection.js';

export async function loadModel() {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.localModelPath = chrome.runtime.getURL('models/');
  // One thread works without SharedArrayBuffer/cross-origin isolation and
  // avoids blob workers under the extension's restrictive CSP.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
  const tokenizer = await AutoTokenizer.from_pretrained('pii', { local_files_only: true });
  if (tokenizer.encode('')[0] !== 1) throw new Error('Model tokenizer is not compatible with GLiNER.js.');
  const model = new Gliner({
    tokenizerPath: 'pii',
    onnxSettings: {
      modelPath: chrome.runtime.getURL('models/pii/model.onnx'),
      executionProvider: 'wasm',
      wasmPaths: chrome.runtime.getURL('wasm/'),
      multiThread: false,
    },
    transformersSettings: { allowLocalModels: true, useBrowserCache: false },
    modelType: 'span-level',
    maxWidth: 12,
  });
  await model.initialize();
  const countWord = (word) => tokenizer.encode(word).slice(1, -1).length;
  const promptTokens = [...PII_LABELS.flatMap((label) => ['<<ENT>>', label]), '<<SEP>>'].reduce((sum, word) => sum + countWord(word), 2);
  return {
    inference: (options) => model.inference(options),
    countTokens: (text) => [...text.matchAll(/\w+(?:[-_]\w+)*|\S/g)].reduce((sum, match) => sum + countWord(match[0]), promptTokens),
  };
}
