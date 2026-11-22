/* Push notifications for the website/PWA (loaded into the service worker). Payload: { title, body, link }. */
self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = {};
  }
  event.waitUntil(
    self.registration.showNotification(d.title || "شيّك", {
      body: d.body || "",
      icon: "/icons/icon-192.png",
      dir: "rtl",
      lang: "ar",
      tag: d.link || "shayyek",
      renotify: true,
      data: { link: typeof d.link === "string" && d.link.startsWith("/") ? d.link : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = "/#" + ((event.notification.data && event.notification.data.link) || "/");
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && "focus" in c) {
          return c.focus().then((w) => (w && "navigate" in w ? w.navigate(url) : w));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
