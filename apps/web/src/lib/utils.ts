import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/* tailwind-merge only knows Tailwind's own scales: without this, `text-support` (a size of the theme) is read as a
   text color and `cn("text-support text-muted-foreground")` drops it, and `h-ctl-md` never yields to `h-auto`. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "support",
            "section",
            "title",
            "value-md",
            "value-lg",
            "value-xl",
          ],
        },
      ],
    },
    theme: {
      spacing: ["ctl-xs", "ctl-sm", "ctl-md", "ctl-lg"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
