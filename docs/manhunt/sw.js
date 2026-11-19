/* Traque : service worker. Il affiche les notifications envoyées par notre relais (Web Push),
   même quand l'appli est fermée. Aucun cache : la page est toujours à jour. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Traque', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const ua = self.navigator.userAgent;
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|Android|Edg/.test(ua);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Appli déjà à l'écran : elle affiche ses propres alertes, pas besoin de notification
    // (sauf Safari, qui exige d'en afficher une pour chaque message, et le message de test).
    if (!safari && d.tag !== 'test' && wins.some((w) => w.visibilityState === 'visible')) return;
    await self.registration.showNotification(d.title || 'Traque', {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: './' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || './');
  }));
});
