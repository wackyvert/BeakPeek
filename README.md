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

## Run at Boot with systemd

On the Linux host that should keep BeakPeek running:

```sh
cd BeakPeekService
cp config.example.json config.json
npm install
npm run setup:python
./scripts/install-systemd-service.sh
```

The installer writes `/etc/systemd/system/beakpeek.service`, enables it, and starts it immediately. It uses the current checkout path, the current user, and the `node` binary found on your `PATH`.

If Node was installed through a shell-only tool such as `nvm`, pass its absolute path:

```sh
BEAKPEEK_NODE=/home/jake/.nvm/versions/node/v22.5.0/bin/node ./scripts/install-systemd-service.sh
```

Useful service commands:

```sh
systemctl status beakpeek.service
journalctl -u beakpeek.service -f
sudo systemctl restart beakpeek.service
sudo systemctl disable --now beakpeek.service
```

After startup, confirm the API responds:

```sh
curl http://localhost:8787/api/v1/summary
```

A hand-editable unit template is also available at `systemd/beakpeek.service.example`.

## Automatic GitHub Updates

BeakPeek can also install a systemd timer that periodically checks GitHub, fast-forwards the current branch, installs dependency changes when needed, and restarts `beakpeek.service` only after a successful update.

```sh
cd BeakPeekService
./scripts/install-systemd-updater.sh
```

By default, it checks `origin/main` every 15 minutes with a small randomized delay. It skips updates when tracked local files have been modified or when GitHub is not a fast-forward from the local checkout.

If Node was installed through `nvm`, pass absolute paths the same way as the service installer:

```sh
BEAKPEEK_NODE=/home/jake/.nvm/versions/node/v22.5.0/bin/node \
BEAKPEEK_NPM=/home/jake/.nvm/versions/node/v22.5.0/bin/npm \
./scripts/install-systemd-updater.sh
```

Useful updater commands:

```sh
systemctl list-timers beakpeek-update.timer
journalctl -u beakpeek-update.service -f
sudo systemctl start beakpeek-update.service
sudo systemctl disable --now beakpeek-update.timer
```

You can change the interval at install time:

```sh
BEAKPEEK_UPDATE_INTERVAL=1h ./scripts/install-systemd-updater.sh
```

Hand-editable unit templates are available at `systemd/beakpeek-update.service.example` and `systemd/beakpeek-update.timer.example`.

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
- `POST /api/v1/test/classify-image` - upload a local image, classify it, store the event, and log the result.

Test the full MQTT-style route without waiting for a feeder event:

```sh
curl -X POST http://localhost:8787/api/v1/test/detection \
  -H 'content-type: application/json' \
  -d '{"topic":"birdfeeder4/ObjectDetector"}'
```

Classify a local photo upload:

```sh
curl -X POST http://localhost:8787/api/v1/test/classify-image \
  -F cameraId=140 \
  -F image=@/path/to/photo.jpg
```

To test a specific Scrypted-style crop box:

```sh
curl -X POST http://localhost:8787/api/v1/test/classify-image \
  -F cameraId=140 \
  -F box=1039,1351,592,592 \
  -F image=@/path/to/photo.jpg
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
BEAKPEEK_CROP_IMAGES=true
BEAKPEEK_CROP_ASPECT=1:1
BEAKPEEK_SNAPSHOT_ALLOW_INSECURE_TLS=true
BEAKPEEK_SNAPSHOT_FETCH_ATTEMPTS=3
BEAKPEEK_SNAPSHOT_RETRY_DELAY_MS=1500
BEAKPEEK_MQTT_BROKER=mqtt://192.168.68.104:1883
BEAKPEEK_HA_URL=http://homeassistant.local:8123
BEAKPEEK_HA_TOKEN=your_long_lived_access_token
BEAKPEEK_HA_NOTIFY_SERVICE=mobile_app_your_iphone
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

Event images are smart-cropped by default before classification and storage, so the model and UI both use the same bird-focused frame. Set `"cropImages": false` or `BEAKPEEK_CROP_IMAGES=false` to keep original frames.

## Home Assistant Notifications

BeakPeek can send reliable background phone notifications through Home Assistant Companion App. Configure `homeAssistant` in `config.json` or the `BEAKPEEK_HA_*` env vars above, then use the iOS client's Notify tab to choose all visitors or specific species. The service stores those rules locally and calls Home Assistant as soon as a matching classification event is saved.

The notify service is the Home Assistant service name after `notify.`, for example `mobile_app_your_iphone`.

To import old observations from another checkout:

```sh
node scripts/import-legacy.mjs /path/to/old/events.db 250
```

## HADash Integration

HADash reads `GET /api/v1/summary` from the configured BeakPeek URL and uses it to populate the feeder tile. If the service is offline, the app falls back to Home Assistant detection events.
