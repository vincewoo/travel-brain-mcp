import { createServer } from 'node:http';
import { loadConfig } from './config.mjs';

const config = loadConfig();
let application;
let stopping = false;

let requestHandler = (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if ((req.method === 'GET' || req.method === 'HEAD') && path === '/health') {
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(req.method === 'HEAD'
      ? undefined
      : JSON.stringify({ ok: true, service: 'travel-brain-mcp', status: 'starting' }));
    return;
  }
  res.writeHead(503, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': '5'
  });
  res.end(JSON.stringify({ error: 'Service is starting.' }));
};

const httpServer = createServer((req, res) => requestHandler(req, res));
await new Promise((resolve, reject) => {
  httpServer.listen(config.port, config.host, resolve);
  httpServer.once('error', reject);
});
console.info(`Travel Brain bootstrap listening host=${config.host} port=${config.port}`);

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`shutdown signal=${signal}`);
  await new Promise((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  });
  await application?.close();
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  const { createApplication } = await import('./server.mjs');
  application = await createApplication(config);
  requestHandler = application.app;
  console.info(
    `Travel Brain MCP ready auth_mode=${config.authMode} host=${config.host} port=${config.port} endpoint=/mcp`
  );
} catch (error) {
  console.error(`startup_error=${error.message}`);
  await new Promise((resolve) => httpServer.close(resolve));
  process.exitCode = 1;
}
