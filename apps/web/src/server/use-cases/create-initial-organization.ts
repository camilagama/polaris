import { randomUUID } from "node:crypto";
import type { createDatabase } from "@polaris/db/client";
import {
  createInitialOrganizationInDatabase,
  InitialOrganizationRepositoryError,
  type InitialOrganizationRepositoryErrorCode,
} from "@polaris/db/organization-repository";
import type { organizations } from "@polaris/db/organization-schema";

type Database = ReturnType<typeof createDatabase>["db"];
type Organization = typeof organizations.$inferSelect;

export type CreateInitialOrganizationErrorCode =
  | "invalid_user_id"
  | "invalid_organization_name"
  | "invalid_timezone"
  | InitialOrganizationRepositoryErrorCode;

export class CreateInitialOrganizationError extends Error {
  readonly code: CreateInitialOrganizationErrorCode;

  constructor(
    code: CreateInitialOrganizationErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.code = code;
    this.name = "CreateInitialOrganizationError";
  }
}

export interface CreateInitialOrganizationInput {
  name: string;
  requestId?: string | null;
  timezone: string;
  authenticatedUserId: string;
}

export interface CreateInitialOrganizationResult {
  created: boolean;
  organization: Organization;
}

function normalizeInput(input: CreateInitialOrganizationInput) {
  if (
    !input.authenticatedUserId.trim() ||
    input.authenticatedUserId !== input.authenticatedUserId.trim()
  ) {
    throw new CreateInitialOrganizationError("invalid_user_id");
  }

  const name = input.name.trim();
  if (!name) {
    throw new CreateInitialOrganizationError("invalid_organization_name");
  }

  const timezone = input.timezone.trim();
  if (!timezone) {
    throw new CreateInitialOrganizationError("invalid_timezone");
  }

  try {
    return {
      id: randomUUID(),
      name,
      requestId: input.requestId ?? null,
      timezone: new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
      }).resolvedOptions().timeZone,
      userId: input.authenticatedUserId,
    };
  } catch (error) {
    throw new CreateInitialOrganizationError("invalid_timezone", {
      cause: error,
    });
  }
}

/**
 * Internal privileged onboarding use case. The supplied database must be
 * separately controlled and must not be the request-runtime connection.
 * authenticatedUserId must come from a server-verified session. This use case
 * is not wired to HTTP; runtime onboarding writes remain deferred until a
 * controlled writer can bind the operation to that session.
 */
export async function createInitialOrganization(
  database: Database,
  input: CreateInitialOrganizationInput
): Promise<CreateInitialOrganizationResult> {
  const normalized = normalizeInput(input);

  try {
    return await createInitialOrganizationInDatabase(database, normalized);
  } catch (error) {
    if (error instanceof InitialOrganizationRepositoryError) {
      throw new CreateInitialOrganizationError(error.code, { cause: error });
    }
    throw error;
  }
}
