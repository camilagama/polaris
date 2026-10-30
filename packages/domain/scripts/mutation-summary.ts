type MutantStatus =
  | "Killed"
  | "Survived"
  | "NoCoverage"
  | "Timeout"
  | "CompileError"
  | "RuntimeError"
  | "Ignored"
  | "Pending";

interface ReportMutant {
  location: { start: { line: number } };
  mutatorName: string;
  replacement?: string;
  status: MutantStatus;
}

/** The slice of the Stryker JSON report (mutation-testing-report-schema) that the summary reads. */
export interface MutationReport {
  files: Record<string, { mutants: ReportMutant[] }>;
}

export interface MutationScore {
  detected: number;
  noCoverage: number;
  percentage: number | null;
  survived: number;
  total: number;
}

export interface Survivor {
  file: string;
  line: number;
  mutatorName: string;
  replacement: string;
  status: "Survived" | "NoCoverage";
}

/** What happened to a folder in this run: it finished, the deadline cut it, Stryker failed, or it was not asked for. */
export type FolderState = "complete" | "cut" | "failed" | "not-run";

export interface FolderReport {
  folder: string;
  report: MutationReport | null;
  state: FolderState;
}

const DEFAULT_SURVIVOR_LIMIT = 300;
const REPLACEMENT_LIMIT = 80;

function mutantsOf(report: MutationReport): [string, ReportMutant][] {
  return Object.entries(report.files).flatMap(([file, { mutants }]) =>
    mutants.map((mutant): [string, ReportMutant] => [file, mutant])
  );
}

// Same formula as Stryker: compile and runtime errors and ignored mutants are not valid mutants.
export function scoreOf(report: MutationReport): MutationScore {
  let detected = 0;
  let survived = 0;
  let noCoverage = 0;
  for (const [, { status }] of mutantsOf(report)) {
    if (status === "Killed" || status === "Timeout") {
      detected += 1;
    } else if (status === "Survived") {
      survived += 1;
    } else if (status === "NoCoverage") {
      noCoverage += 1;
    }
  }
  const total = detected + survived + noCoverage;
  return {
    detected,
    noCoverage,
    percentage: total === 0 ? null : (detected / total) * 100,
    survived,
    total,
  };
}

export function survivorsOf(report: MutationReport): Survivor[] {
  const survivors: Survivor[] = [];
  for (const [file, mutant] of mutantsOf(report)) {
    if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
      survivors.push({
        file,
        line: mutant.location.start.line,
        mutatorName: mutant.mutatorName,
        replacement: mutant.replacement ?? "",
        status: mutant.status,
      });
    }
  }
  return survivors.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.mutatorName.localeCompare(b.mutatorName)
  );
}

// The replacement is source code from the mutant: on one line, without the backtick
// that would close its code span.
function inlineCode(replacement: string): string {
  const flat = replacement.replace(/\s+/g, " ").replaceAll("`", "'").trim();
  return flat.length > REPLACEMENT_LIMIT
    ? `${flat.slice(0, REPLACEMENT_LIMIT)}…`
    : flat;
}

function formatPercentage(percentage: number | null): string {
  return percentage === null ? "n/a" : `${percentage.toFixed(2)}%`;
}

const STATE_TEXT: Record<Exclude<FolderState, "complete">, string> = {
  cut: "cut by the deadline, continues in the next run",
  failed: "Stryker failed",
  "not-run": "not run",
};

// `survivorLimit` is per folder, so one folder with many survivors does not hide the others.
export function renderSummary(
  folders: FolderReport[],
  survivorLimit = DEFAULT_SURVIVOR_LIMIT
): string {
  const lines = [
    "## Mutation testing, packages/domain",
    "",
    "| Folder | Score | Killed | Survived | No coverage | Mutants |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const listed: string[] = [];
  let unfinished = 0;
  let survivorTotal = 0;
  for (const { folder, report, state } of folders) {
    if (report === null || state !== "complete") {
      unfinished += 1;
      const text = state === "complete" ? "no report" : STATE_TEXT[state];
      lines.push(`| ${folder} | ${text} |  |  |  |  |`);
      continue;
    }
    const score = scoreOf(report);
    lines.push(
      `| ${folder} | ${formatPercentage(score.percentage)} | ${score.detected} | ${score.survived} | ${score.noCoverage} | ${score.total} |`
    );
    const survivors = survivorsOf(report);
    survivorTotal += survivors.length;
    for (const survivor of survivors.slice(0, survivorLimit)) {
      const marker = survivor.status === "NoCoverage" ? " (no coverage)" : "";
      listed.push(
        `- \`${survivor.file}:${survivor.line}\` ${survivor.mutatorName}${marker}: \`${inlineCode(survivor.replacement)}\``
      );
    }
    const left = survivors.length - survivorLimit;
    if (left > 0) {
      listed.push(
        `- ${folder}: ${left} more survivors are in the HTML report.`
      );
    }
  }

  lines.push("", "### Surviving mutants", "");
  if (unfinished > 0) {
    lines.push(
      "Partial run: only the folders with a score above were counted.",
      ""
    );
  }
  if (survivorTotal === 0) {
    lines.push(
      unfinished > 0
        ? "No surviving mutants in the folders that finished."
        : "No surviving mutants."
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "Each line is a mutation no test noticed (`NoCoverage`: no test runs that line).",
    "",
    ...listed
  );
  return `${lines.join("\n")}\n`;
}
