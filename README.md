# BeakPeek Service

Standalone feeder intelligence for HADash. This replaces the old all-in-one `feeder.js` from `AuvikDashboard` with a small service that exposes a stable JSON API, stores observations in SQLite, serves event images, and can still listen to the feeder MQTT topics.

## Run

```sh
cd BeakPeekService
cp config.example.json config.json
npm install
npm start
```

The default API is `http://localhost:8787`.

## Key Endpoints

- `GET /api/v1/summary` - small payload for the tvOS dashboard.
- `GET /api/v1/events?limit=50` - latest feeder observations.
- `GET /api/v1/events/:id/image` - event image.
- `GET /api/v1/species` - species list with counts.
- `GET /api/v1/stream` - Server-Sent Events for live updates.
- `POST /api/v1/cameras/:cameraId/classify` - manually fetch and classify a camera snapshot.

## Config

The service reads `config.json` or a file pointed to by `BEAKPEEK_CONFIG`. The example config points at the old BeakPeek assets in `/Users/jake/Downloads/AuvikDashboard`, so the first pass does not need to move the TFLite model, labels, or common-name database.

Useful env overrides:

```sh
BEAKPEEK_PORT=8787
BEAKPEEK_CONFIG=/path/to/config.json
BEAKPEEK_DATA_DIR=/path/to/data
BEAKPEEK_MQTT_BROKER=mqtt://192.168.68.104:1883
```

## HADash Integration

HADash reads `GET /api/v1/summary` from the configured BeakPeek URL and uses it to populate the feeder tile. If the service is offline, the app falls back to Home Assistant detection events.
