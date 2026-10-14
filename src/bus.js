// The trace bus. Every agent step, LLM call and PayPal call is published here, redacted,
// kept in a ring buffer (so a page that connects late still sees the recent history) and
// streamed to browsers over Server-Sent Events.
import { EventEmitter } from 'node:events';

export function createBus({ redact = (x) => x, size = 300 } = {}) {
  const em = new EventEmitter();
  em.setMaxListeners(100);
  const buffer = [];
  let seq = 0;
  return {
    trace(entry) {
      const e = redact({ seq: ++seq, ts: new Date().toISOString(), ...entry });
      buffer.push(e);
      if (buffer.length > size) buffer.shift();
      em.emit('trace', e);
      return e;
    },
    ledgerChanged(reason = 'update') {
      em.emit('ledger', { ts: new Date().toISOString(), reason });
    },
    recent() {
      return buffer.slice();
    },
    clear() {
      buffer.length = 0;
      em.emit('clear', {});
    },
    on(type, fn) {
      em.on(type, fn);
      return () => em.off(type, fn);
    },
  };
}
