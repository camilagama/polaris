/* adapted from Bklit UI (bklit/bklit-ui@3e9af3b), MIT */

/**
 * The entry of the charts chunk (`charts-*.js`): everything that draws a chart, and d3-shape with it, is imported
 * from here and from nowhere else. `on-demand.tsx` loads it with `import()`, so the chunk is downloaded when a screen
 * asks for a chart, never with the shell's first script. The chunk is in the precache, with a line of its own in the
 * budget, and a guard fails the build when a chart module or d3 lands in any other chunk (`pwa/precache-budget.ts`).
 */
// biome-ignore lint/performance/noBarrelFile: this is the entry of the charts chunk, the one file `import()` asks for
export { AreaChart, type AreaChartProps } from "./area-chart";
export { Sparkline, type SparklineProps } from "./sparkline";
