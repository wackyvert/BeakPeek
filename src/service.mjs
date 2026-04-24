import crypto from 'node:crypto';
import fs from 'node:fs';
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

      const response = await fetch(snapshotUrl, {
        headers: {
          accept: 'image/jpeg,image/webp,image/*;q=0.9,*/*;q=0.5',
          'user-agent': 'BeakPeekService/0.1',
        },
      });
      if (!response.ok) throw new Error(`Snapshot fetch failed with ${response.status}`);

      const bytes = Buffer.from(await response.arrayBuffer());
      return await this.classifyImageBuffer(cameraId, bytes, { source: options.source ?? 'snapshot' });
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
    try {
      result = await this.runClassifier(cameraId, tmpPath);
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }

    const scientificName = result.label;
    const commonName = this.lookupCommonName(scientificName) ?? scientificName;
    const id = idFor(now, cameraId, imageHash);
    const imagePath = path.join(this.config.imageDir, `${id}.jpg`);
    fs.writeFileSync(imagePath, bytes);

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
