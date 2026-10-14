import { sql } from "drizzle-orm";
import type { createDatabase } from "./client";
import type { organizations } from "./schema/organization";

type Database = ReturnType<typeof createDatabase>["db"];
type Organization = typeof organizations.$inferSelect;

export type InitialOrganizationRepositoryErrorCode =
  | "user_not_found"
  | "email_not_verified"
  | "multiple_existing_organizations"
  | "organization_not_available"
  | "organization_insert_failed";

export class InitialOrganizationRepositoryError extends Error {
  readonly code: InitialOrganizationRepositoryErrorCode;

  constructor(
    code: InitialOrganizationRepositoryErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.code = code;
    this.name = "InitialOrganizationRepositoryError";
  }
}

export interface CreateInitialOrganizationInDatabaseInput {
  id: string;
  name: string;
  requestId?: string | null;
  timezone: string;
  userId: string;
}

export interface CreateInitialOrganizationInDatabaseResult {
  created: boolean;
  organization: Organization;
}

interface InitialOrganizationWriterRow {
  created: boolean;
  created_at: Date;
  currency: string;
  id: string;
  name: string;
  status: string;
  timezone: string;
  updated_at: Date;
}

function writerErrorDetail(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);

    const candidate = current as { cause?: unknown; detail?: unknown };
    if (typeof candidate.detail === "string") {
      return candidate.detail;
    }
    current = candidate.cause;
  }

  return undefined;
}

function mapWriterError(error: unknown): unknown {
  const detail = writerErrorDetail(error);
  const allowedCodes: readonly InitialOrganizationRepositoryErrorCode[] = [
    "user_not_found",
    "email_not_verified",
    "multiple_existing_organizations",
    "organization_not_available",
    "organization_insert_failed",
  ];

  if (
    detail &&
    allowedCodes.includes(detail as InitialOrganizationRepositoryErrorCode)
  ) {
    return new InitialOrganizationRepositoryError(
      detail as InitialOrganizationRepositoryErrorCode,
      { cause: error instanceof Error ? error : undefined }
    );
  }

  return error;
}

/**
 * Calls a narrowly scoped PostgreSQL SECURITY DEFINER writer. The Worker must
 * authenticate Better Auth first and pass only the session user ID. This
 * repository grants no direct DML on organizations or memberships.
 */
export async function createInitialOrganizationInDatabase(
  database: Database,
  input: CreateInitialOrganizationInDatabaseInput
): Promise<CreateInitialOrganizationInDatabaseResult> {
  try {
    const result = await database.execute(sql`
      SELECT *
      FROM public.create_initial_organization(
        ${input.userId},
        ${input.id},
        ${input.name},
        ${input.timezone},
        ${input.requestId ?? null}::uuid
      )
    `);
    const row = result.rows[0] as InitialOrganizationWriterRow | undefined;

    if (!row) {
      throw new InitialOrganizationRepositoryError(
        "organization_insert_failed"
      );
    }

    return {
      created: row.created,
      organization: {
        createdAt: row.created_at,
        currency: row.currency,
        id: row.id,
        name: row.name,
        status: row.status,
        timezone: row.timezone,
        updatedAt: row.updated_at,
      },
    };
  } catch (error) {
    const mappedError = mapWriterError(error);
    if (mappedError instanceof InitialOrganizationRepositoryError) {
      throw mappedError;
    }
    throw mappedError;
  }
}
