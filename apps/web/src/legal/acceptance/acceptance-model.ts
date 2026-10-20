import type { LegalDocumentId } from "@polaris/domain/legal/legal-documents";
import { rpcErrorCode, rpcErrorReason } from "../../lib/rpc-error";
import {
  ACCEPTANCE_CHECKBOX,
  ACCEPTANCE_FIRST_TIME,
  ACCEPTANCE_NEW_VERSION,
} from "./acceptance-texts";

/** One document still to accept, as `account.legalStatus` answers it. */
export interface PendingLegalDocument {
  changes: string | null;
  document: LegalDocumentId;
  effectiveFrom: string | null;
  version: number;
}

export type AcceptanceLoad =
  | { status: "loading" }
  | { offline: boolean; status: "error" }
  | { status: "session_required" }
  | { status: "done" }
  | { pending: readonly PendingLegalDocument[]; status: "pending" };

/** What the screen shows for the answer of `account.legalStatus`. */
export function acceptanceLoadFrom(
  pending: readonly PendingLegalDocument[]
): AcceptanceLoad {
  return pending.length === 0
    ? { status: "done" }
    : { pending, status: "pending" };
}

/** What the screen shows when `account.legalStatus` failed. */
export function acceptanceLoadAfterFailure(
  error: unknown,
  online: boolean
): AcceptanceLoad {
  if (rpcErrorCode(error) === "UNAUTHORIZED") {
    return { status: "session_required" };
  }
  return { offline: !online, status: "error" };
}

/** A version with "what changed" is a new one: the person had accepted an earlier text. */
export function acceptanceIntro(
  pending: readonly PendingLegalDocument[]
): string {
  return pending.some((item) => item.changes !== null)
    ? ACCEPTANCE_NEW_VERSION
    : ACCEPTANCE_FIRST_TIME;
}

/** The box names only what is being accepted (a new version may be of one document only, L5). */
export function acceptanceCheckboxLabel(
  pending: readonly PendingLegalDocument[]
): string {
  const documents = new Set(pending.map((item) => item.document));
  if (documents.has("terms") && documents.has("privacy")) {
    return ACCEPTANCE_CHECKBOX;
  }
  return documents.has("terms")
    ? "Li e aceito os Termos de Uso."
    : "Li e aceito a Política de Privacidade.";
}

export type AcceptanceSubmitFailure =
  | "session_required"
  | "version_changed"
  | "failed";

/** What a failed `account.acceptLegal` means for the screen. */
export function acceptanceSubmitFailure(
  error: unknown
): AcceptanceSubmitFailure {
  if (rpcErrorCode(error) === "UNAUTHORIZED") {
    return "session_required";
  }
  if (
    rpcErrorCode(error) === "CONFLICT" &&
    rpcErrorReason(error) === "legal_version_mismatch"
  ) {
    return "version_changed";
  }
  return "failed";
}
