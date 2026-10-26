/* Polaris adaptation of Bklit UI (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */

/**
 * The entry of the charts chunk (`charts-*.js`): everything that draws a chart, with the blocks of Bklit UI, `motion`,
 * `@visx/*` and the d3 modules they bring, is imported from here and from nowhere else. `on-demand.tsx` loads it with
 * `import()`, so the chunk is downloaded when a screen asks for a chart, never with the shell's first script. The chunk
 * is in the precache, with a line of its own in the budget, and a guard fails the build when a chart module or one of
 * those libraries lands in any other chunk (`pwa/precache-budget.ts`).
 */
// biome-ignore lint/performance/noBarrelFile: this is the entry of the charts chunk, the one file `import()` asks for
export { AreaChart, type AreaChartProps } from "./area-chart";
export { RingChart, type RingChartProps } from "./ring-chart";
export { Sparkline, type SparklineProps } from "./sparkline";
