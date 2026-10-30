// Recover from application code that fails to load (for example during a
// network change) instead of leaving a blank page.
// - Until the page has loaded, a failed same-origin script or stylesheet
//   reloads it.
// - Afterwards only a failed lazy page chunk (Vite's preload error) does, so
//   typing in a form is never interrupted by an unrelated resource.
// At most three reloads within any sliding minute, so a lasting failure
// cannot loop.
(function () {
  // Set the saved appearance before the stylesheet loads to avoid a flash.
  let theme = "light";
  try {
    const saved = localStorage.getItem("opensuite-theme");
    if (saved === "light" || saved === "dark" || saved === "system")
      theme = saved;
  } catch {
    // Storage may be unavailable; use the default appearance.
  }
  document.documentElement.dataset.theme = theme;

  const key = "esuno-asset-reload";
  let scheduled = false;
  let loaded = false;
  window.addEventListener("load", function () {
    loaded = true;
  });
  function recent(now) {
    return (sessionStorage.getItem(key) || "")
      .split(",")
      .map(Number)
      .filter(
        (time) => Number.isFinite(time) && time <= now && now - time < 60000,
      );
  }
  function reload() {
    if (scheduled) return true;
    const now = Date.now();
    const times = recent(now);
    if (times.length >= 3) return false;
    times.push(now);
    sessionStorage.setItem(key, times.join(","));
    scheduled = true;
    setTimeout(
      function () {
        window.location.reload();
      },
      500 * times.length * times.length,
    );
    return true;
  }
  function ownCode(target) {
    if (target instanceof HTMLScriptElement)
      return (
        target.src !== "" && new URL(target.src).origin === location.origin
      );
    if (target instanceof HTMLLinkElement)
      return (
        (target.relList.contains("stylesheet") ||
          target.relList.contains("modulepreload")) &&
        new URL(target.href).origin === location.origin
      );
    return false;
  }
  window.addEventListener(
    "error",
    function (event) {
      if (!loaded && ownCode(event.target)) reload();
    },
    true,
  );
  window.addEventListener("vite:preloadError", function (event) {
    if (reload()) event.preventDefault();
  });
})();
