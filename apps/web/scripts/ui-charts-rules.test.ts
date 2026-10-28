import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHARTS_BUDGET_GZIP_BYTES,
  chartsPlacementProblems,
  HEATMAP_BUDGET_GZIP_BYTES,
  isSharedChartModule,
} from "../pwa/precache-budget";

/**
 * What the review of the charts and of the Tabs would otherwise have to remember (ADR 0103, amendment "Gráficos"),
 * read from the source: the files of the contract, the attribution of what was adapted from Bklit UI, the
 * loader that keeps d3 out of the shell, the colors as tokens and the chunk the build puts the charts in. The
 * markup tests are beside the components (src/ui/charts/charts.test.tsx, src/ui/tabs.test.tsx); the measured
 * ones are in e2e-pwa/ui-charts.e2e.ts.
 */
const web = fileURLToPath(new URL("..", import.meta.url));
const folder = join(web, "src/ui/charts");
const bklitFolder = join(web, "src/ui/bklit/charts");
const read = (path: string) => readFileSync(join(web, path), "utf8");

const SOURCE_FILE = /\.tsx?$/;
const ATTRIBUTION = /^\/\* Polaris adaptation of .*Bklit UI .*MIT \*\//;
const DIRECT_IMPORT = /^import\s+(?!type\b)[^;]*from\s+["']\.\//gm;
const COMMENT = /\/\*[\s\S]*?\*\/|(?:^|\s)\/\/[^\n]*/gm;
const TS_SOURCE = /\.tsx?$/;
// `useReducedMotion` imported as itself, not as the alias of `useReducedMotionConfig`
const BARE_REDUCED_MOTION = /(?<!as )\buseReducedMotion\b(?=\s*[,}])/;
const PALETTE_COLOR =
  /\b(?:bg|text|border|ring|outline|fill|stroke)-(?:white|black|(?:slate|gray|zinc|neutral|red|orange|amber|yellow|green|emerald|blue|indigo|violet|purple|pink)-\d+)/;
const MOVEMENT = /\b(?:translate|scale|rotate|zoom|slide)-/;
const COLOR_VALUE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/;
const TOKEN_ONLY =
  /^var\(--(?:chart-(?:[1-5]|sales|result|ticket|context|unknown)|card|foreground|border|destructive)\)$/;
