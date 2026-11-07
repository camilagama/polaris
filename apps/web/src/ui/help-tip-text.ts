/**
 * The limits of a help text (DESIGN.md, "Texto curto"), apart from the component so a test that reads the source tree
 * can import them without React or the `@/` alias. Screens that use `HelpTip` test their texts with
 * `helpTipTextProblem`.
 */

/** The most characters of one help text (DESIGN.md, "Texto curto"). */
export const HELP_TIP_MAX_CHARS = 160;

/** The most sentences of one help text. */
const HELP_TIP_MAX_SENTENCES = 2;

// a sentence ends at a terminator followed by a space or by the end, so "R$ 1.234,56" and "1 a 23/10" do not count; the
// "vs." that DESIGN.md allows inside a help text is an abbreviation, not an end
const SENTENCE_END = /(?<!\bvs)[.!?…]+(?=\s|$)/g;

/** What is wrong with a help text, or null when it fits the limits. */
export function helpTipTextProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  if (trimmed.length > HELP_TIP_MAX_CHARS) {
    return `${trimmed.length} characters, the limit is ${HELP_TIP_MAX_CHARS}`;
  }
  const sentences = (trimmed.match(SENTENCE_END) ?? []).length;
  if (sentences > HELP_TIP_MAX_SENTENCES) {
    return `${sentences} sentences, the limit is ${HELP_TIP_MAX_SENTENCES}`;
  }
  return null;
}
