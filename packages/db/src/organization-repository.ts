import { and, eq, sql } from "drizzle-orm";
import type { createDatabase } from "./client";
import { user } from "./schema/auth";
import { memberships, organizations } from "./schema/organization";

type Database = ReturnType<typeof createDatabase>["db"];
type Organization = typeof organizations.$inferSelect;

/** ASCII "POLA" namespace for this advisory lock family. */
const organizationCreationLockNamespace = 0x50_4f_4c_41;

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
  timezone: string;
  userId: string;
}

export interface CreateInitialOrganizationInDatabaseResult {
  created: boolean;
  organization: Organization;
}

/**
 * Persists initial organization creation atomically. The user-scoped advisory
 * lock is the V1 single-organization boundary; the schema remains multi-org.
 * This is an onboarding transaction, not an authorized tenant transaction.
 * It currently requires a separately controlled privileged connection because
 * the runtime role intentionally has no organization or membership INSERT grant.
 * Do not expose it from a request route until a controlled writer is designed.
 */
export function createInitialOrganizationInDatabase(
  database: Database,
  input: CreateInitialOrganizationInDatabaseInput
): Promise<CreateInitialOrganizationInDatabaseResult> {
  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${organizationCreationLockNamespace}, hashtext(${input.userId}))`
      );
      const [identity] = await transaction
        .select({ emailVerified: user.emailVerified })
        .from(user)
        .where(eq(user.id, input.userId))
        .for("share")
        .limit(1);

      if (!identity) {
        throw new InitialOrganizationRepositoryError("user_not_found");
      }
      if (!identity.emailVerified) {
        throw new InitialOrganizationRepositoryError("email_not_verified");
      }

      const existingMemberships = await transaction
        .select({ organizationId: memberships.organizationId })
        .from(memberships)
        .where(eq(memberships.userId, input.userId))
        .limit(2);

      if (existingMemberships.length > 1) {
        throw new InitialOrganizationRepositoryError(
          "multiple_existing_organizations"
        );
      }

      const [existingMembership] = existingMemberships;
      if (existingMembership) {
        const [existingOrganization] = await transaction
          .select()
          .from(organizations)
          .where(eq(organizations.id, existingMembership.organizationId))
          .limit(1);

        if (!existingOrganization) {
          throw new InitialOrganizationRepositoryError(
            "organization_not_available"
          );
        }

        return { created: false, organization: existingOrganization };
      }

      await transaction.insert(organizations).values({
        id: input.id,
        name: input.name,
        timezone: input.timezone,
      });

      await transaction.insert(memberships).values({
        organizationId: input.id,
        userId: input.userId,
      });

      const [organization] = await transaction
        .select()
        .from(organizations)
        .where(
          and(
            eq(organizations.id, input.id),
            eq(organizations.status, "active")
          )
        )
        .limit(1);

      if (!organization) {
        throw new InitialOrganizationRepositoryError(
          "organization_insert_failed"
        );
      }

      return { created: true, organization };
    },
    { isolationLevel: "read committed" }
  );
}
