// lib/saved-resume-purge.ts
//
// The retention purge, with its dependencies injected so the two behaviours
// that matter — enumeration covers every tenant, and one tenant's failure does
// not abort the rest — are testable as pure logic.
//
// THE TRAP THIS MODULE EXISTS TO AVOID: runAsTenant() sets an AsyncLocalStorage
// value, NOT the Postgres GUC. app_rw is nobypassrls, so a tenant-table
// statement with no tenant set matches ZERO ROWS AND RETURNS NO ERROR. The
// tenant id must be passed to rawQuery as its third argument. This follows
// getBudgetOverview (app/actions/admin.ts:159-166, :205-207), which passes it
// straight through and uses no runAsTenant at all — not crawl-next, which needs
// runAsTenant only because it calls server actions that resolve their own
// tenant.
import { rawQuery } from "@/lib/supabase";
import { EXPIRED_PREDICATE } from "@/lib/resume-retention";

export interface PurgeReport {
  deleted: number;
  tenants: number;
  failed: number;
  oldestSurviving: string | null;
  error?: string;
}

export interface PurgeDeps {
  listTenants: () => Promise<{ tenantIds: string[]; error?: string }>;
  purgeTenant: (tenantId: string) => Promise<{ deleted: number; error?: string }>;
  countTenant?: (tenantId: string) => Promise<number>;
  oldestSurviving: () => Promise<string | null>;
  dryRun?: boolean;
}

export async function runPurge(deps: PurgeDeps): Promise<PurgeReport> {
  const listed = await deps.listTenants();
  if (listed.error !== undefined) {
    return { deleted: 0, tenants: 0, failed: 0, oldestSurviving: null, error: listed.error };
  }

  let deleted = 0;
  let failed = 0;
  const ids = listed.tenantIds;
  // Indexed loop, not for...of: the build typechecks at ES5.
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      if (deps.dryRun) {
        deleted += deps.countTenant ? await deps.countTenant(id) : 0;
      } else {
        const res = await deps.purgeTenant(id);
        if (res.error !== undefined) {
          // One tenant's failure is logged and skipped, never fatal to the
          // others — the rule crawl-next applies to a failed candidate read.
          console.error("saved-resume purge failed for a tenant:", res.error);
          failed += 1;
        } else {
          deleted += res.deleted;
        }
      }
    } catch (err) {
      console.error("saved-resume purge threw for a tenant:", err);
      failed += 1;
    }
  }

  return {
    deleted,
    tenants: ids.length,
    failed,
    oldestSurviving: await deps.oldestSurviving(),
  };
}

/** The real dependencies. Every one passes the tenant id to rawQuery. */
export function liveDeps(
  listTenants: PurgeDeps["listTenants"],
  dryRun: boolean
): PurgeDeps {
  return {
    listTenants,
    dryRun,
    purgeTenant: async (tenantId) => {
      const { data, error } = await rawQuery<{ id: string }>(
        "delete from saved_resumes where tenant_id = $1 and " +
          EXPIRED_PREDICATE +
          " returning id",
        [tenantId],
        tenantId
      );
      if (error) return { deleted: 0, error: error.message };
      return { deleted: data.length };
    },
    countTenant: async (tenantId) => {
      const { data } = await rawQuery<{ n: string }>(
        "select count(*)::text as n from saved_resumes where tenant_id = $1 and " +
          EXPIRED_PREDICATE,
        [tenantId],
        tenantId
      );
      return data.length > 0 ? parseInt(data[0].n, 10) : 0;
    },
    // Deliberately unscoped and therefore expected to return nothing under RLS;
    // it is a diagnostic, not a read of anyone's data. Reported as null when the
    // policy filters it, which is correct: the platform cannot see tenant rows.
    oldestSurviving: async () => {
      const { data } = await rawQuery<{ oldest: string | null }>(
        "select min(expires_at)::text as oldest from saved_resumes"
      );
      return data.length > 0 ? data[0].oldest : null;
    },
  };
}
