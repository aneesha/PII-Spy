// Offsets are JavaScript UTF-16 offsets, with an exclusive end.
export function validateEntities(text, entities) {
  if (!Array.isArray(entities)) throw new Error('Invalid scan response.');
  for (const entity of entities) {
    if (!entity || !Number.isInteger(entity.start) || !Number.isInteger(entity.end)
      || entity.start < 0 || entity.end <= entity.start || entity.end > text.length
      || typeof entity.label !== 'string' || !entity.label.trim() || entity.label.length > 100
      || splitsSurrogate(text, entity.start) || splitsSurrogate(text, entity.end)) {
      throw new Error('The scan returned invalid text offsets.');
    }
  }
  return entities.map(({ start, end, label, score, source }) => ({ start, end, label, score, source }));
}

function splitsSurrogate(text, offset) {
  return offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
}

export function applyRedactions(text, entities) {
  const sorted = validateEntities(text, entities).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const entity of sorted) {
    const previous = merged.at(-1);
    if (previous && entity.start < previous.end) {
      previous.end = Math.max(previous.end, entity.end);
      if (previous.label !== entity.label) previous.label = 'pii';
    } else {
      merged.push({ ...entity });
    }
  }
  return merged.reverse().reduce((result, entity) => {
    const label = entity.label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'PII';
    return result.slice(0, entity.start) + `[${label}]` + result.slice(entity.end);
  }, text);
}
