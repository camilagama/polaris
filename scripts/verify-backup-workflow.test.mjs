import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENTS,
  findBackupWorkflowProblems,
  REQUIRED_LINES,
  WORKFLOW_PATH,
} from "./verify-backup-workflow.mjs";

const jobOf = (env) => {
  const config = ENVIRONMENTS[env];
  return `  ${env}:
    name: Dump, seal and upload (${env})
    if: vars.${config.enabled} == 'true' && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || inputs.environment == '${env}')
    runs-on: ubuntu-24.04
    environment: ${config.environment}
    concurrency:
      group: ${config.group}
      cancel-in-progress: false
    env:
      BACKUP_ENVIRONMENT: ${env}
      BACKUP_BUCKET: ${config.bucket}
      RECIPIENTS: ${config.recipients}
    steps:
      - uses: actions/checkout@pinned
        with:
          persist-credentials: false
      - name: The recipients are the reviewed ones
        run: |
          set -euo pipefail
          if ! grep -Eq '^age1[02-9ac-hj-np-z]{58}$' "$RECIPIENTS"; then
            exit 1
          fi
          actual=$(sha256sum "$RECIPIENTS" | cut -d' ' -f1)
          if [ -z "$EXPECTED" ] || [ "$actual" != "$EXPECTED" ]; then
            exit 1
          fi
      - name: Dump the ${env} database
        run: bash scripts/backup/dump.sh /dev/shm/polaris-backup
      - name: Seal
        run: bash scripts/backup/seal.sh /dev/shm/polaris-backup "$RECIPIENTS" "$RUNNER_TEMP/$STAMP.tar.age"
      - name: Upload and retention
        env:
          R2_BACKUP_BUCKET: \${{ env.BACKUP_BUCKET }}
        run: bash scripts/backup/upload.sh
      - name: Open the failure issue
        run: gh issue create --label ${config.label} --title "The ${env} backup failed"
`;
};

const workflow = ({
  triggers = '  schedule:\n    - cron: "22 6 * * *"\n  workflow_dispatch:\n',
  staging = jobOf("staging"),
  production = jobOf("production"),
  extraJob = "",
} = {}) =>
  `name: Backup\non:\n${triggers}\npermissions: {}\n\njobs:\n${staging}\n${production}${extraJob}`;

const replaceIn = (text, from, to) => {
  expect(text).toContain(from);
  return text.replace(from, to);
};

