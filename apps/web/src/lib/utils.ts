import { type ClassValue, clsx } from "clsx";

/* Only `clsx`, no `tailwind-merge` (about 8.6 KB gzip, t266): a class a caller adds never fights a class the part
   already sets. A part that a screen needs to change in a property it sets (height, padding, gap, color, width)
   has a variant or a prop for it, and the class it replaces is not in the element: the order of the classes in the
   CSS does not decide anything. */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}