const SVG_COLOR_ATTRIBUTE = /\b(?:fill|stroke|stopColor)="([^"]+)"/g;
const CHART_IMPORT =
  /from\s+["'][^"']*\/(?:charts\/(?!on-demand)|bklit\/)[^"']*["']/;

const sources = readdirSync(folder).filter(
  (file) => SOURCE_FILE.test(file) && !file.includes(".test.")
);
/** Every source file of the blocks of Bklit UI, by path under `src/ui/bklit/`. */
const bklitSources = [
  "shimmering-text.tsx",
  ...readdirSync(bklitFolder, { recursive: true, encoding: "utf8" })
    .filter((file) => SOURCE_FILE.test(file))
    .map((file) => `charts/${file}`),
];

describe("src/ui/charts/ and src/ui/bklit/ (t285, t336)", () => {
  it("has the files of the contract", () => {
    expect([...sources].sort()).toEqual([
      "area-chart.tsx",
      "chart-bridge.tsx",
      "chart-data.ts",
      "chart-gaps.tsx",
      "chart-text.tsx",
      "charts.ts",
      "heatmap.ts",
      "on-demand.tsx",
      "ring-chart.tsx",
      "sales-heatmap.tsx",
      "sparkline.tsx",
      "weekday-bars.tsx",
    ]);
  });

  it("keeps the blocks of Bklit UI in their own folder, with the record of where they came from and what was changed", () => {
    expect(readdirSync(bklitFolder)).toEqual(
      expect.arrayContaining([
        "area-chart.tsx",
        "area.tsx",
        "grid.tsx",
        "ring-chart.tsx",
        "ring.tsx",
        "sparkline.tsx",
        "x-axis.tsx",
        "y-axis.tsx",
        "tooltip",
      ])
    );
    const record = read("src/ui/bklit/BKLIT-UI.md");
    expect(record).toContain("MIT");
    expect(record).toContain("https://ui.bklit.com/r/{name}.json");
    for (const adaptation of [
      "theme.css",
      "pt-BR",
      "date-ticker.tsx",
      "exactOptionalPropertyTypes",
      "y-axis.tsx",
    ]) {
      expect(record, adaptation).toContain(adaptation);
    }
  });

  it.each(sources.filter((file) => file !== "on-demand.tsx"))(
    "%s carries the notice of what it was adapted from",
    (file) => {
      expect(read(`src/ui/charts/${file}`)).toMatch(ATTRIBUTION);
    }
  );

  it("on-demand.tsx imports no chart module, only their types: the chunk stays out of the shell", () => {
    const source = read("src/ui/charts/on-demand.tsx");
    expect(source.replace(COMMENT, "").match(DIRECT_IMPORT)).toBeNull();
    expect(source).toContain('import("./charts")');
    expect(source).toContain('import("./heatmap")');
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
            return path === "src/ui/charts" || path === "src/ui/bklit"
              ? []
              : outside(path);
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

  it("colors are tokens: none written in the code of Polaris nor in the blocks of Bklit UI", () => {
    for (const file of bklitSources) {
      const code = read(`src/ui/bklit/${file}`).replace(COMMENT, "");
      expect(code, file).not.toMatch(COLOR_VALUE);
      expect(code, file).not.toMatch(PALETTE_COLOR);
    }
    for (const file of sources) {
      const code = read(`src/ui/charts/${file}`).replace(COMMENT, "");
      expect(code, file).not.toMatch(COLOR_VALUE);
      expect(code, file).not.toMatch(PALETTE_COLOR);
      for (const match of code.matchAll(SVG_COLOR_ATTRIBUTE)) {
        const value = match[1] as string;
        expect(
          value === "none" || TOKEN_ONLY.test(value),
          `${file}: ${match[0]}`
        ).toBe(true);
      }
    }
  });

  it("the variables of the blocks are mapped once, to the tokens, in the sheet of the theme", () => {
    const theme = read("src/styles/theme.css");
    for (const [variable, token] of [
      ["--chart-line-primary", "var(--chart-5)"],
      ["--chart-line-secondary", "var(--chart-3)"],
      ["--chart-grid", "var(--border)"],
      ["--chart-tooltip-background", "var(--card)"],
    ]) {
      expect(theme, variable).toContain(`${variable}: ${token};`);
    }
    expect(theme).toContain(
      "--chart-crosshair: color-mix(in oklab, var(--foreground) 35%, transparent);"
    );
  });

  it("a series is the ink unless its entity has a color; the best day is marked by its shape, not by the emerald (v7)", () => {
    expect(read("src/ui/charts/area-chart.tsx")).toContain(
      'const INK: ChartColor = "var(--chart-5)"'
    );
    for (const file of [
      "src/ui/charts/area-chart.tsx",
      "src/ui/charts/chart-bridge.tsx",
      "src/ui/charts/ring-chart.tsx",
      "src/ui/charts/sparkline.tsx",
    ]) {
      expect(read(file), file).not.toContain("--chart-1");
    }
    // the ring of the best day is larger than the others, in the color of the series
    expect(read("src/ui/charts/chart-bridge.tsx")).toContain(
      "r={mark.index === best ? 5.5 : 3.5}"
    );
    const theme = read("src/styles/theme.css");
    for (const token of [
      "--chart-sales",
      "--chart-result",
      "--chart-ticket",
      "--chart-context",
      "--chart-unknown",
      "--chart-heat-1",
      "--chart-heat-4",
    ]) {
      // once in the light theme and once in the dark one
      expect(theme.split(`${token}: oklch(`).length - 1, token).toBe(2);
    }
  });

  it("keeps the animation of the blocks at the full level and turns all of it off on a phone and under prefers-reduced-motion (t386)", () => {
    const area = read("src/ui/charts/area-chart.tsx").replace(COMMENT, "");
    expect(area).toContain('useMotionLevel() !== "full"');
    for (const off of [
      "animate: false",
      "animationDuration: 0",
      "damping: 0",
      'reducedMotion: "always"',
      "yDomainTween: false",
    ]) {
      expect(area, off).toContain(off);
    }
    // and the defaults of the blocks otherwise: the reveal of 1 100 ms and the spring of the panel at 20
    expect(area).toContain("animationDuration: 1100");
    expect(area).toContain("damping: 20");
    expect(area).toContain(
      "<MotionConfig reducedMotion={motion.reducedMotion}>"
    );
    const sparkline = read("src/ui/charts/sparkline.tsx");
    expect(sparkline).toContain('useMotionLevel() !== "full"');
    expect(sparkline).toContain("animate={!still}");
    expect(sparkline).toContain(
      '<MotionConfig reducedMotion={still ? "always" : "user"}>'
    );
    // the ring of the goal: drawn finished, with no entrance, below the full level
    const ring = read("src/ui/charts/ring-chart.tsx");
    expect(ring).toContain('useMotionLevel() !== "full"');
    expect(ring).toContain("animate={!still}");
    expect(ring).toContain(
      '<MotionConfig reducedMotion={still ? "always" : "user"}>'
    );
  });

  it("the ring of Bklit UI comes without its center: no ChartStatFlow and no @number-flow/react (v7 § 7, pacote E)", () => {
    const files = readdirSync(bklitFolder);
    expect(files).not.toContain("ring-center.tsx");
    expect(files).not.toContain("chart-stat-flow.tsx");
    for (const file of bklitSources) {
      expect(read(`src/ui/bklit/${file}`), file).not.toContain("number-flow");
    }
    // the ring draws its `<g>` itself; the map of the Início uses the `Group` of the package, now in the list
    for (const file of ["ring-chart.tsx", "ring.tsx", "ring-context.tsx"]) {
      expect(read(`src/ui/bklit/charts/${file}`), file).not.toContain(
        "@visx/group"
      );
    }
  });

  it("adaptation 9: the blocks read the reduced motion of the MotionConfig, not only the system's (BKLIT-UI.md)", () => {
    const blocks = readdirSync(join(web, "src/ui/bklit"), {
      recursive: true,
    })
      .map(String)
      .filter((file) => TS_SOURCE.test(file));
    for (const file of blocks) {
      const source = read(`src/ui/bklit/${file}`);
      // the bare hook of `motion` reads the system only: a phone at the essential level would still animate
      expect(source, file).not.toMatch(BARE_REDUCED_MOTION);
    }
    expect(read("src/ui/bklit/BKLIT-UI.md")).toContain("9. **Movimento");
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
    bklit: "/repo/apps/web/src/ui/bklit/charts/area.tsx",
    motion:
      "/repo/node_modules/.bun/framer-motion@14.3.0+6f4b9a1cfb20c0ae/node_modules/framer-motion/dist/es/index.mjs",
    visx: "/repo/node_modules/.bun/@visx+shape@4.0.0+0ac650c021fb1b59/node_modules/@visx/shape/esm/index.js",
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

  it("the guard fails the blocks of Bklit UI, motion and visx in another chunk, and accepts them in the charts chunk", () => {
    const together = {
      fileName: "assets/charts-Dk3jf9.js",
      modules: {
        [ids.bklit]: { renderedLength: 1 },
        [ids.motion]: { renderedLength: 1 },
        [ids.visx]: { renderedLength: 1 },
      },
    };
    expect(chartsPlacementProblems([together])).toEqual([]);
    const problems = chartsPlacementProblems([
      { ...together, fileName: "assets/index-abc.js" },
    ]);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("ui/bklit/charts/area.tsx");
    expect(problems.join("\n")).toContain("framer-motion");
    expect(problems.join("\n")).toContain("@visx/shape");
  });

  it("keeps 8 KB gzip as the reference of the line, which only warns (user's decision of 24/10/2026)", () => {
    expect(CHARTS_BUDGET_GZIP_BYTES).toBe(8000);
  });
});

describe("the heat map chunk of the build (t394)", () => {
  const ids = {
    cells: "/repo/apps/web/src/ui/bklit/charts/heatmap/heatmap-cells.tsx",
    entry: "/repo/apps/web/src/ui/charts/heatmap.ts",
    map: "D:\\repo\\apps\\web\\src\\ui\\charts\\sales-heatmap.tsx",
    pattern: "/repo/apps/web/src/ui/bklit/charts/patterns/lines.tsx",
    sparkline: "/repo/apps/web/src/ui/bklit/charts/sparkline.tsx",
    visxHeatmap:
      "/repo/node_modules/.bun/@visx+heatmap@4.0.0+0ac650c021fb1b59/node_modules/@visx/heatmap/esm/heatmaps/HeatmapRect.js",
    visxGroup:
      "/repo/node_modules/.bun/@visx+group@4.0.0+0ac650c021fb1b59/node_modules/@visx/group/esm/Group.js",
  };
  const mapModules = {
    [ids.cells]: { renderedLength: 1 },
    [ids.entry]: { renderedLength: 1 },
    [ids.map]: { renderedLength: 1 },
    [ids.pattern]: { renderedLength: 1 },
    [ids.visxHeatmap]: { renderedLength: 1 },
  };

  it("accepts the map in its chunk beside the charts chunk with what they share", () => {
    expect(
      chartsPlacementProblems([
        { fileName: "assets/heatmap-a1.js", modules: mapModules },
        {
          fileName: "assets/charts-b2.js",
          modules: {
            [ids.sparkline]: { renderedLength: 1 },
            [ids.visxGroup]: { renderedLength: 1 },
          },
        },
      ])
    ).toEqual([]);
  });

  it("fails a module of the map in the charts chunk or in a screen, and a shared one in the map's chunk", () => {
    const problems = chartsPlacementProblems([
      { fileName: "assets/charts-b2.js", modules: mapModules },
      {
        fileName: "assets/heatmap-a1.js",
        modules: { [ids.sparkline]: { renderedLength: 1 } },
      },
    ]);
    expect(problems).toHaveLength(6);
    expect(problems.slice(0, 5).join("\n")).toContain(
      "outside the heat map chunk"
    );
    expect(problems.join("\n")).toContain("@visx/heatmap");
    expect(problems[5]).toContain("sparkline.tsx");
    expect(problems[5]).toContain("outside the charts chunk");
  });

  it("the group of the charts chunk takes what the map shares, never the map", () => {
    expect(isSharedChartModule(ids.sparkline)).toBe(true);
    expect(isSharedChartModule(ids.visxGroup)).toBe(true);
    for (const id of Object.keys(mapModules)) {
      expect(isSharedChartModule(id), id).toBe(false);
    }
    expect(
      isSharedChartModule("/repo/apps/web/src/ui/charts/on-demand.tsx")
    ).toBe(false);
  });

  it("keeps the estimate of the v7 review, 16 KB gzip, as the reference of its line, which only warns", () => {
    expect(HEATMAP_BUDGET_GZIP_BYTES).toBe(16_000);
  });
});
