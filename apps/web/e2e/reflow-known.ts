/** A cut that shows with a finger and not with a mouse, named so a reviewer can read it and a fix can take it out. */
export interface KnownCoarseFinding {
  /** Titles of the cases (`test.info().title`) the line excuses: a cut known at 320/20 does not excuse the same element at 360/16. */
  cases: readonly string[];
  clientWidth: number;
  /** What a later change has to do about it, in the words of the screen. */
  reason: string;
  /** The screen, as its users read it. */
  screen: string;
  scrollWidth: number;
  /** `ClippedElement.selector`, or `html` for the page that scrolls sideways. */
  selector: string;
  /** The file of the spec whose cases it excuses (`basename`). */
  spec: string;
}

/** Empty while no case shows a cut with a finger that the mouse does not; each line is the work of a later change, never an excuse. */
export const KNOWN_COARSE_FINDINGS: readonly KnownCoarseFinding[] = [];
