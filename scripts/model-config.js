// GLiNER.js 0.0.19 hardcodes the DeBERTa CLS id (1); use its compatible
// span-level v2.1 model, rather than the newer ModernBERT PII model.
export const MODEL_REPOSITORY = 'onnx-community/gliner_small-v2.1';
export const MODEL_REVISION = '8142fb00740ccea973e64b1272949ff48653df5e';
export const MODEL_FILES = [
  { remote: 'onnx/model_quantized.onnx', local: 'model.onnx', size: 183403734, sha256: 'c76c90920547fd937aaf505e7f2de5ec73168bf1c25abbb55a298104cb061400' },
  { remote: 'tokenizer.json', local: 'tokenizer.json', size: 8657198, gitSha1: 'b73fed61cb455681461d0044ce4ea8ac1c83a7ad' },
  { remote: 'tokenizer_config.json', local: 'tokenizer_config.json', size: 1806, gitSha1: '504e1e8b30d1e5cf0472adcdd4c73448a1c12f8b' },
  { remote: 'special_tokens_map.json', local: 'special_tokens_map.json', size: 286, gitSha1: '2c9cb07c8fdeeb5ac3ceafb170592e990b204dcd' },
  { remote: 'gliner_config.json', local: 'gliner_config.json', size: 731, gitSha1: '3a04b9dab50de83ae69e767aa23d272e0a1de8dd' },
];
