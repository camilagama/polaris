/**
 * Ported from @visx/pattern 4.0.0 (https://github.com/airbnb/visx).
 * MIT License — Copyright (c) 2017-2018 Harrison Shoff. See ./LICENSE-visx-pattern.
 */
import { cn } from "@/lib/utils";
import { Path } from "./path";

export interface PatternWavesProps {
  /** Unique id for the pattern. */
  id: string;
  /** Width of the pattern element. */
  width: number;
  /** Height of the pattern element. */
  height: number;
  /** fill color applied to path. */
  fill?: string | undefined;
  /** className applied to the path element. */
  className?: string | undefined;
  /** Background color applied behind path. */
  background?: string | undefined;
  /** Stroke color applied to path. */
  stroke?: string | undefined;
  /** strokeWidth applied to path. */
  strokeWidth?: number | string | undefined;
  /** strokeDasharray applied to path. */
  strokeDasharray?: string | number | undefined;
  /** strokeLinecap applied to path. */
  strokeLinecap?: "square" | "butt" | "round" | "inherit" | undefined;
  /** shapeRendering applied to path. */
  shapeRendering?: string | number | undefined;
}

export function Waves({
  id,
  width,
  height,
  fill,
  stroke,
  strokeWidth,
  strokeDasharray,
  strokeLinecap,
  shapeRendering,
  background,
  className,
}: PatternWavesProps) {
  return (
    <Path
      background={background}
      className={cn("visx-pattern-wave", className)}
      fill={fill}
      height={height}
      id={id}
      path={`M 0 ${height / 2} c ${height / 8} ${-height / 4} , ${(height * 3) / 8} ${-height / 4} , ${height / 2} 0
             c ${height / 8} ${height / 4} , ${(height * 3) / 8} ${height / 4} , ${height / 2} 0 M ${-height / 2} ${height / 2}
             c ${height / 8} ${height / 4} , ${(height * 3) / 8} ${height / 4} , ${height / 2} 0 M ${height} ${height / 2}
             c ${height / 8} ${-height / 4} , ${(height * 3) / 8} ${-height / 4} , ${height / 2} 0`}
      shapeRendering={shapeRendering}
      stroke={stroke}
      strokeDasharray={strokeDasharray}
      strokeLinecap={strokeLinecap}
      strokeWidth={strokeWidth}
      width={width}
    />
  );
}
