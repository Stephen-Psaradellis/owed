// Entry point: `npm start`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv, ROOT } from './config.js';

loadDotEnv();
const { createApp } = await import('./app.js');
const app = createApp();
const { config, log } = app;

if (!fs.existsSync(path.join(ROOT, 'public', 'build', 'timeline.js'))) {
  log('[owed] The timeline bundle is missing. Run `npm run build` (npm install runs it for you).');
}

const server = http.createServer(app.handler);
server.listen(config.port, config.host, () => {
  log(`[owed] ${config.appName} ${config.version} on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  log(`[owed] PayPal: ${config.paypal.mode === 'sandbox' ? 'sandbox (api-m.sandbox.paypal.com)' : 'DEMO MODE (in-memory PayPal fake; set PAYPAL_CLIENT_ID/SECRET for the sandbox)'}`);
  log(`[owed] LLM: ${config.llm.mode === 'live' ? `${config.llm.model} via ${new URL(config.llm.baseUrl).host}` : 'deterministic demo model (set LLM_BASE_URL/LLM_MODEL for a real one)'}`);
  app.startPolling();
});

const stop = () => {
  app.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