describe("the backup workflow check", () => {
  it("accepts two jobs that differ only in the names of their environment", () => {
    expect(findBackupWorkflowProblems(workflow())).toEqual([]);
  });

  it("refuses production sealed to the staging key file", () => {
    const production = replaceIn(
      jobOf("production"),
      "RECIPIENTS: ops/backup/recipients-production.txt",
      "RECIPIENTS: ops/backup/recipients-staging.txt"
    );
    const problems = findBackupWorkflowProblems(workflow({ production }));
    expect(problems).toContain(
      "production: missing the line `RECIPIENTS: ops/backup/recipients-production.txt`"
    );
    expect(problems).toContain("production: names staging");
  });

  it("refuses production sent to the staging bucket", () => {
    const production = replaceIn(
      jobOf("production"),
      "BACKUP_BUCKET: polaris-backup\n",
      "BACKUP_BUCKET: polaris-backup-staging\n"
    );
    expect(findBackupWorkflowProblems(workflow({ production }))).toContain(
      "production: missing the line `BACKUP_BUCKET: polaris-backup`"
    );
  });

  it("refuses staging sent to the production bucket", () => {
    const staging = replaceIn(
      jobOf("staging"),
      "BACKUP_BUCKET: polaris-backup-staging\n",
      "BACKUP_BUCKET: polaris-backup\n"
    );
    expect(findBackupWorkflowProblems(workflow({ staging }))).toContain(
      "staging: missing the line `BACKUP_BUCKET: polaris-backup-staging`"
    );
  });

  it("refuses production under the staging Environment, the secrets of staging", () => {
    const production = replaceIn(
      jobOf("production"),
      "environment: production-backup",
      "environment: staging-backup"
    );
    expect(findBackupWorkflowProblems(workflow({ production }))).toContain(
      "production: missing the line `environment: production-backup`"
    );
  });

  it("refuses production under the staging concurrency group", () => {
    const production = replaceIn(
      jobOf("production"),
      "group: deploy-production",
      "group: deploy-staging"
    );
    expect(findBackupWorkflowProblems(workflow({ production }))).toContain(
      "production: missing the line `group: deploy-production`"
    );
  });

  it("refuses production switched by the staging variable", () => {
    const production = replaceIn(
      jobOf("production"),
      "vars.PRODUCTION_BACKUP_ENABLED",
      "vars.STAGING_BACKUP_ENABLED"
    );
    expect(
      findBackupWorkflowProblems(workflow({ production })).some((problem) =>
        problem.startsWith("production: missing the line `if:")
      )
    ).toBe(true);
  });

  it("refuses a production job that runs off the main branch or without the dispatch choice", () => {
    for (const from of [
      " && github.ref == 'refs/heads/main'",
      " && (github.event_name == 'schedule' || inputs.environment == 'production')",
    ]) {
      const production = replaceIn(jobOf("production"), from, "");
      expect(
        findBackupWorkflowProblems(workflow({ production })).some((problem) =>
          problem.startsWith("production: missing the line `if:")
        )
      ).toBe(true);
    }
  });

  it("refuses an issue label of the other environment, in any of the steps", () => {
    const production = replaceIn(
      jobOf("production"),
      "--label backup-production",
      "--label backup-staging"
    );
    expect(findBackupWorkflowProblems(workflow({ production }))).toContain(
      "production: the issue label must be backup-production everywhere, found backup-staging"
    );
  });

  it("refuses a step that exists in one job only", () => {
    const production = replaceIn(
      jobOf("production"),
      "        run: bash scripts/backup/dump.sh",
      "        run: echo skipped && bash scripts/backup/dump.sh"
    );
    expect(
      findBackupWorkflowProblems(workflow({ production })).some((problem) =>
        problem.startsWith("the steps of staging and production differ at line")
      )
    ).toBe(true);
  });

  it("refuses a job of one environment with a step the other lacks", () => {
    const staging = `${jobOf("staging")}      - name: Extra\n        run: echo extra\n`;
    expect(
      findBackupWorkflowProblems(workflow({ staging })).some((problem) =>
        problem.startsWith("the steps of staging and production differ at line")
      )
    ).toBe(true);
  });

  it.each(REQUIRED_LINES)(
    "refuses both jobs losing the line `%s`, which comparing them would not see",
    (line) => {
      const without = (text) => replaceIn(text, `${line}\n`, "");
      const problems = findBackupWorkflowProblems(
        workflow({
          staging: without(jobOf("staging")),
          production: without(jobOf("production")),
        })
      );
      expect(problems).toEqual([
        `staging: missing the line \`${line.trim()}\``,
        `production: missing the line \`${line.trim()}\``,
      ]);
    }
  );

  it("does not trip on a job that ends without the blank line before the next one", () => {
    expect(
      findBackupWorkflowProblems(
        workflow({ production: jobOf("production").trimEnd() })
      )
    ).toEqual([]);
  });

  it("refuses a third job, a missing job and a reversed order", () => {
    expect(
      findBackupWorkflowProblems(
        workflow({ extraJob: "\n  other:\n    runs-on: ubuntu-24.04\n" })
      )
    ).toEqual([
      "the jobs must be staging and production, in that order, found staging, production, other",
    ]);
    expect(findBackupWorkflowProblems(workflow({ production: "" }))).toEqual([
      "the jobs must be staging and production, in that order, found staging",
    ]);
    expect(
      findBackupWorkflowProblems(
        workflow({ production: jobOf("staging"), staging: jobOf("production") })
      )
    ).toEqual([
      "the jobs must be staging and production, in that order, found production, staging",
    ]);
  });

  it("allows only the schedule and the manual dispatch as triggers", () => {
    for (const extra of ["pull_request", "push", "pull_request_target"]) {
      const triggers = `  schedule:\n    - cron: "22 6 * * *"\n  workflow_dispatch:\n  ${extra}:\n`;
      expect(findBackupWorkflowProblems(workflow({ triggers }))).toEqual([
        `the trigger ${extra} is not allowed`,
      ]);
    }
    expect(
      findBackupWorkflowProblems(
        workflow({ triggers: "  workflow_dispatch:\n" })
      )
    ).toEqual(["the trigger schedule is missing"]);
  });

  it("requires the empty permissions of the workflow", () => {
    expect(
      findBackupWorkflowProblems(
        workflow().replace("permissions: {}", "permissions: write-all")
      )
    ).toEqual(["the workflow must start with `permissions: {}`"]);
  });
});

const AGE_KEY = /^age1[02-9ac-hj-np-z]{58}$/;

const repositoryWorkflow = new URL(`../${WORKFLOW_PATH}`, import.meta.url);
const legacyWorkflow = new URL(
  "../.github/workflows/backup-staging.yml",
  import.meta.url
);

describe("the backup workflow of the repository", () => {
  it("is the generic backup.yml or, until its patch is applied, the staging file alone", () => {
    expect([
      existsSync(repositoryWorkflow),
      existsSync(legacyWorkflow),
    ]).not.toEqual([true, true]);
    expect(existsSync(repositoryWorkflow) || existsSync(legacyWorkflow)).toBe(
      true
    );
  });

  it.runIf(existsSync(repositoryWorkflow))(
    "has a production job that agrees with the staging job",
    () => {
      const text = readFileSync(repositoryWorkflow, "utf8");
      expect(findBackupWorkflowProblems(text)).toEqual([]);
    }
  );
});

describe("the recipients file of production", () => {
  const recipients = readFileSync(
    new URL("../ops/backup/recipients-production.txt", import.meta.url),
    "utf8"
  );
  const lines = recipients
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));

  it("holds only age public keys besides its comments, none of them the staging key", () => {
    const staging = readFileSync(
      new URL("../ops/backup/recipients-staging.txt", import.meta.url),
      "utf8"
    );
    for (const line of lines) {
      expect(line).toMatch(AGE_KEY);
      expect(staging).not.toContain(line);
    }
  });

  it("explains how the holder's key gets in", () => {
    expect(recipients).toContain("BACKUP_RECIPIENTS_SHA256");
    expect(recipients).toContain("PRODUCTION_BACKUP_ENABLED");
  });
});
