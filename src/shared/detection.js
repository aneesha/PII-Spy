export const MAX_TEXT_LENGTH = 50_000;
export const PII_LABELS = Object.freeze([
  'person', 'email', 'phone number', 'credit card', 'ssn',
  'ip address', 'physical address', 'api key', 'date of birth',
]);

export function validateText(text) {
  if (typeof text !== 'string') throw new TypeError('The paste must contain plain text.');
  if (text.length > MAX_TEXT_LENGTH) {
    throw new RangeError(`Paste exceeds the ${MAX_TEXT_LENGTH.toLocaleString('en-US')} character scan limit.`);
  }
}

function luhn(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// Local high-confidence structured patterns complement the statistical model.
// They are intentionally not a substitute for a successful model scan.
export function detectStructured(text) {
  validateText(text);
  const entities = [];
  const add = (pattern, label, predicate = () => true) => {
    for (const match of text.matchAll(pattern)) {
      if (predicate(match[0])) entities.push({ start: match.index, end: match.index + match[0].length, label, score: 1, source: 'pattern' });
    }
  };
  add(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi, 'email');
  add(/(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/g, 'ssn');
  add(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, 'ip address', (value) => value.split('.').every((part) => Number(part) <= 255));
  add(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b/g, 'api key');
  add(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, 'credit card', luhn);
  const validPhoneLength = (value) => {
    const count = value.replace(/\D/g, '').length;
    return count >= 9 && count <= 15;
  };
  add(/(?<![\d\w])\+\d{1,3}(?:[ .-]?\d){7,14}(?!\d)/g, 'phone number', validPhoneLength);
  add(/(?<![\d.-])(?:1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\d.-])/g, 'phone number', validPhoneLength);
  add(/(?<![\d.-])04\d{2}[ .-]\d{3}[ .-]\d{3}(?![\d.-])/g, 'phone number', validPhoneLength);
  return mergeEntities(text, entities);
}

// Merge all intersecting detections into a union. Dropping the lower-confidence
// overlap could otherwise leave part of a sensitive value unredacted.
export function mergeEntities(text, entities) {
  const sorted = entities.map((entity) => {
    if (!entity || !Number.isInteger(entity.start) || !Number.isInteger(entity.end) || entity.start < 0 || entity.end <= entity.start || entity.end > text.length || typeof entity.label !== 'string' || !entity.label.trim() || !Number.isFinite(entity.score) || entity.score < 0 || entity.score > 1) {
      throw new TypeError('The detector returned invalid entity offsets or confidence.');
    }
    if (entity.spanText !== undefined && entity.spanText !== text.slice(entity.start, entity.end)) {
      throw new TypeError('The detector returned inconsistent text offsets.');
    }
    return { start: entity.start, end: entity.end, label: entity.label, score: entity.score, source: entity.source || 'model' };
  }).sort((a, b) => a.start - b.start || b.end - a.end || b.score - a.score);
  const merged = [];
  for (const entity of sorted) {
    const previous = merged.at(-1);
    if (previous && entity.start < previous.end) {
      const exact = previous.start === entity.start && previous.end === entity.end;
      const preferred = entity.source === 'pattern' ? entity : previous;
      previous.label = exact ? preferred.label : previous.label === entity.label ? previous.label : 'sensitive data';
      previous.end = Math.max(previous.end, entity.end);
      previous.score = Math.max(previous.score, entity.score);
      previous.source = previous.source === entity.source ? previous.source : 'combined';
    } else merged.push({ ...entity });
  }
  return merged.map((entity) => ({ ...entity, spanText: text.slice(entity.start, entity.end) }));
}

// Split on code-point boundaries with overlap. Actual tokenizer lengths are
// checked later, before every inference, so no tail is silently truncated.
export function splitText(text, size = 700, overlap = 160) {
  if (!Number.isInteger(size) || !Number.isInteger(overlap) || overlap < 0 || size <= overlap) throw new RangeError('Invalid chunk size.');
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    if (end === start) end = Math.min(start + 2, text.length);
    chunks.push({ text: text.slice(start, end), start });
    if (end === text.length) break;
    let nextStart = end - overlap;
    if (/[\uDC00-\uDFFF]/.test(text[nextStart]) && /[\uD800-\uDBFF]/.test(text[nextStart - 1])) nextStart -= 1;
    // A surrogate pair can be wider than a deliberately tiny chunk.
    // Guarantee progress even when retaining the overlap is impossible.
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}
