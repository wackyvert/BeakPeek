export function hasAnimalDetection(message) {
  try {
    const payload = JSON.parse(message.toString());
    if (!Array.isArray(payload.detections)) return false;
    return payload.detections.some(detection => detection?.className === 'animal');
  } catch {
    return false;
  }
}

export function animalCropBox(message) {
  try {
    const payload = JSON.parse(message.toString());
    if (!Array.isArray(payload.detections)) return null;

    const detections = payload.detections
      .filter(detection => detection?.className === 'animal' && Array.isArray(detection.boundingBox))
      .map(detection => ({
        box: detection.boundingBox.slice(0, 4).map(Number),
        score: Number(detection.score ?? 0),
      }))
      .filter(detection => detection.box.every(Number.isFinite));

    detections.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      return (b.box[2] * b.box[3]) - (a.box[2] * a.box[3]);
    });
    return detections[0]?.box ?? null;
  } catch {
    return null;
  }
}

export function topicCameraMap(config) {
  return new Map(
    Object.entries(config.mqtt.topics)
      .filter(([topic, cameraId]) => topic && topic !== 'undefined' && cameraId),
  );
}

export async function handleDetectionMessage({ config, service, topic, message, source = 'mqtt', delay }) {
  if (!hasAnimalDetection(message)) return { skipped: true, reason: 'not_animal', topic };

  const cameraId = topicCameraMap(config).get(topic);
  if (!cameraId) return { skipped: true, reason: 'unmapped_topic', topic };

  return await service.classifyCamera(cameraId, { source, delay, cropBox: animalCropBox(message) });
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

  const topics = [...topicCameraMap(config).entries()];

  if (topics.length === 0) return { enabled: false, reason: 'No MQTT topics configured' };

  const client = mqtt.connect(config.mqtt.broker);
  client.on('connect', () => {
    for (const [topic] of topics) client.subscribe(topic);
    console.log(`MQTT connected: ${topics.length} feeder topics`);
  });

  client.on('message', (topic, message) => {
    handleDetectionMessage({ config, service, topic, message }).then(result => {
      if (result.skipped && result.reason === 'unmapped_topic') {
        console.warn(`[mqtt] ignored detection without camera mapping on ${topic}`);
      }
    }).catch(error => {
      const cameraId = topicCameraMap(config).get(topic) ?? topic;
      console.error(`[${cameraId}] classification failed:`, error.message);
    });
  });

  client.on('error', error => {
    console.error('MQTT error:', error.message);
  });

  return { enabled: true, client };
}
