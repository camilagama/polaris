import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHARTS_BUDGET_GZIP_BYTES,
  chartsPlacementProblems,
} from "../pwa/precache-budget";

/**
 * What the review of the charts and of the Tabs would otherwise have to remember (ADR 0103, amendment "Gráficos",
 * t285), read from the source: the files of the contract, the attribution of what was adapted from Bklit UI, the
 * loader that keeps d3 out of the shell, the colors as tokens and the chunk the build puts the charts in. The
 * markup tests are beside the components (src/ui/charts/charts.test.tsx, src/ui/tabs.test.tsx); the measured
 * ones are in e2e-pwa/ui-charts.e2e.ts.
 */
const web = fileURLToPath(new URL("..", import.meta.url));
const folder = join(web, "src/ui/charts");
const read = (path: string) => readFileSync(join(web, path), "utf8");

const SOURCE_FILE = /\.tsx?$/;
const ATTRIBUTION =
  /^\/\* adapted from Bklit UI \(bklit\/bklit-ui@3e9af3b\), MIT \*\//;
const DIRECT_IMPORT = /^import\s+(?!type\b)[^;]*from\s+["']\.\//gm;
const COMMENT = /\/\*[\s\S]*?\*\/|(?:^|\s)\/\/[^\n]*/gm;
const PALETTE_COLOR =
  /\b(?:bg|text|border|ring|outline|fill|stroke)-(?:white|black|(?:slate|gray|zinc|neutral|red|orange|amber|yellow|green|emerald|blue|indigo|violet|purple|pink)-\d+)/;
const MOVEMENT = /\b(?:translate|scale|rotate|zoom|slide)-/;
const COLOR_VALUE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/;
const TOKEN_ONLY = /^var\(--(?:chart-[1-5]|card|foreground|border)\)$/;
const SVG_COLOR_ATTRIBUTE = /\b(?:fill|stroke|stopColor)="([^"]+)"/g;
const CHART_IMPORT = /from\s+["'][^"']*\/charts\/(?!on-demand)[^"']*["']/;
const ANIMATION_CLASS = /animate-[a-z-]+/g;
const CHART_TOKEN_TYPE = /`var\(--chart-\$\{1 \| 2 \| 3 \| 4 \| 5\}\)`/;

const sources = readdirSync(folder).filter(
  (file) => SOURCE_FILE.test(file) && !file.includes(".test.")
);

describe("src/ui/charts/ (t285)", () => {
  it("has the files of the contract", () => {
    expect([...sources].sort()).toEqual([
      "area-chart.tsx",
      "chart-geometry.ts",
      "charts.ts",
      "on-demand.tsx",
      "sparkline.tsx",
      "use-element-width.ts",
    ]);
  });

  it.each(sources.filter((file) => file !== "on-demand.tsx"))(
    "%s carries the attribution of the Bklit UI it was adapted from",
    (file) => {
      expect(read(`src/ui/charts/${file}`)).toMatch(ATTRIBUTION);
    }
  );

  it("on-demand.tsx imports no chart module, only their types: the chunk stays out of the shell", () => {
    const source = read("src/ui/charts/on-demand.tsx");
    expect(source.replace(COMMENT, "").match(DIRECT_IMPORT)).toBeNull();
    expect(source).toContain('import("./charts")');
  });

  it("no chart module imports the loader, and nothing outside imports a chart module but the loader and the gallery", () => {
    for (const file of sources.filter((item) => item !== "on-demand.tsx")) {
      expect(
        read(`src/ui/charts/${file}`).replace(COMMENT, ""),
        file
      ).not.toContain("on-demand");
    }
    const outside = (directory: string): string[] =>
      readdirSync(join(web, directory), { withFileTypes: true }).flatMap(
        (entry) => {
          const path = `${directory}/${entry.name}`;
          if (entry.isDirectory()) {
            return path === "src/ui/charts" ? [] : outside(path);
          }
          return SOURCE_FILE.test(entry.name) && !entry.name.includes(".test.")
            ? [path]
            : [];
        }
      );
    const importers = outside("src").filter((path) =>
      CHART_IMPORT.test(read(path))
    );
    expect(importers).toEqual([]);
  });

  it("colors are the tokens of the chart palette, typed, and no color of its own", () => {
    expect(read("src/ui/charts/chart-geometry.ts")).toMatch(CHART_TOKEN_TYPE);
    for (const file of sources) {
      const code = read(`src/ui/charts/${file}`).replace(COMMENT, "");
      expect(code, file).not.toMatch(COLOR_VALUE);
      expect(code, file).not.toMatch(PALETTE_COLOR);
      expect(code, file).not.toMatch(MOVEMENT);
      for (const match of code.matchAll(SVG_COLOR_ATTRIBUTE)) {
        const value = match[1] as string;
        expect(
          value === "none" || TOKEN_ONLY.test(value),
          `${file}: ${match[0]}`
        ).toBe(true);
      }
    }
  });

  it("the series is drawn in the ink and the best day is the one use of the emerald", () => {
    const area = read("src/ui/charts/area-chart.tsx");
    expect(area).toContain('color = "var(--chart-5)"');
    expect(area).toContain('fill="var(--chart-1)"');
    expect(read("src/ui/charts/sparkline.tsx")).not.toContain("--chart-1");
  });

  it("moves only the opacity: the fade of the page and no animation of its own", () => {
    for (const file of sources.filter((item) => item.endsWith(".tsx"))) {
      const code = read(`src/ui/charts/${file}`).replace(COMMENT, "");
      expect(code, file).not.toContain("<animate");
      expect(code, file).not.toContain("transition");
      expect(code.match(ANIMATION_CLASS) ?? [], file).toSatisfy(
        (names: string[]) => names.every((name) => name === "animate-rise")
      );
    }
  });
});

describe("src/ui/tabs.tsx (t285)", () => {
  const source = read("src/ui/tabs.tsx").replace(COMMENT, "");

  it("is the Base UI Tabs, once, with the three rules of the project", () => {
    expect(source).toContain('from "@base-ui/react/tabs"');
    expect(source).toContain("h-ctl-md");
    expect(source).toContain("touch-hit");
    expect(source).toContain("focus-ring");
  });

  it("uses the tokens only and has no transition of movement", () => {
    expect(source).not.toMatch(PALETTE_COLOR);
    expect(source).not.toMatch(COLOR_VALUE);
    expect(source).not.toContain("transition-all");
    expect(source).not.toMatch(MOVEMENT);
  });
});

describe("the charts chunk of the build (t285)", () => {
  const ids = {
    area: "/repo/apps/web/src/ui/charts/area-chart.tsx",
    d3: "/repo/node_modules/.bun/d3-shape@3.2.0/node_modules/d3-shape/src/index.js",
    d3Windows:
      "D:\\repo\\node_modules\\.bun\\d3-path@3.1.0\\node_modules\\d3-path\\src\\index.js",
    loader: "/repo/apps/web/src/ui/charts/on-demand.tsx",
    sparkWindows: "D:\\repo\\apps\\web\\src\\ui\\charts\\sparkline.tsx",
    screen: "/repo/apps/web/src/sales/sale-page.tsx",
  };
  it("the guard accepts the charts in their chunk and the loader anywhere", () => {
    expect(
      chartsPlacementProblems([
        {
          fileName: "assets/charts-Dk3jf9.js",
          modules: {
            [ids.area]: { renderedLength: 1 },
            [ids.d3]: { renderedLength: 1 },
          },
        },
        {
          fileName: "assets/index-abc.js",
          modules: {
            [ids.loader]: { renderedLength: 1 },
            [ids.screen]: { renderedLength: 1 },
          },
        },
      ])
    ).toEqual([]);
  });

  it("the guard fails when a chart module or d3 is in another chunk (a static import from a screen)", () => {
    const problems = chartsPlacementProblems([
      {
        fileName: "assets/index-abc.js",
        modules: {
          [ids.area]: { renderedLength: 1 },
          [ids.d3Windows]: { renderedLength: 1 },
          [ids.sparkWindows]: { renderedLength: 1 },
          [ids.screen]: { renderedLength: 1 },
        },
      },
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("area-chart.tsx");
    expect(problems[0]).toContain("assets/index-abc.js");
    expect(problems[1]).toContain("d3-path");
    expect(problems[2]).toContain("sparkline.tsx");
  });

  it("has a budget of 8 KB gzip", () => {
    expect(CHARTS_BUDGET_GZIP_BYTES).toBe(8000);
  });
});
