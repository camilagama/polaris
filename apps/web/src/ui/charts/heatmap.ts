/* Polaris adaptation of Bklit UI (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */

/**
 * The entry of the heat map chunk (`heatmap-*.js`): the map of the Início (Bklit UI's `HeatmapChart`, its cells
 * and `@visx/heatmap`) and the bars of the mean by weekday beside it. A chunk of its own, apart from the charts chunk,
 * so its weight is measured on a line of its own in the precache (`pwa/precache-budget.ts`); `on-demand.tsx` loads it
 * with `import()` when the Início draws the map, never with the shell's first script. What it shares with the charts
 * (the sparkline of the bars, `motion`) stays in their chunks.
 */
// biome-ignore lint/performance/noBarrelFile: this is the entry of the heat map chunk, the one file `import()` asks for
export {
  type HeatmapDay,
  SalesHeatmap,
  type SalesHeatmapProps,
} from "./sales-heatmap";
export { WeekdayBars, type WeekdayBarsProps } from "./weekday-bars";
