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

  if (topics.length === 0) return { enabled: false, reason: 'No MQTT topics configured' };

  const client = mqtt.connect(config.mqtt.broker);
  client.on('connect', () => {
    for (const [topic] of topics) client.subscribe(topic);
    console.log(`MQTT connected: ${topics.length} feeder topics`);
  });

  client.on('message', (topic, message) => {
    const payload = message.toString().toLowerCase();
    if (!payload.includes('animal') && !payload.includes('bird') && !payload.includes('motion')) return;

    const cameraId = config.mqtt.topics[topic];
    service.classifyCamera(cameraId, { source: 'mqtt' }).catch(error => {
      console.error(`[${cameraId}] classification failed:`, error.message);
    });
  });

  client.on('error', error => {
    console.error('MQTT error:', error.message);
  });

  return { enabled: true, client };
}
