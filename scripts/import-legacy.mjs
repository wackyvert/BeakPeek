import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ensureRuntimeDirs } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';

const legacyDbPath = process.argv[2] ?? path.join(config.legacyRoot, 'events.db');
const limit = Number(process.argv[3] ?? 250);

if (!fs.existsSync(legacyDbPath)) {
  throw new Error(`Legacy events database not found: ${legacyDbPath}`);
}

ensureRuntimeDirs();
const source = new DatabaseSync(legacyDbPath, { readOnly: true });
const target = openDatabase(config);

const rows = source
  .prepare(`
    SELECT timestamp, predictionIndex, predictionName, image, cameraID
    FROM events
    ORDER BY timestamp DESC
    LIMIT ?
  `)
  .all(limit);

const insert = target.prepare(`
  INSERT OR IGNORE INTO events (
    id, timestamp, camera_id, camera_name, prediction_index, scientific_name,
    common_name, confidence, image_path, image_hash, source, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let imported = 0;
for (const row of rows) {
  const image = row.image ? Buffer.from(row.image) : null;
  const hash = image ? crypto.createHash('sha256').update(image).digest('hex') : '';
  const cameraId = row.cameraID ?? 'legacy';
  const id = crypto
    .createHash('sha256')
    .update(`${row.timestamp}:${cameraId}:${hash}`)
    .digest('hex')
    .slice(0, 24);
  const imagePath = image ? path.join(config.imageDir, `${id}.jpg`) : null;

  if (image && !fs.existsSync(imagePath)) fs.writeFileSync(imagePath, image);

  const result = insert.run(
    id,
    row.timestamp,
    cameraId,
    cameraId,
    row.predictionIndex,
    row.predictionName,
    row.predictionName,
    null,
    imagePath,
    hash || null,
    'legacy-import',
    Date.now(),
  );
  imported += result.changes;
}

console.log(JSON.stringify({ imported, scanned: rows.length, db: config.dbPath }, null, 2));
