/* The public worker is plain JavaScript; its worker globals are not in the DOM TypeScript project. */
/* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-argument, typescript/no-unsafe-return */
// Push only: no fetch handler or offline cache. Bump the filename when changing it.
const product = new URL(self.location.href).searchParams.get("product");
const app = ["mail", "calendar", "drive"].includes(product) ? product : "mail";
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
function safePath(path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32)
  )
    return "/";
  try {
    const url = new URL(path, self.location.origin);
    return url.origin === self.location.origin
      ? url.pathname + url.search + url.hash
      : "/";
  } catch {
    return "/";
  }
}
self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = {};
  }
  const icon =
    typeof data.icon === "string" &&
    data.icon.startsWith("/icons/") &&
    safePath(data.icon).startsWith("/icons/")
      ? safePath(data.icon)
      : `/icons/${app}-192.png`;
  event.waitUntil(
    self.registration.showNotification(
      typeof data.title === "string" ? data.title : "Esuno",
      {
        body: typeof data.body === "string" ? data.body : "",
        tag: typeof data.tag === "string" ? data.tag : "",
        icon,
        badge: `/icons/${app}-32.png`,
        data: { url: safePath(data.url) },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const target = new URL(path, self.location.origin).href;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing =
        windows.find((client) => client.url === target) ??
        windows.find(
          (client) => new URL(client.url).origin === self.location.origin,
        );
      if (existing) {
        if (existing.url !== target) await existing.navigate(target);
        await existing.focus();
      } else await self.clients.openWindow(target);
    })(),
  );
});
