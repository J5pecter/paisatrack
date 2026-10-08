/*
  Push handling, imported into the Workbox-generated service worker.

  It lives here as a plain file rather than in src/ because vite-plugin-pwa is
  running in `generateSW` mode: Workbox writes sw.js itself, and the only
  supported way to add behaviour to it is `workbox.importScripts`. Converting
  the whole PWA setup to `injectManifest` to own the service worker outright
  would mean hand-maintaining the precache registration that currently works —
  a large change to the app's offline story in exchange for putting twenty
  lines somewhere tidier.

  ## The notification says nothing

  Because there is nothing to say. The push arrives with no payload at all (see
  src/lib/push/index.ts): the server knows only a date, so the only honest
  message is that *something* is due. The user taps, the app opens, and the
  local database supplies the detail that never left the device.

  `userVisibleOnly: true` was promised at subscribe time, so a notification
  must be shown for every push received. Browsers enforce this — staying silent
  gets the subscription revoked.
*/

self.addEventListener('push', (event) => {
  /*
    A bodiless push is the normal case here, but the handler reads data when it
    is present. Nothing in PaisaTrack sends a payload today; if a future
    version does, a service worker cached from this one should not ignore it.
  */
  let body = 'A payment is due soon. Open PaisaTrack to see which one.';
  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed.body === 'string') body = parsed.body;
    } catch {
      const text = event.data.text();
      if (text) body = text;
    }
  }

  event.waitUntil(
    self.registration.showNotification('PaisaTrack', {
      body,
      icon: './pwa-192x192.png',
      badge: './pwa-192x192.png',
      // One tag for all of them: two reminders on the same morning should
      // replace each other rather than stack into a wall of identical rows.
      tag: 'paisatrack-due',
      renotify: true,
      data: { url: './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = new URL(event.notification.data?.url ?? './', self.location.href).href;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        // Without this, a PWA already open in its own window is invisible here
        // and every tap opens a second copy.
        includeUncontrolled: true,
      });

      for (const client of clientList) {
        // Same-origin match rather than exact URL: the app is a SPA, so the
        // open window is almost never sitting on the start URL.
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target).catch(() => {});
          return;
        }
      }

      await self.clients.openWindow(target);
    })(),
  );
});
