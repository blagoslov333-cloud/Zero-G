/* 0G Service Worker: zero-secret Web Push alerts + ?tab=inbox click routing */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "0G — Action Needed",
    body: "An agent requires your attention in Inbox.",
    tag: "0g-inbox",
    url: "/?tab=inbox",
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = {
        title: typeof parsed.title === "string" ? parsed.title : payload.title,
        body: typeof parsed.body === "string" ? parsed.body : payload.body,
        tag: typeof parsed.tag === "string" ? parsed.tag : payload.tag,
        url: typeof parsed.url === "string" ? parsed.url : "/?tab=inbox",
      };
    } catch {
      const text = event.data.text();
      if (text) {
        payload.body = text;
      }
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icon.svg",
      badge: "/icon.svg",
      renotify: true,
      requireInteraction: true,
      data: { url: payload.url || "/?tab=inbox" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl =
    (event.notification.data && event.notification.data.url) || "/?tab=inbox";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            const url = new URL(client.url);
            url.searchParams.set("tab", "inbox");
            if ("navigate" in client) {
              return client.navigate(url.toString()).then((c) => (c ? c.focus() : client.focus()));
            }
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
    return;
  }
});
