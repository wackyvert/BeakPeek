import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { eventFromRow } from './db.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function idFor(timestamp, cameraId, hash) {
  return crypto
    .createHash('sha256')
    .update(`${timestamp}:${cameraId}:${hash}`)
    .digest('hex')
    .slice(0, 24);
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sanitizeSnapshotUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      parsed.searchParams.set(key, 'REDACTED');
    }
    return parsed.toString();
  } catch {
    return 'snapshot URL';
  }
}

function sanitizeLogText(text) {
  return text.replace(/([?&](?:secret|user_token|token)=)[^&\s]+/gi, '$1REDACTED');
}

function speciesKey(commonName, scientificName) {
  const name = commonName ?? scientificName;
  const normalized = name?.trim().toLowerCase();
  return normalized || null;
}

function booleanPreference(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function haServicePath(service) {
  const normalized = service.replace(/^notify\./, '');
  return `/api/services/notify/${encodeURIComponent(normalized)}`;
}

function postJson(url, body, { token, allowInsecureTLS = false } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(body);
    const req = client.request(
      parsed,
      {
        method: 'POST',
        rejectUnauthorized: parsed.protocol === 'https:' ? !allowInsecureTLS : undefined,
        timeout: 15000,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const detail = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim();
            reject(new Error(`Home Assistant notify failed with HTTP ${status}${detail ? `: ${detail.slice(0, 240)}` : ''}`));
            return;
          }
          resolve();
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error('Home Assistant notify timed out after 15s')));
    req.on('error', reject);
    req.end(payload);
  });
}

function isRetryableSnapshotStatus(status) {
  return [400, 404, 408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isMissingDetectionSnapshot(error) {
  return [400, 404].includes(error.status)
    && error.body?.includes('ENOENT')
    && error.body?.includes('/detections/');
}

function fetchSnapshot(url, { allowInsecureTLS = false, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(
      parsed,
      {
        rejectUnauthorized: parsed.protocol === 'https:' ? !allowInsecureTLS : undefined,
        timeout: 30000,
        headers: {
          accept: 'image/jpeg,image/webp,image/*;q=0.9,*/*;q=0.5',
          'user-agent': 'BeakPeekService/0.1',
        },
      },
      res => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        if ([301, 302, 303, 307, 308].includes(status) && location && redirects < 3) {
          res.resume();
          resolve(fetchSnapshot(new URL(location, parsed).toString(), { allowInsecureTLS, redirects: redirects + 1 }));
          return;
        }

        if (status < 200 || status >= 300) {
          const chunks = [];
          res.on('data', chunk => {
            if (Buffer.concat(chunks).byteLength < 512) chunks.push(chunk);
          });
          res.on('end', () => {
            const body = sanitizeLogText(Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim());
            const detail = body ? `: ${body.slice(0, 240)}` : '';
            reject(Object.assign(
              new Error(`Snapshot fetch failed with HTTP ${status} for ${sanitizeSnapshotUrl(url)}${detail}`),
              { status, body },
            ));
          });
          return;
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );

    req.on('timeout', () => req.destroy(new Error('Snapshot fetch timed out after 30s')));
    req.on('error', error => {
      reject(new Error(`Snapshot fetch failed: ${error.message}`));
    });
  });
}

async function fetchSnapshotWithRetries(url, { allowInsecureTLS, attempts = 1, retryDelayMs = 1000 } = {}) {
  let lastError;
  const totalAttempts = Math.max(1, attempts);
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return await fetchSnapshot(url, { allowInsecureTLS });
    } catch (error) {
      lastError = error;
      if (attempt === totalAttempts || !isRetryableSnapshotStatus(error.status)) break;
      await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

function jsonFromProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`Classifier returned invalid JSON: ${stdout.trim() || error.message}`));
      }
    });
  });
}

