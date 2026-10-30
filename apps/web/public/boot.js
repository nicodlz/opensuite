// Reload once when an application script or stylesheet fails to load (for
// example after a network change), instead of leaving a blank page. At most
// one automatic reload every ten seconds, so a lasting failure cannot loop.
(function () {
  const key = "esuno-asset-reload";
  function reload() {
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - last < 10000) return;
    sessionStorage.setItem(key, String(Date.now()));
    window.location.reload();
  }
  window.addEventListener(
    "error",
    function (event) {
      const target = event.target;
      if (
        target &&
        (target.tagName === "SCRIPT" || target.tagName === "LINK") &&
        target !== document.currentScript
      )
        reload();
    },
    true,
  );
  window.addEventListener("vite:preloadError", function (event) {
    event.preventDefault();
    reload();
  });
})();
