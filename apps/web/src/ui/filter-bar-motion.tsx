"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import type { PillMotion } from "@/ui/filter-bar-model";

/**
 * The animated layer of the filter bar (t383, t386): the pills come in and go out with opacity and scale and the
 * neighbours slide (`motion`, as the Araute has it). `filter-bar.tsx` loads this module by `import()` only at the
 * `full` level of motion (src/lib/motion-level.ts): on a phone the bar draws the same pills in plain elements and never
 * asks for the `motion` chunk (the guard `motionLoadProblems` of pwa/precache-budget.ts).
 */
export function PillList({ children }: { children: ReactNode }) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}

export interface PillFrameProps {
  children: ReactNode;
  className: string;
  motion: PillMotion;
}

export function PillFrame({
  children,
  className,
  motion: moves,
}: PillFrameProps) {
  return (
    <motion.div {...moves} className={className} data-slot="filter-pill">
      {children}
    </motion.div>
  );
}
