import { config, ensureRuntimeDirs } from './config.mjs';
import { openDatabase } from './db.mjs';
import { EventBroadcaster, createServer } from './server.mjs';
import { BeakPeekService } from './service.mjs';
import { startMqttBridge } from './mqtt.mjs';

ensureRuntimeDirs();

const db = openDatabase(config);
const broadcaster = new EventBroadcaster();
const service = new BeakPeekService({ config, db, broadcaster });
const server = createServer({ service, broadcaster });

const mqtt = await startMqttBridge({ config, service });
if (!mqtt.enabled) console.log(`MQTT disabled: ${mqtt.reason}`);

server.listen(config.port, config.host, () => {
  console.log(`BeakPeek service listening at http://${config.host}:${config.port}`);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  broadcaster.close();
  mqtt.client?.end(true);

  const forceExit = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(0);
  }, 2000);
  forceExit.unref();

  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
  server.closeIdleConnections?.();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}
