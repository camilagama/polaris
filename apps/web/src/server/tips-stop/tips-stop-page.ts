import { pageTokens } from "./page-tokens.generated";

/**
 * The page that stops the tips e-mails, as the Worker answers it: HTML with no script, no image and no link that
 * leaves the app, one native form (`method="post"` and no `action`, so it posts to the URL that carries the token)
 * and one style block allowed by its hash. The card copies the entry screens (`EntryScreen`, 380 px, the brand,
 * the title and one line under it); the theme is the system's, since no script reads the one chosen in the app.
 * Every text is a constant: nothing of the request (the token, the person) is ever written into the page.
 */

export const TIPS_STOP_TEXTS = {
  confirmButton: "Parar de receber",
  confirmSupport:
    "Você deixa de receber os e-mails “Dicas para começar”. Os avisos da sua conta e da cobrança continuam.",
  confirmTitle: "Parar de receber as dicas?",
  doneLink: "Abrir o Polaris",
  doneSupport:
    "Se mudar de ideia, ligue de novo em Configurações › Seus dados.",
  doneTitle: "Pronto. Você não recebe mais as dicas.",
  invalidTitle: "Não foi possível abrir este link.",
  rateLimitedTitle: "Muitos pedidos. Espere alguns minutos.",
  unavailableSupport: "Tente de novo em alguns minutos.",
  unavailableTitle: "Não foi possível concluir agora.",
} as const;

export type TipsStopPageState =
  | "confirm"
  | "done"
  | "invalid"
  | "rate_limited"
  | "unavailable";

/*
 * The card of `EntryScreen` in plain CSS, in rem so a larger browser font grows it: the gutter of 1.5rem, 2rem
 * above (6rem from 48rem up), at most 23.75rem wide; the card spacing of 0.75rem (1rem from 48rem up) plus the
 * 0.25rem of its content; the ink button and the outline one at 2.75rem (44 px) high, which a phone and a mouse
 * both get here, since the page has one action.
 */
const PAGE_RULES = `
*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: light dark; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100dvh;
  background: var(--background);
  color: var(--foreground);
  font-family: "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 0.875rem;
  line-height: 1.25rem;
  -webkit-font-smoothing: antialiased;
}
main { display: grid; min-height: 100dvh; place-items: start; padding: 2rem 1.5rem; }
.frame { width: 100%; min-width: 0; max-width: 23.75rem; margin-inline: auto; }
.card {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 0.75rem;
  border-radius: 0.875rem;
  background: var(--card);
  box-shadow: var(--shadow-xs), inset 0 1px 0 var(--card-glow), 0 0 0 1px var(--card-ring);
  overflow-wrap: anywhere;
}
.brand {
  display: flex;
  width: fit-content;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.025em;
}
.brand svg { width: 1.5rem; height: 1.5rem; flex: none; }
.brand .stem { fill: currentColor; }
.brand .dot { fill: var(--mark); }
.heading { display: grid; gap: 0.25rem; }
h1 {
  margin: 0;
  font-size: 1.0625rem;
  line-height: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.011em;
  text-wrap: balance;
}
.support { margin: 0; color: var(--muted-foreground); font-size: 0.8125rem; line-height: 1.125rem; text-wrap: pretty; }
form { margin: 0; }
.action {
  display: flex;
  width: 100%;
  min-height: 2.75rem;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  border-radius: 0.55rem;
  font: inherit;
  font-weight: 500;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
}
.action:focus-visible { outline: 3px solid var(--ring); outline-offset: 2px; }
.primary {
  background: var(--primary);
  color: var(--primary-foreground);
  box-shadow: inset 0 1px 0 var(--btn-shine), 0 1px 2px var(--btn-drop);
}
.primary:hover { background: color-mix(in oklch, var(--primary) 88%, transparent); }
.outline { border-color: var(--border); background: var(--card); color: var(--foreground); box-shadow: var(--shadow-xs); }
.outline:hover { background: var(--accent); }
@media (min-width: 48rem) {
  main { padding-top: 6rem; }
  .card { padding: 1.25rem 1rem; }
}
@media (prefers-color-scheme: dark) {
  .outline { background: color-mix(in oklch, var(--secondary) 60%, transparent); }
  .outline:hover { background: var(--accent); }
}
`;

/** The one style block of the page, whose hash is the only style the policy of the page allows. */
const TIPS_STOP_STYLE = `${pageTokens}${PAGE_RULES}`;

let styleHash: Promise<string> | undefined;

/** `sha256-…` of the style block, as `style-src` names it; computed once per isolate. */
export function tipsStopStyleHash(): Promise<string> {
  styleHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(TIPS_STOP_STYLE))
    .then((digest) => {
      let binary = "";
      for (const byte of new Uint8Array(digest)) {
        binary += String.fromCharCode(byte);
      }
      return `sha256-${btoa(binary)}`;
    });
  return styleHash;
}

const BRAND = `<p class="brand"><svg aria-hidden="true" viewBox="0 0 24 24"><rect class="stem" height="13" rx="1.2" width="2.4" x="10.8" y="9.2"></rect><circle class="dot" cx="12" cy="4.4" r="2.7"></circle></svg><span>Polaris</span></p>`;

function heading(title: string, support?: string): string {
  const line = support === undefined ? "" : `<p class="support">${support}</p>`;
  return `<div class="heading"><h1>${title}</h1>${line}</div>`;
}

function cardOf(state: TipsStopPageState): { body: string; title: string } {
  const texts = TIPS_STOP_TEXTS;
  switch (state) {
    case "confirm":
      return {
        body: `${heading(texts.confirmTitle, texts.confirmSupport)}<form method="post"><input name="List-Unsubscribe" type="hidden" value="One-Click"><button class="action primary" type="submit">${texts.confirmButton}</button></form>`,
        title: texts.confirmTitle,
      };
    case "done":
      return {
        body: `${heading(texts.doneTitle, texts.doneSupport)}<a class="action outline" href="/">${texts.doneLink}</a>`,
        title: texts.doneTitle,
      };
    case "invalid":
      return { body: heading(texts.invalidTitle), title: texts.invalidTitle };
    case "rate_limited":
      return {
        body: `<div role="status">${heading(texts.rateLimitedTitle)}</div>`,
        title: texts.rateLimitedTitle,
      };
    default:
      return {
        body: heading(texts.unavailableTitle, texts.unavailableSupport),
        title: texts.unavailableTitle,
      };
  }
}

/** The whole document of one state. */
export function renderTipsStopPage(state: TipsStopPageState): string {
  const { body, title } = cardOf(state);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${title} · Polaris</title>
<style>${TIPS_STOP_STYLE}</style>
</head>
<body>
<main id="conteudo"><div class="frame"><div class="card">${BRAND}${body}</div></div></main>
</body>
</html>
`;
}
