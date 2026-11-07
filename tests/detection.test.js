import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStructured, mergeEntities, splitText, validateText } from '../src/shared/detection.js';
import { createScanner } from '../src/offscreen/scanner.js';

const sample = '😀 Email jane@example.com; SSN 123-45-6789; IP 192.168.0.1; card 4111 1111 1111 1111.';

test('structured PII offsets remain correct after an astral character', () => {
  const entities = detectStructured(sample);
  assert.deepEqual(entities.map((entity) => entity.label), ['email', 'ssn', 'ip address', 'credit card']);
  for (const entity of entities) assert.equal(sample.slice(entity.start, entity.end), entity.spanText);
});

test('structured patterns reject invalid SSNs, IP octets and card checksums', () => {
  assert.deepEqual(detectStructured('000-12-3456 900-22-1111 999.10.20.30 4111 1111 1111 1112'), []);
});

test('API key patterns and international telephone number', () => {
  const entities = detectStructured('token ghp_abcdefghijklmnopqrstuvwxyz1234567890; phone +61 412 345 678');
  assert.deepEqual(entities.map((entity) => entity.label), ['api key', 'phone number']);
});

test('overlapping detections cover the full union, preserving adjacent values', () => {
  const text = 'abcdefghijkl';
  const result = mergeEntities(text, [
    { start: 1, end: 5, label: 'person', score: 0.9 },
    { start: 3, end: 7, label: 'email', score: 1, source: 'pattern' },
    { start: 7, end: 9, label: 'person', score: 0.9 },
  ]);
  assert.deepEqual(result.map(({ start, end, label }) => ({ start, end, label })), [
    { start: 1, end: 7, label: 'sensitive data' },
    { start: 7, end: 9, label: 'person' },
  ]);
});

test('reject invalid detector output instead of silently allowing a paste', () => {
  assert.throws(() => mergeEntities('text', [{ start: 0, end: 100, label: 'person', score: 0.9 }]));
  assert.throws(() => mergeEntities('text', [{ start: 0, end: 2, label: 'person', score: 0.9, spanText: 'incorrect' }]));
  assert.throws(() => validateText('x'.repeat(50_001)));
});

test('chunking covers every code unit and never cuts a surrogate pair', () => {
  const text = 'A😀B C🦊D'.repeat(300);
  const chunks = splitText(text, 101, 19);
  const coverage = new Set();
  for (const chunk of chunks) {
    assert.equal(chunk.text, text.slice(chunk.start, chunk.start + chunk.text.length));
    assert.doesNotMatch(chunk.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    for (let i = 0; i < chunk.text.length; i += 1) coverage.add(chunk.start + i);
  }
  assert.equal(coverage.size, text.length);
});

test('model initialization is shared across concurrent scans; inference serializes', async () => {
  let loads = 0;
  let running = 0;
  let peak = 0;
  const scanner = createScanner(async () => {
    loads += 1;
    return { countTokens: () => 10, inference: async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 3));
      running -= 1;
      return [[]];
    } };
  });
  await Promise.all([scanner.scan('hello'), scanner.scan('world'), scanner.prepare()]);
  assert.equal(loads, 1);
  assert.equal(peak, 1);
  assert.equal(scanner.getStatus().state, 'ready');
});

test('initialization failure fails closed and allows a later retry', async () => {
  let attempt = 0;
  const scanner = createScanner(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('failed');
    return { countTokens: () => 10, inference: async () => [[]] };
  });
  await assert.rejects(scanner.scan('jane@example.com'));
  assert.equal(scanner.getStatus().state, 'error');
  assert.equal((await scanner.scan('jane@example.com'))[0].label, 'email');
  assert.equal(attempt, 2);
});

test('model failure is never misreported as a clean scan and does not poison the queue', async () => {
  let attempt = 0;
  const scanner = createScanner(async () => ({ countTokens: () => 10, inference: async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('failed');
    return [[]];
  } }));
  await assert.rejects(scanner.scan('safe')); // Even when pattern pre-pass is empty.
  assert.deepEqual(await scanner.scan('safe'), []);
});

test('model entities in overlapping chunks use global offsets and deduplicate', async () => {
  const name = 'Jane Example';
  const text = 'a'.repeat(600) + name + 'b'.repeat(400);
  const scanner = createScanner(async () => ({ countTokens: () => 10, inference: async ({ texts: [chunk] }) => {
    const start = chunk.indexOf(name);
    return [start < 0 ? [] : [{ start, end: start + name.length, label: 'person', score: 0.95, spanText: name }]];
  } }));
  const entities = await scanner.scan(text);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].start, 600);
  assert.equal(entities[0].end, 600 + name.length);
});

test('chunks exceeding real tokenizer budget are subdivided without truncation', async () => {
  const scanned = [];
  const text = 'x'.repeat(1000);
  const scanner = createScanner(async () => ({ countTokens: (chunk) => chunk.length, inference: async ({ texts: [chunk] }) => {
    assert.ok(chunk.length <= 448);
    scanned.push(chunk);
    return [[]];
  } }));
  await scanner.scan(text);
  assert.ok(scanned.length > 2);
});

test('malformed model output fails the entire scan', async () => {
  const scanner = createScanner(async () => ({ countTokens: () => 10, inference: async () => [] }));
  await assert.rejects(scanner.scan('hello'));
});

test('tiny chunk boundaries progress across surrogate pairs', () => {
  assert.deepEqual(splitText('😀😀', 1, 0).map((chunk) => chunk.text), ['😀', '😀']);
  assert.deepEqual(splitText('😀😀', 2, 1).map((chunk) => chunk.text), ['😀', '😀']);
});