export class BeakPeekService {
  constructor({ config, db, broadcaster }) {
    this.config = config;
    this.db = db;
    this.broadcaster = broadcaster;
    this.inFlight = new Set();
    this.commonNameDb = fs.existsSync(config.birdNamesDb)
      ? new DatabaseSync(config.birdNamesDb, { readOnly: true })
      : null;
  }

  async classifyCamera(cameraId, options = {}) {
    if (!cameraId) throw new Error('cameraId is required');
    if (this.inFlight.has(cameraId)) return { skipped: true, reason: 'already_running', cameraId };

    this.inFlight.add(cameraId);
    try {
      if (options.delay !== false && this.config.detectionDelayMs > 0) {
        await sleep(this.config.detectionDelayMs);
      }

      const snapshotUrl = this.config.snapshotUrls[cameraId];
      if (!snapshotUrl) throw new Error(`No snapshot URL configured for camera ${cameraId}`);

      let bytes;
      try {
        bytes = await fetchSnapshotWithRetries(snapshotUrl, {
          allowInsecureTLS: this.config.snapshotAllowInsecureTLS,
          attempts: this.config.snapshotFetchAttempts,
          retryDelayMs: this.config.snapshotRetryDelayMs,
        });
      } catch (error) {
        if (isMissingDetectionSnapshot(error)) {
          return { skipped: true, reason: 'snapshot_missing', cameraId };
        }
        throw error;
      }
      return await this.classifyImageBuffer(cameraId, bytes, {
        source: options.source ?? 'snapshot',
        cropBox: options.cropBox,
      });
    } finally {
      this.inFlight.delete(cameraId);
    }
  }

  async classifyImageBuffer(cameraId, bytes, options = {}) {
    const now = Date.now();
    const imageHash = hashBuffer(bytes);
    const last = this.db
      .prepare('SELECT image_hash AS imageHash, updated_at AS updatedAt FROM camera_hashes WHERE camera_id = ?')
      .get(cameraId);

    if (last?.imageHash === imageHash && now - last.updatedAt < this.config.dedupeWindowMs) {
      return { skipped: true, reason: 'duplicate', cameraId };
    }

    const tmpPath = path.join(this.config.tmpDir, `${cameraId}-${now}.jpg`);
    fs.writeFileSync(tmpPath, bytes);

    let result;
    let processedBytes = bytes;
    try {
      processedBytes = await this.cropImageBuffer(cameraId, tmpPath, bytes, options.cropBox);
      if (processedBytes !== bytes) {
        fs.writeFileSync(tmpPath, processedBytes);
      }
      result = await this.runClassifier(cameraId, tmpPath);
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }

    const scientificName = result.label;
    const commonName = this.lookupCommonName(scientificName) ?? scientificName;
    const id = idFor(now, cameraId, imageHash);
    const imagePath = path.join(this.config.imageDir, `${id}.jpg`);
    fs.writeFileSync(imagePath, processedBytes);

    this.db
      .prepare(`
        INSERT OR REPLACE INTO events (
          id, timestamp, camera_id, camera_name, prediction_index, scientific_name,
          common_name, confidence, image_path, image_hash, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        now,
        cameraId,
        options.cameraName ?? cameraId,
        result.predictionIndex,
        scientificName,
        commonName,
        result.confidence ?? null,
        imagePath,
        imageHash,
        options.source ?? 'snapshot',
        now,
      );

    this.db
      .prepare('INSERT OR REPLACE INTO camera_hashes (camera_id, image_hash, updated_at) VALUES (?, ?, ?)')
      .run(cameraId, imageHash, now);

    const event = this.getEvent(id);
    this.broadcaster?.publish('event', event);
    this.notifyForEvent(event).catch(error => {
      console.warn(`[notify] ${error.message}`);
    });
    return { skipped: false, event };
  }

  async runClassifier(cameraId, imagePath) {
    return jsonFromProcess(
      this.config.python,
      [
        this.config.classifierScript,
        imagePath,
        '--model',
        this.config.modelPath,
        '--labels',
        this.config.labelsPath,
        '--camera-id',
        cameraId,
      ],
      { cwd: this.config.root },
    );
  }

  async cropImageBuffer(cameraId, imagePath, fallbackBytes, cropBox) {
    if (!this.config.cropImages) return fallbackBytes;

    const croppedPath = path.join(this.config.tmpDir, `${cameraId}-${Date.now()}-crop.jpg`);
    try {
      const args = [
        this.config.cropScript,
        imagePath,
        croppedPath,
        '--aspect',
        this.config.cropAspect,
      ];
      if (Array.isArray(cropBox)) {
        args.push('--box', cropBox.join(','));
      }

      await jsonFromProcess(
        this.config.python,
        args,
        { cwd: this.config.root },
      );
      return fs.readFileSync(croppedPath);
    } catch (error) {
      console.warn(`[${cameraId}] smart crop skipped: ${error.message}`);
      return fallbackBytes;
    } finally {
      fs.rmSync(croppedPath, { force: true });
    }
  }

  lookupCommonName(scientificName) {
    if (!this.commonNameDb || !scientificName) return null;
    const row = this.commonNameDb
      .prepare('SELECT common_name AS commonName FROM birdnames WHERE scientific_name = ?')
      .get(scientificName);
    return row?.commonName ?? null;
  }

  getEvents({ limit = 50, cameraId, date } = {}) {
    const params = [];
    const where = [];
    if (cameraId) {
      where.push('camera_id = ?');
      params.push(cameraId);
    }
    if (date) {
      const start = Date.parse(`${date}T00:00:00.000Z`);
      const end = Date.parse(`${date}T23:59:59.999Z`);
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('date must be YYYY-MM-DD');
      where.push('timestamp BETWEEN ? AND ?');
      params.push(start, end);
    }

    const sql = `
      SELECT * FROM events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...params, limit).map(eventFromRow);
  }

