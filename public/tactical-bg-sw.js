// Tactical PTT Background Keep-Alive Service Worker
// Menjaga sesi siaga VOX, WebSocket, dan Web Audio API tetap stabil di latar belakang saat diminimalkan atau berpindah aplikasi di HP.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

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
    } else {
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage(reply);
        });
      });
    }
  }
});
