// The theme before the first paint (ADR 0103): only the `dark` class on <html>. An external file, because
// the CSP of the shell runs no inline script. The same closed list as src/lib/theme.ts (theme.test.ts
// runs this file against it): "escuro", or "sistema"/nothing/anything else following the system.
(() => {
  let dark = false;
  try {
    const theme = window.localStorage.getItem("polaris-tema");
    dark =
      theme === "escuro" ||
      (theme !== "claro" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch {
    dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  document.documentElement.classList.toggle("dark", dark);
})();
