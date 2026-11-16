import { readFileSync } from "node:fs";
import { deltaReport } from "../pwa/precache-budget";

function readOrNull(path: string | undefined): string | null {
  if (!path) {
    return null;
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const [headPath, basePath, baseSha = "", baseBuild = "ok"] =
  process.argv.slice(2);

try {
  console.log(
    deltaReport({
      baseBuild: baseBuild === "failed" ? "failed" : "ok",
      baseSha,
      baseText: readOrNull(basePath),
      headText: readOrNull(headPath),
    })
  );
} catch {
  console.log("PRECACHE-DELTA indisponível (erro ao montar a linha)");
}
