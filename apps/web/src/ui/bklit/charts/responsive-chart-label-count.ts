export interface ResponsiveChartLabelCount {
  base?: number | undefined;
  sm?: number | undefined;
  md?: number | undefined;
  lg?: number | undefined;
  xl?: number | undefined;
}

export type ChartLabelCount = number | ResponsiveChartLabelCount;

export function resolveResponsiveChartLabelCount(
  value: ChartLabelCount,
  containerWidth: number,
  fallback: number
): number {
  if (typeof value === "number") {
    return value;
  }

  const candidates = [
    [1280, value.xl],
    [1024, value.lg],
    [768, value.md],
    [640, value.sm],
    [0, value.base],
  ] as const;

  return (
    candidates.find(
      ([minWidth, count]) => containerWidth >= minWidth && count != null
    )?.[1] ?? fallback
  );
}
