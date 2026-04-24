# BeakPeek Service

Standalone feeder intelligence for HADash. This replaces the old all-in-one `feeder.js` from `AuvikDashboard` with a small service that exposes a stable JSON API, stores observations in SQLite, serves event images, and can still listen to the feeder MQTT topics.

## Run

```sh
cd BeakPeekService
cp config.example.json config.json
npm install
npm run setup:python
npm start
```

The default API is `http://localhost:8787`.

`npm run setup:python` installs the classifier dependencies into a repo-local venv. The service automatically uses `venv/bin/python` first, then `.venv/bin/python`, then falls back to `python3` unless `BEAKPEEK_PYTHON` is set.

## Portable Assets

The service no longer assumes any machine-specific path. Put the classifier assets beside the clone:

```txt
BeakPeekService/
└── assets/
    ├── model.tflite
    ├── labels.json
    └── birdnames.db
```

These assets are committed to the repo so a fresh clone can run from its own folder. If you want to test a different model or taxonomy later, point `config.json` or env vars at the replacement files.

## Key Endpoints

- `GET /api/v1/summary` - small payload for the tvOS dashboard.
- `GET /api/v1/events?limit=50` - latest feeder observations.
- `GET /api/v1/events/:id/image` - event image.
- `GET /api/v1/species` - species list with counts.
- `GET /api/v1/stream` - Server-Sent Events for live updates.
- `POST /api/v1/cameras/:cameraId/classify` - manually fetch and classify a camera snapshot.
- `POST /api/v1/test/detection` - simulate the MQTT animal detection payload for a mapped topic.

Test the full MQTT-style route without waiting for a feeder event:

```sh
curl -X POST http://localhost:8787/api/v1/test/detection \
  -H 'content-type: application/json' \
  -d '{"topic":"birdfeeder4/ObjectDetector"}'
```

## Config

The service reads `config.json` or a file pointed to by `BEAKPEEK_CONFIG`. Relative paths are resolved from the service root, so a cloned repo works the same way on any machine.

Useful env overrides:

```sh
BEAKPEEK_PORT=8787
BEAKPEEK_CONFIG=/path/to/config.json
BEAKPEEK_DATA_DIR=/path/to/data
BEAKPEEK_ASSETS_DIR=/path/to/assets
BEAKPEEK_MODEL=/path/to/model.tflite
BEAKPEEK_LABELS=/path/to/labels.json
BEAKPEEK_BIRD_NAMES_DB=/path/to/birdnames.db
BEAKPEEK_SNAPSHOT_ALLOW_INSECURE_TLS=true
BEAKPEEK_SNAPSHOT_FETCH_ATTEMPTS=3
BEAKPEEK_SNAPSHOT_RETRY_DELAY_MS=1500
BEAKPEEK_MQTT_BROKER=mqtt://192.168.68.104:1883
```

For Scrypted snapshot URLs that only differ by camera ID, use a local `config.json` value:

```json
{
  "snapshotImageName": "object-detection__animal",
  "snapshotAllowInsecureTLS": true,
  "snapshotFetchAttempts": 3,
  "snapshotRetryDelayMs": 1500,
  "snapshotUrlTemplate": "https://your-scrypted-host/endpoint/snapshot/{cameraId}/{IMAGE_NAME}?secret=...&user_token=..."
}
```

The `{cameraId}` token is expanded from the MQTT topic map, and `{IMAGE_NAME}` defaults to `object-detection__animal`. Keep this in `config.json` or `.env`; both are ignored so snapshot secrets do not get committed.

If one camera ever needs a different URL, add a `snapshotUrls` object in local `config.json`; explicit camera URLs override the template for matching IDs.

To import old observations from another checkout:

```sh
node scripts/import-legacy.mjs /path/to/old/events.db 250
```

## HADash Integration

HADash reads `GET /api/v1/summary` from the configured BeakPeek URL and uses it to populate the feeder tile. If the service is offline, the app falls back to Home Assistant detection events.
