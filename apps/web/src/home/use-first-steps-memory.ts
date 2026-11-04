import { useState } from "react";
import { firstStepsMemory } from "../app-shell/first-steps";

export type FirstStepsMemory = "sold" | "steps" | null;

/**
 * What this tab knew of the store when the Início opened (`firstStepsMemory`): whether the checklist or the cards come,
 * for the skeleton to take that shape before the figures are read. Read once: the reads of the page decide after it.
 */
export function useFirstStepsMemory(organizationId: string): FirstStepsMemory {
  const [memory] = useState(() => ({
    organizationId,
    value: firstStepsMemory(organizationId),
  }));
  return memory.organizationId === organizationId
    ? memory.value
    : firstStepsMemory(organizationId);
}
