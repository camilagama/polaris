"use strict";
// The puppeteerScript of lighthouserc.json: Lighthouse calls it once per URL, before the runs of that URL, with the
// browser it will measure in. For the Início it signs in against the fake server (which then answers the session and
// the reads with the fixtures of the e2e-pwa) and proves the page draws the figures, so a run never measures the
// redirect to /entrar or an empty shell. The other pages need no session.
module.exports = async (browser, { url }) => {
  const { origin, pathname } = new URL(url);
  if (pathname !== "/") {
    return;
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/entrar`);
    const status = await page.evaluate(
      async () =>
        (await fetch("/__lighthouse/login", { method: "POST" })).status
    );
    if (status !== 204) {
      throw new Error(`The fake server refused the sign-in (${status}).`);
    }
    await page.goto(url);
    await page.waitForFunction(
      () =>
        document.querySelector("h1")?.textContent === "Início" &&
        document.body.textContent.includes("Camiseta básica"),
      { timeout: 30_000 }
    );
  } finally {
    await page.close();
  }
};