  getEvent(id) {
    return eventFromRow(this.db.prepare('SELECT * FROM events WHERE id = ?').get(id));
  }

  getEventImage(id) {
    const row = this.db.prepare('SELECT image_path AS imagePath FROM events WHERE id = ?').get(id);
    if (!row?.imagePath || !fs.existsSync(row.imagePath)) return null;
    return row.imagePath;
  }

  deleteEvent(id) {
    const row = this.db.prepare('SELECT image_path AS imagePath FROM events WHERE id = ?').get(id);
    const result = this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
    if (result.changes > 0 && row?.imagePath) fs.rmSync(row.imagePath, { force: true });
    return result.changes > 0;
  }

  getSpecies() {
    return this.db
      .prepare(`
        SELECT common_name AS commonName, scientific_name AS scientificName, COUNT(*) AS count
        FROM events
        GROUP BY common_name, scientific_name
        ORDER BY common_name COLLATE NOCASE ASC
      `)
      .all();
  }

  getNotificationPreferences() {
    const rows = this.db.prepare('SELECT key, value FROM notification_preferences').all();
    const prefs = Object.fromEntries(rows.map(row => [row.key, row.value]));
    const rules = this.db
      .prepare(`
        SELECT species_key AS speciesKey, common_name AS commonName, scientific_name AS scientificName, enabled
        FROM notification_species
        ORDER BY COALESCE(common_name, scientific_name, species_key) COLLATE NOCASE ASC
      `)
      .all()
      .map(row => ({
        speciesKey: row.speciesKey,
        commonName: row.commonName,
        scientificName: row.scientificName,
        enabled: Boolean(row.enabled),
      }));

    const ha = this.config.homeAssistant;
    return {
      enabled: booleanPreference(prefs.enabled, false),
      notifyAllVisitors: booleanPreference(prefs.notifyAllVisitors, false),
      homeAssistantConfigured: Boolean(ha.baseUrl && ha.token && ha.notifyService),
      notifyService: ha.notifyService ? `notify.${ha.notifyService}` : '',
      rules,
    };
  }

