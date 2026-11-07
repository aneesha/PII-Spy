import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRedactions, validateEntities } from '../src/content/redaction.js';

test('redacts exclusive UTF-16 offsets in reverse order without shifting later matches', () => {
  const text = '😀 Jane: jane@example.com';
  assert.equal(applyRedactions(text, [
    { start: 3, end: 7, label: 'person' }, { start: 9, end: text.length, label: 'email' },
  ]), '😀 [PERSON]: [EMAIL]');
  assert.equal(applyRedactions(text, []), text);
});

test('merges overlapping selections so sensitive suffixes cannot survive offset corruption', () => {
  assert.equal(applyRedactions('1234567890', [
    { start: 0, end: 6, label: 'phone' }, { start: 4, end: 10, label: 'identifier' },
  ]), '[PII]');
  assert.equal(applyRedactions('1234567890', [
    { start: 0, end: 10, label: 'phone' }, { start: 2, end: 4, label: 'phone' },
  ]), '[PHONE]');
});

test('rejects malformed responses instead of interpreting them as a clean scan', () => {
  for (const entities of [null, {}, [{ start: -1, end: 2, label: 'email' }],
    [{ start: 0, end: 5, label: 'email' }], [{ start: 0, end: 0, label: 'email' }],
    [{ start: 0, end: 1, label: '' }], [{ start: 0, end: 1, label: 'person' }]]) {
    assert.throws(() => validateEntities('😀hi', entities));
  }
});
