import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'public');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Body must be valid JSON'));
      }
    });
  });
}

function contentTypeFor(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDir, requested);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return false;
  }
  res.writeHead(200, { 'content-type': contentTypeFor(file) });
  fs.createReadStream(file).pipe(res);
  return true;
}

export class EventBroadcaster {
  constructor() {
    this.clients = new Set();
  }

  add(res) {
    this.clients.add(res);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('event: hello\ndata: {"ok":true}\n\n');
    res.on('close', () => this.clients.delete(res));
  }

  publish(type, payload) {
    const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) client.write(message);
  }

  close() {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }
}

export function createServer({ service, broadcaster }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const pathname = decodeURIComponent(url.pathname);

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true, summary: service.getSummary() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/summary') {
        sendJson(res, 200, service.getSummary());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/events') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 250);
        const cameraId = url.searchParams.get('cameraId') ?? undefined;
        const date = url.searchParams.get('date') ?? undefined;
        sendJson(res, 200, service.getEvents({ limit, cameraId, date }));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/species') {
        sendJson(res, 200, service.getSpecies());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/stream') {
        broadcaster.add(res);
        return;
      }

      const eventImage = pathname.match(/^\/api\/v1\/events\/([^/]+)\/image$/);
      if (req.method === 'GET' && eventImage) {
        const file = service.getEventImage(eventImage[1]);
        if (!file) {
          sendJson(res, 404, { error: 'Image not found' });
          return;
        }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
        fs.createReadStream(file).pipe(res);
        return;
      }

      const eventDelete = pathname.match(/^\/api\/v1\/events\/([^/]+)$/);
      if (req.method === 'DELETE' && eventDelete) {
        const deleted = service.deleteEvent(eventDelete[1]);
        res.writeHead(deleted ? 204 : 404);
        res.end();
        return;
      }

      const classify = pathname.match(/^\/api\/v1\/cameras\/([^/]+)\/classify$/);
      if (req.method === 'POST' && classify) {
        const body = await parseBody(req);
        const result = await service.classifyCamera(classify[1], {
          delay: body.delay,
          source: 'manual',
        });
        sendJson(res, result.skipped ? 202 : 201, result);
        return;
      }

      if (req.method === 'GET' && serveStatic(req, res, pathname)) return;

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}
