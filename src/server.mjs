import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleDetectionMessage } from './mqtt.mjs';

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

function readRequestBuffer(req, { maxBytes = 15_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseBody(req) {
  const buffer = await readRequestBuffer(req, { maxBytes: 1_000_000 });
  const body = buffer.toString('utf8');
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Body must be valid JSON');
  }
}

function parseDisposition(value = '') {
  const parts = value.split(';').map(part => part.trim());
  return Object.fromEntries(parts.slice(1).map(part => {
    const equals = part.indexOf('=');
    if (equals === -1) return [part, ''];
    const key = part.slice(0, equals);
    const raw = part.slice(equals + 1);
    return [key, raw.replace(/^"|"$/g, '')];
  }));
}

function parseMultipartForm(buffer, contentType) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error('multipart boundary is required');

  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    cursor += delimiter.length;
    if (buffer.subarray(cursor, cursor + 2).toString() === '--') break;
    if (buffer.subarray(cursor, cursor + 2).toString() === '\r\n') cursor += 2;

    const next = buffer.indexOf(delimiter, cursor);
    if (next === -1) break;

    let part = buffer.subarray(cursor, next);
    if (part.subarray(part.length - 2).toString() === '\r\n') part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('latin1');
      const data = part.subarray(headerEnd + 4);
      const headers = Object.fromEntries(headerText.split('\r\n').map(line => {
        const colon = line.indexOf(':');
        if (colon === -1) return [line.toLowerCase(), ''];
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
      }));
      const disposition = parseDisposition(headers['content-disposition']);
      if (disposition.name) {
        if (disposition.filename) {
          files.push({
            fieldName: disposition.name,
            filename: disposition.filename,
            contentType: headers['content-type'] ?? 'application/octet-stream',
            data,
          });
        } else {
          fields[disposition.name] = data.toString('utf8');
        }
      }
    }

    cursor = next;
  }

  return { fields, files };
}

async function parseImageUpload(req, url) {
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.startsWith('multipart/form-data')) {
    const form = parseMultipartForm(await readRequestBuffer(req), contentType);
    const file = form.files.find(item => item.fieldName === 'image') ?? form.files[0];
    if (!file) throw new Error('image file is required');
    return {
      cameraId: form.fields.cameraId ?? form.fields.camera_id ?? url.searchParams.get('cameraId'),
      cameraName: form.fields.cameraName ?? form.fields.camera_name,
      bytes: file.data,
      filename: file.filename,
    };
  }

  if (contentType.startsWith('image/')) {
    return {
      cameraId: req.headers['x-camera-id'] ?? url.searchParams.get('cameraId'),
      cameraName: req.headers['x-camera-name'] ?? undefined,
      bytes: await readRequestBuffer(req),
      filename: 'upload',
    };
  }

  throw new Error('Use multipart/form-data with image=@file, or raw image/* bytes');
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

function testDetectionPayload(className = 'animal') {
  return JSON.stringify({
    timestamp: Date.now(),
    detections: [
      {
        className,
        score: 1,
        boundingBox: [540, 204, 180, 48],
        zones: [],
      },
    ],
    inputDimensions: [2560, 1920],
  });
}

export function createServer({ config, service, broadcaster }) {
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

      if (req.method === 'POST' && pathname === '/api/v1/test/detection') {
        const body = await parseBody(req);
        const topic = body.topic;
        if (!topic) {
          sendJson(res, 400, { error: 'topic is required' });
          return;
        }

        const message = body.payload
          ? JSON.stringify(body.payload)
          : testDetectionPayload(body.className ?? 'animal');
        const result = await handleDetectionMessage({
          config,
          service,
          topic,
          message,
          source: 'test',
          delay: body.delay ?? false,
        });
        sendJson(res, result.skipped ? 202 : 201, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/test/classify-image') {
        const upload = await parseImageUpload(req, url);
        if (!upload.cameraId) {
          sendJson(res, 400, { error: 'cameraId is required' });
          return;
        }

        const result = await service.classifyImageBuffer(upload.cameraId, upload.bytes, {
          cameraName: upload.cameraName,
          source: 'upload',
        });

        if (result.skipped) {
          console.log(`[${upload.cameraId}] upload skipped: ${result.reason} (${upload.filename})`);
        } else {
          const event = result.event;
          const confidence = event.confidence == null ? 'unknown' : `${Math.round(event.confidence * 100)}%`;
          console.log(`[${upload.cameraId}] upload classified ${upload.filename}: ${event.commonName} (${confidence})`);
        }

        sendJson(res, result.skipped ? 202 : 201, result);
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
