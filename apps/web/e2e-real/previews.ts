import { E2E_REAL_PORTS } from "../e2e/run-settings";

type Preview = keyof typeof E2E_REAL_PORTS;

const ALL = Object.keys(E2E_REAL_PORTS) as Preview[];

/**
 * The previews a run brings up: `E2E_REAL_PREVIEWS` (names separated by commas), or both when it is unset or empty.
 * The CI runs each part of the job with the preview of its own projects, so a part does not pay for a build it
 * never opens; a name that is not a preview stops the run instead of starting none.
 */
export function selectedPreviews(
  value: string | undefined = process.env.E2E_REAL_PREVIEWS
): Preview[] {
  if (value === undefined || value.trim() === "") {
    return ALL;
  }
  const names = value.split(",").map((name) => name.trim());
  const unknown = names.filter((name) => !ALL.includes(name as Preview));
  if (unknown.length > 0) {
    throw new Error(
      `E2E_REAL_PREVIEWS names ${unknown.map((name) => `"${name}"`).join(", ")}; use ${ALL.join(" and/or ")} separated by commas, or leave it unset for both.`
    );
  }
  return ALL.filter((preview) => names.includes(preview));
}
