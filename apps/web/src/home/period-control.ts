import { createContext, type ReactNode, useContext } from "react";

/**
 * The period picker of the Início, given by the page to the line above the tiles of the month (and above their
 * skeletons), so it sits on that line, at its end, in every state of the cards and never moves when they change.
 */
const PeriodControlContext = createContext<ReactNode>(null);

export const PeriodControlProvider = PeriodControlContext.Provider;

export function usePeriodControl(): ReactNode {
  return useContext(PeriodControlContext);
}
