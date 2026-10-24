import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../public/manifest.webmanifest", import.meta.url)
    ),
    "utf8"
  )
) as Record<string, unknown>;

describe("manifest of the installed app", () => {
  it("opens the Início: start, scope and id stay at the root (AC-1)", () => {
    expect(manifest).toMatchObject({ id: "/", scope: "/", start_url: "/" });
  });

  it("offers the shortcut Nova venda to /sales, and a description that promises nothing offline", () => {
    expect(manifest.shortcuts).toEqual([
      {
        icons: [
          { sizes: "192x192", src: "/icons/icon-192.png", type: "image/png" },
        ],
        name: "Nova venda",
        short_name: "Vender",
        url: "/sales",
      },
    ]);
    expect(manifest.description).toBe(
      "Vendas, estoque e resultado da sua loja."
    );
  });
});