  setNotificationPreferences({ enabled, notifyAllVisitors } = {}) {
    const now = Date.now();
    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO notification_preferences (key, value, updated_at)
      VALUES (?, ?, ?)
    `);
    if (enabled != null) statement.run('enabled', enabled ? 'true' : 'false', now);
    if (notifyAllVisitors != null) {
      statement.run('notifyAllVisitors', notifyAllVisitors ? 'true' : 'false', now);
    }
    return this.getNotificationPreferences();
  }

  setNotificationSpecies({ speciesKey: key, commonName, scientificName, enabled }) {
    const normalizedKey = key ?? speciesKey(commonName, scientificName);
    if (!normalizedKey) throw new Error('speciesKey is required');
    this.db
      .prepare(`
        INSERT OR REPLACE INTO notification_species (
          species_key, common_name, scientific_name, enabled, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(normalizedKey, commonName ?? null, scientificName ?? null, enabled ? 1 : 0, Date.now());
    return this.getNotificationPreferences();
  }

  clearNotificationSpecies() {
    this.db.prepare('DELETE FROM notification_species').run();
    return this.getNotificationPreferences();
  }

  enableAllNotificationSpecies() {
    const now = Date.now();
    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO notification_species (
        species_key, common_name, scientific_name, enabled, updated_at
      ) VALUES (?, ?, ?, 1, ?)
    `);
    for (const item of this.getSpecies()) {
      const key = speciesKey(item.commonName, item.scientificName);
      if (key) statement.run(key, item.commonName ?? null, item.scientificName ?? null, now);
    }
    return this.getNotificationPreferences();
  }

  async notifyForEvent(event) {
    const preferences = this.getNotificationPreferences();
    if (!preferences.enabled || !preferences.homeAssistantConfigured) return;

    const key = speciesKey(event.commonName, event.scientificName);
    const matchedRule = key && preferences.rules.some(rule => rule.enabled && rule.speciesKey === key);
    if (!preferences.notifyAllVisitors && !matchedRule) return;

    const ha = this.config.homeAssistant;
    const url = `${ha.baseUrl}${haServicePath(ha.notifyService)}`;
    const confidence = event.confidence == null ? '' : ` (${Math.round(event.confidence * 100)}%)`;
    await postJson(
      url,
      {
        title: `BeakPeek: ${event.commonName ?? event.scientificName ?? 'Visitor'}`,
        message: `${event.cameraName} spotted ${event.commonName ?? event.scientificName ?? 'a visitor'}${confidence}`,
        data: {
          tag: `beakpeek-${event.id}`,
          group: 'beakpeek',
        },
      },
      {
        token: ha.token,
        allowInsecureTLS: ha.allowInsecureTLS,
      },
    );
  }

  getSummary() {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const latest = eventFromRow(this.db.prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT 1').get());
    const visitsLast2h = this.db
      .prepare('SELECT COUNT(*) AS count FROM events WHERE timestamp >= ?')
      .get(now - 2 * 60 * 60 * 1000).count;
    const todaySpecies = this.db
      .prepare('SELECT COUNT(DISTINCT COALESCE(common_name, scientific_name)) AS count FROM events WHERE timestamp >= ?')
      .get(todayStart.getTime()).count;
    const eventCameras = this.db
      .prepare('SELECT DISTINCT camera_id AS cameraId FROM events ORDER BY camera_id ASC')
      .all()
      .map(row => row.cameraId);

    return {
      service: 'beakpeek',
      generatedAt: now,
      latest,
      visitsLast2h,
      todaySpecies,
      cameras: [...new Set([...Object.keys(this.config.snapshotUrls), ...eventCameras])].sort(),
      inFlight: [...this.inFlight].sort(),
    };
  }
}
