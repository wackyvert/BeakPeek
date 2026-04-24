import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      camera_id TEXT NOT NULL,
      camera_name TEXT,
      prediction_index INTEGER,
      scientific_name TEXT,
      common_name TEXT,
      confidence REAL,
      image_path TEXT,
      image_hash TEXT,
      source TEXT NOT NULL DEFAULT 'snapshot',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_camera ON events(camera_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_species ON events(common_name, scientific_name);

    CREATE TABLE IF NOT EXISTS camera_hashes (
      camera_id TEXT PRIMARY KEY,
      image_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function eventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    cameraId: row.camera_id,
    cameraName: row.camera_name ?? row.camera_id,
    predictionIndex: row.prediction_index,
    scientificName: row.scientific_name,
    commonName: row.common_name ?? row.scientific_name,
    confidence: row.confidence,
    imageUrl: row.image_path ? `/api/v1/events/${encodeURIComponent(row.id)}/image` : null,
    source: row.source,
  };
}
