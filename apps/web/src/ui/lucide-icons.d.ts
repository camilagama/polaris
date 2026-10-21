// One icon per import (ADR 0103): the file of each icon, never the whole package. lucide-react has no
// `exports` map and no types for these paths; each one is a single default-exported icon component.
declare module "lucide-react/dist/esm/icons/*" {
  import type { LucideIcon } from "lucide-react";

  const icon: LucideIcon;
  export default icon;
}
