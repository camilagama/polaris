import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepResult } from "./suite";

export interface DeviceReport {
  device: string;
  error: string | null;
  platform: string;
  sessionId: string | null;
  sessionUrl: string | null;
  steps: StepResult[];
}

export interface RunReport {
  devices: DeviceReport[];
  finishedAt: string;
  /** Verdadeiro quando `GATE5_PLATFORMS` ou `GATE5_FLOWS` restringiram a execução: não prova o Gate inteiro. */
  partial: boolean;
  selection: { flows: number[]; platforms: string[] };
  startedAt: string;
  status: "failed" | "passed";
}

const ICON = { failed: "❌ falhou", passed: "✅ passou", skipped: "⏭️ pulado" };
const cell = (text: string) =>
  text.replaceAll("|", "\\|").replaceAll("\n", " ");

export function deviceStatus(report: DeviceReport) {
  return report.error === null &&
    report.steps.length > 0 &&
    report.steps.every((step) => step.status === "passed")
    ? "passed"
    : "failed";
}

function markdown(report: RunReport) {
  const lines = [
    "# Gate 5 em aparelhos reais (BrowserStack)",
    "",
    `Resultado: **${report.status === "passed" ? "passou" : "falhou"}** · início ${report.startedAt} · fim ${report.finishedAt}`,
    "",
  ];
  if (report.partial) {
    lines.push(
      `> **Execução parcial** (aparelhos: ${report.selection.platforms.join(", ")}; fluxos: ${report.selection.flows.join(", ")}): não prova o Gate inteiro.`,
      ""
    );
  }
  for (const device of report.devices) {
    lines.push(
      `## ${device.device} (${device.platform}) — ${deviceStatus(device) === "passed" ? "passou" : "falhou"}`,
      "",
      `Sessão: ${device.sessionUrl ?? "indisponível"}`,
      ""
    );
    if (device.error) {
      lines.push(`Erro da sessão: ${device.error}`, "");
    }
    lines.push(
      "| Fluxo | Passo | Resultado | Tempo | Detalhe |",
      "| --- | --- | --- | --- | --- |"
    );
    for (const step of device.steps) {
      lines.push(
        `| ${cell(step.flow)} | ${cell(step.name)} | ${ICON[step.status]} | ${(step.ms / 1000).toFixed(1)} s | ${cell(step.detail)} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Grava `report.json` e `report.md` em `directory`; o conteúdo já vem sem segredos. */
export function writeReport(directory: string, report: RunReport) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  writeFileSync(join(directory, "report.md"), `${markdown(report)}\n`);
}
