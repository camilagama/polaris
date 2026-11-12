// The app's entry module that never ran leaves an empty, dark page with no message: the browser fires `error` on the
// module <script> when any file of its static graph fails to download, and nothing of the app is there to answer.
// It happens when the service worker answering the page's files goes away while they load (its registration
// removed, as clearing the site data does), which kills every fetch it still had in hand. A new load asks the files
// again, from the network or from a worker that is there, so the page reloads itself once. The mark it leaves in the
// tab stops a second reload until a load gets through (any time later: a slow failure cannot loop either), and
// offline a reload would only trade the empty page for the browser's error page. An external file, before the
// module, because the CSP of the shell runs no inline script.
(() => {
  const MARK = "polaris:entry-reload";
  let failed = false;
  const storage = () => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  };
  const reloadOnce = () => {
    const tab = storage();
    if (!tab || window.navigator.onLine === false) {
      return;
    }
    try {
      if (tab.getItem(MARK) !== null) {
        return;
      }
      tab.setItem(MARK, "1");
    } catch {
      return;
    }
    window.location.reload();
  };
  window.addEventListener(
    "error",
    ({ target }) => {
      if (
        target instanceof HTMLScriptElement &&
        target.type === "module" &&
        target.src.startsWith(`${window.location.origin}/assets/`)
      ) {
        failed = true;
        reloadOnce();
      }
    },
    true
  );
  window.addEventListener("load", () => {
    if (!failed) {
      try {
        storage()?.removeItem(MARK);
      } catch {
        // a storage that refuses leaves the mark: no reload is the safe side
      }
    }
  });
})();
