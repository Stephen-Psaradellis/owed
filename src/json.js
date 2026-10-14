// Tolerant JSON extraction from model output: code fences, leading or trailing prose,
// trailing commas and smart quotes. Returns null when nothing parseable is found, and the
// caller falls back to its deterministic path.

export function parseJsonLoose(input) {
  if (input == null) return null;
  if (typeof input === 'object') return input;
  let s = String(input).trim();
  if (!s) return null;
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const tryParse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(s);
  if (v !== undefined && v !== null && typeof v === 'object') return v;
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const chunk = balanced(s, start);
  if (!chunk) return null;
  v = tryParse(chunk);
  if (v !== undefined) return v;
  const repaired = chunk
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  v = tryParse(repaired);
  return v === undefined ? null : v;
}

// Substring from `start` to its matching close bracket, aware of JSON strings.
function balanced(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"' || c === '”') inStr = false;
      continue;
    }
    if (c === '"' || c === '“') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
