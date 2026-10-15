import type { Feedback } from "./use-command-runner";

/** A success note (`status`) or an error (`alert`), or nothing. */
export function FeedbackMessage({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) {
    return null;
  }
  return feedback.kind === "error" ? (
    <p className="categories-message is-error" role="alert">
      {feedback.text}
    </p>
  ) : (
    <p className="categories-message is-success" role="status">
      {feedback.text}
    </p>
  );
}
