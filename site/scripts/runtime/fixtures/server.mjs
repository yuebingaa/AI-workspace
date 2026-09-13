import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.env.STUDIO_LOCAL_STATE_DIR;
if (state) mkdirSync(state, { recursive: true });
const port = Number(process.env.PORT || process.env.HARNESS_PLAYWRIGHT_CAPTURE_PORT);
createServer((request, response) => {
  if (request.url === '/crash') { response.end('crashing'); setTimeout(() => process.exit(7), 25); return; }
  if (request.url === '/write') writeFileSync(join(state, 'marker.txt'), 'survives restart');
  if (request.url === '/marker') { response.end(readFileSync(join(state, 'marker.txt'), 'utf8')); return; }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: state && existsSync(join(state, 'degraded')) ? 'degraded' : 'ok', persistence: { configured: true } }));
}).listen(port, '127.0.0.1');
