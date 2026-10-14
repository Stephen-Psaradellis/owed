// Secret redaction for everything that leaves the server: API responses, the SSE trace,
// error messages and console logs. Defence in depth: the code never puts a secret in
// those places on purpose, and this catches the accidents.

const PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1[redacted]'],
  [/(Basic\s+)[A-Za-z0-9+/=]{8,}/g, '$1[redacted]'],
  [/(\\?"access_token\\?"\s*:\s*\\?")[^"\\]+/g, '$1[redacted]'],
  [/(access_token=)[^&\s]+/g, '$1[redacted]'],
];

export function createRedactor(secrets = []) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  const redactString = (s) => {
    let out = String(s);
    for (const secret of list) out = out.split(secret).join('[redacted]');
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  };
  const redact = (value) => {
    if (value == null) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object') return value;
    return JSON.parse(redactString(JSON.stringify(value)));
  };
  return { redact, redactString };
}
