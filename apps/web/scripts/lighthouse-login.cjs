"use strict";
// The puppeteerScript of lighthouserc.json: Lighthouse calls it once per URL, before the runs of that URL, with the
// browser it will measure in. It proves each page draws the state the run is meant to measure, so a run never measures
// an error page, the redirect to /entrar or an empty shell. For the Início it first signs in against the fake server,
// which then answers the session and the reads with the fixtures of the e2e-pwa.
const READY = {
  "/": () =>
    document.querySelector("h1")?.textContent === "Início" &&
    document.body.textContent.includes("Camiseta básica"),
  "/entrar": () => document.body.textContent.includes("Continuar com o Google"),
  "/loja-horizonte": () =>
    document.querySelector("main h1")?.textContent === "Loja Horizonte",
};

module.exports = async (browser, { url }) => {
  const { origin, pathname } = new URL(url);
  const ready = READY[pathname];
  if (!ready) {
    throw new Error(
      `No readiness check for ${pathname} in lighthouse-login.cjs.`
    );
  }
  const page = await browser.newPage();
  try {
    if (pathname === "/") {
      await page.goto(`${origin}/entrar`);
      const status = await page.evaluate(
        async () =>
          (await fetch("/__lighthouse/login", { method: "POST" })).status
      );
      if (status !== 204) {
        throw new Error(`The fake server refused the sign-in (${status}).`);
      }
    }
    await page.goto(url);
    await page.waitForFunction(ready, { timeout: 30_000 });
  } finally {
    await page.close();
  }
};
