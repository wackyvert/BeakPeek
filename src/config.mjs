import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function loadDotEnv(file = path.join(root, '.env')) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (!key || process.env[key] != null) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveMaybe(value, base = root) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function normalizeSnapshotUrls(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') return readJson(raw);
  return raw;
}

function normalizeMqtt(raw = {}) {
  const topics = Object.fromEntries(
    Object.entries(raw.topics ?? {}).filter(([topic, cameraId]) => topic && topic !== 'undefined' && cameraId),
  );
  return {
    broker: process.env.BEAKPEEK_MQTT_BROKER ?? raw.broker ?? '',
    topics,
  };
}

loadDotEnv();

const configPath = process.env.BEAKPEEK_CONFIG
  ? resolveMaybe(process.env.BEAKPEEK_CONFIG, process.cwd())
  : path.join(root, 'config.json');

const fileConfig = readJson(configPath);
const legacyRoot = resolveMaybe(
  process.env.BEAKPEEK_LEGACY_ROOT ?? fileConfig.legacyRoot ?? root,
  process.cwd(),
);
const dataDir = resolveMaybe(process.env.BEAKPEEK_DATA_DIR ?? fileConfig.dataDir ?? './data', root);
const assetsDir = resolveMaybe(process.env.BEAKPEEK_ASSETS_DIR ?? fileConfig.assetsDir ?? './assets', root);

export const config = {
  root,
  host: process.env.BEAKPEEK_HOST ?? fileConfig.host ?? '0.0.0.0',
  port: numberFromEnv('BEAKPEEK_PORT', fileConfig.port ?? 8787),
  legacyRoot,
  dataDir,
  imageDir: path.join(dataDir, 'images'),
  tmpDir: path.join(dataDir, 'tmp'),
  dbPath: resolveMaybe(process.env.BEAKPEEK_DB ?? fileConfig.dbPath ?? './data/beakpeek.db', root),
  python: process.env.BEAKPEEK_PYTHON ?? fileConfig.python ?? 'python3',
  classifierScript: resolveMaybe(fileConfig.classifierScript ?? './scripts/classify.py', root),
  modelPath: resolveMaybe(process.env.BEAKPEEK_MODEL ?? fileConfig.modelPath ?? path.join(assetsDir, 'model.tflite'), root),
  labelsPath: resolveMaybe(process.env.BEAKPEEK_LABELS ?? fileConfig.labelsPath ?? path.join(assetsDir, 'labels.json'), root),
  birdNamesDb: resolveMaybe(process.env.BEAKPEEK_BIRD_NAMES_DB ?? fileConfig.birdNamesDb ?? path.join(assetsDir, 'birdnames.db'), root),
  detectionDelayMs: numberFromEnv('BEAKPEEK_DETECTION_DELAY_MS', fileConfig.detectionDelayMs ?? 14000),
  dedupeWindowMs: numberFromEnv('BEAKPEEK_DEDUPE_WINDOW_MS', fileConfig.dedupeWindowMs ?? 30000),
  snapshotUrls: normalizeSnapshotUrls(
    process.env.BEAKPEEK_SNAPSHOT_URLS ?? fileConfig.snapshotUrls ?? fileConfig.SNAPSHOT_URLS,
  ),
  mqtt: normalizeMqtt(fileConfig.mqtt ?? {
    broker: fileConfig.MQTT_BROKER,
    topics: Object.fromEntries([
      [fileConfig.MQTT_TOPIC, '117'],
      [fileConfig.MQTT_TOPIC2, '133'],
      [fileConfig.MQTT_TOPIC3, '132'],
      [fileConfig.MQTT_TOPIC4, '140'],
    ].filter(([topic]) => topic)),
  }),
};

export function ensureRuntimeDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.imageDir, { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
}
