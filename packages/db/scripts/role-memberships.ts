export interface RoleMembershipRow {
  admin_option: boolean;
  granted: string;
  inherit_option: boolean;
  member: string;
  set_option: boolean;
}

/**
 * pg_auth_members holds one row per grantor, so a membership granted by two roles is two rows. They are folded into the
 * one membership each (member, granted) pair really has: INHERIT, SET and ADMIN hold if any grant gives them, so an
 * extra option on any grantor still fails the comparison; a pair with no row stays absent, so a missing grant does too.
 * The order of first appearance is kept.
 */
export function foldRoleMemberships(
  rows: readonly RoleMembershipRow[]
): RoleMembershipRow[] {
  const folded = new Map<string, RoleMembershipRow>();
  for (const row of rows) {
    const key = JSON.stringify([row.member, row.granted]);
    const seen = folded.get(key);
    folded.set(
      key,
      seen
        ? {
            ...seen,
            admin_option: seen.admin_option || row.admin_option,
            inherit_option: seen.inherit_option || row.inherit_option,
            set_option: seen.set_option || row.set_option,
          }
        : { ...row }
    );
  }
  return [...folded.values()];
}
