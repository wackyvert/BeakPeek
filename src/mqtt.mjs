function parsePayload(message) {
  const text = message.toString();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function detectionText(payload) {
  return payload.text.toLowerCase();
}

function cameraIdFromPayload(value) {
  if (!value || typeof value !== 'object') return null;

  for (const [key, field] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (['cameraid', 'camera'].includes(normalized) && field != null && typeof field !== 'object') {
      return String(field);
    }
    if (['camera', 'source', 'device'].includes(normalized) && field && typeof field === 'object') {
      const nested = cameraIdFromPayload(field);
      if (nested) return nested;
      if (field.id != null) return String(field.id);
    }
  }

  for (const field of Object.values(value)) {
    if (Array.isArray(field)) {
      for (const item of field) {
        const nested = cameraIdFromPayload(item);
        if (nested) return nested;
      }
      continue;
    }
    const nested = cameraIdFromPayload(field);
    if (nested) return nested;
  }

  return null;
}

export async function startMqttBridge({ config, service }) {
  if (!config.mqtt.broker) {
    return { enabled: false, reason: 'No MQTT broker configured' };
  }

  let mqtt;
  try {
    mqtt = await import('mqtt');
  } catch {
    return { enabled: false, reason: 'Install optional dependency "mqtt" to enable MQTT' };
  }

  const topics = Object.entries(config.mqtt.topics)
    .filter(([topic, cameraId]) => topic && topic !== 'undefined' && cameraId);
  const topicCameraIds = new Map(topics);
  const knownCameraIds = new Set(topics.map(([, cameraId]) => String(cameraId)));

  if (topics.length === 0) return { enabled: false, reason: 'No MQTT topics configured' };

  const client = mqtt.connect(config.mqtt.broker);
  client.on('connect', () => {
    for (const [topic] of topics) client.subscribe(topic);
    console.log(`MQTT connected: ${topics.length} feeder topics`);
  });

  client.on('message', (topic, message) => {
    const payload = parsePayload(message);
    const text = detectionText(payload);
    if (!text.includes('animal') && !text.includes('bird') && !text.includes('motion')) return;

    const payloadCameraId = cameraIdFromPayload(payload.json);
    const cameraId = payloadCameraId && knownCameraIds.has(payloadCameraId)
      ? payloadCameraId
      : topicCameraIds.get(topic);

    if (!cameraId) {
      console.warn(`[mqtt] ignored detection without camera mapping on ${topic}`);
      return;
    }

    service.classifyCamera(cameraId, { source: 'mqtt' }).catch(error => {
      console.error(`[${cameraId}] classification failed:`, error.message);
    });
  });

  client.on('error', error => {
    console.error('MQTT error:', error.message);
  });

  return { enabled: true, client };
}
