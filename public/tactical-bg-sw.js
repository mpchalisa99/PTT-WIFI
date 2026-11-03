// Tactical PTT Background Keep-Alive Service Worker (Passive non-claiming mode)
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'KEEP_ALIVE_PING') {
    const reply = {
      type: 'KEEP_ALIVE_ACK',
      timestamp: Date.now(),
      callsign: data.callsign || 'UNIT',
      channel: data.channel || 12,
      minimized: Boolean(data.minimized),
    };

    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(reply);
    }
  }
});

