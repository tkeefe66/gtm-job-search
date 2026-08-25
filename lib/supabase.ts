// Railway Postgres data layer.
//
// This file keeps the name `supabase` and a Supabase-compatible chainable API
// so the server actions in app/actions/* didn't have to change. It is NOT
// Supabase — it's a thin query builder over node-postgres (`pg`) talking to a
// managed Railway Postgres database via DATABASE_URL.
//
// Supported surface (all that the app uses):
//   .from(table)
//   .select(cols?) .insert(obj) .update(obj) .upsert(obj, { onConflict }) .delete()
//   .eq(col, val) .neq(col, val) .order(col, { ascending }) .limit(n)
//   .single() .maybeSingle()
// Awaiting any builder resolves to { data, error } just like supabase-js.

import { Pool, types } from "pg";
import { aggregateCauses } from "@/lib/write-failure";

/**
 * Recovers the real cause of a failure whose `message` is empty, as a LOG LINE
 * only.
 *
 * pg rejects with an `AggregateError` — whose `message` is the empty string —
 * whenever a host resolves to more than one address and every connection
 * attempt fails. The actual per-address errors are on `.errors[]`, and this
 * catch site is the only place in the process that still has them: every layer
 * above sees `{ message: "" }` and nothing else.
 *
 * Deliberately does NOT fill in `message`. Inventing text in the transport is
 * what lib/write-failure.ts's doctrine forbids, and it would also erase the
 * empty-message case that every presence check downstream is written to
 * survive. So the returned error is unchanged and only the log gains anything —
 * behavior is identical, diagnostics are not.
 */
// Exported ONLY so the doctrine above can be pinned by a test. A mutant that
// fills `message` from aggregateCauses(e) — which looks like an improvement —
// would silently neuter every presence check in the codebase by making the
// empty message impossible, and nothing else in the suite would notice.
export function describeThrown(e: unknown): { message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (!message) {
    const causes = aggregateCauses(e);
    console.error(
      `supabase: the driver failed with no message — the database is unreachable ` +
        `entirely, not one failed statement. ` +
        (causes.length > 0
          ? `Underlying causes: ${causes.join("; ")}`
          : `No underlying causes were attached.`)
    );
  }
  return { message };
}

// Return timestamps as ISO strings (parity with Supabase/PostgREST). The app
// treats these as strings, e.g. `new Date(iso)` in components.
types.setTypeParser(1184, (v) => (v == null ? null : new Date(v).toISOString())); // timestamptz
types.setTypeParser(1114, (v) => (v == null ? null : new Date(v + "Z").toISOString())); // timestamp
types.setTypeParser(1082, (v) => v); // date -> keep raw 'YYYY-MM-DD' string (parity, no tz shift)

const connectionString =
  process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || "";

// Reuse a single pool across hot reloads / lambda invocations.
const globalForPg = globalThis as unknown as { __pgPool?: Pool };

/**
 * The pool itself, for Auth.js's Postgres adapter.
 *
 * The adapter takes a `pg.Pool` and issues its own SQL directly — it cannot be
 * routed through the query builder below. Handing it THIS pool rather than a
 * second one keeps every connection this process opens under one `max`, so auth
 * traffic and app traffic contend for a bounded set instead of two independent
 * ones that together exceed what the database allows.
 */
export function authPool(): Pool {
  return getPool();
}

function getPool(): Pool {
  if (!globalForPg.__pgPool) {
    globalForPg.__pgPool = new Pool({
      connectionString,
      // Railway's internal network needs no SSL; the public proxy uses
      // sslmode=require when present in the URL.
      ssl: /sslmode=require/.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined,
      max: 5,
    });
  }
  return globalForPg.__pgPool;
}

type Row = Record<string, unknown>;
interface Result<T> {
  // `data` is intentionally permissive (`any` by default) to match supabase-js,
  // whose response typing let the action code do data.length / data[0] / casts.
  data: T;
  error: { message: string } | null;
}

function ident(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

// jsonb columns receive JS objects/arrays — stringify them. Dates -> ISO.
function encode(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

type Op = "select" | "insert" | "update" | "delete" | "upsert";

/**
 * Tables whose rows belong to a tenant.
 *
 * A query against any of these MUST carry a tenant, and the builder refuses to
 * construct one that does not — see `from()` below. That refusal is the point:
 * the alternative is 21 hand-written `.eq("tenant_id", …)` call sites where a
 * single omission is a silent cross-tenant read that looks like working
 * software.
 *
 * Adding a tenant-scoped table means adding it here. A table absent from this
 * list is treated as GLOBAL, so the failure mode of forgetting is "shared data",
 * which is why lib/supabase.test.ts pins this list against db/schema.sql.
 */
export const TENANT_TABLES = [
  "jobs",
  "watchlist",
  "app_settings",
  // Added by migration 002. These look like world caches and are not: their
  // contents are produced by prompts built from ONE tenant's criteria, and their
  // keys never contained those criteria.
  "discovered_roles",
  "discovered_startups",
  "role_searches",
  "crawl_runs",
  // Added by migration 015. tenant_id is declared inline in CREATE TABLE,
  // not via ALTER TABLE ... ADD COLUMN, so it is invisible to
  // lib/supabase.test.ts's retrofit-pattern regex — added here by hand.
  "tailored_resumes",
] as const;

export function isTenantTable(table: string): boolean {
  return (TENANT_TABLES as readonly string[]).includes(table);
}


/**
 * Runs one statement with `app.tenant_id` set for exactly that statement.
 *
 * STATEMENT-SCOPED, not request-scoped, and the difference is load-bearing. A
 * transaction held for a whole request would:
 *   - cap the app at `max` concurrent users (5), because each holds a connection;
 *   - sit `idle in transaction` across 60-120s Claude calls in the crawl and
 *     ingest paths;
 *   - serialise the `Promise.all` fan-outs those paths are built on, since a
 *     single pg client queues statements;
 *   - and convert this codebase's log-and-continue error model into 25P02
 *     cascades, where one failed row aborts every statement after it.
 * The cost is two extra round trips per query. That is the right trade here.
 *
 * `SET LOCAL` cannot take a bind parameter, so the naive version interpolates a
 * tenant id into the one statement that decides isolation. `set_config(..., true)`
 * is the parameterised form — `true` meaning local to this transaction, which is
 * what stops the value leaking to the next request that borrows this pooled
 * connection.
 */
export async function tenantTransaction<R>(
  tenantId: string,
  run: (q: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }>) => Promise<R>
): Promise<R> {
  return withTenant(tenantId, async (client) => {
    return run((text, values = []) =>
      client.query(text, values) as unknown as Promise<{ rows: Row[] }>
    );
  });
}

/**
 * The narrow multi-statement exception.
 *
 * Everything else is statement-scoped on purpose — a transaction held across a
 * request caps concurrency at the pool size and sits idle across 60-120s Claude
 * calls. This exists for the one place that genuinely needs two writes to
 * succeed or fail together: reserving against a daily AND a monthly budget,
 * where committing one without the other would let a burst through or charge for
 * a call that never ran.
 *
 * Keep the block SHORT and never put an external API call inside it.
 */
async function withTenant<R>(
  tenantId: string,
  run: (client: import("pg").PoolClient) => Promise<R>
): Promise<R> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);

    // THE ASSERTION. An RLS denial is not an error — the query succeeds and
    // returns zero rows, which is a plausible answer for a new tenant. Every
    // detection mechanism in this codebase (describeWriteFailure, the
    // presence-not-truthiness rule) finds failures that were REPORTED, and this
    // one reports nothing. Reading the GUC back converts the entire
    // silent-empty class into the loud-error class the rest of the code already
    // handles.
    const { rows } = await client.query<{ v: string | null }>(
      "select nullif(current_setting('app.tenant_id', true), '') as v"
    );
    if (rows[0]?.v !== tenantId) {
      throw new Error(
        `tenant scope did not take effect (wanted ${tenantId}, got ${rows[0]?.v ?? "unset"}) — ` +
          `refusing to run a query that would silently return no rows`
      );
    }

    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    // Always released, including on the assertion above. A leaked client is a
    // permanent loss of 1/5th of the pool.
    client.release();
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
class QueryBuilder<T = any> implements PromiseLike<Result<T>> {
  private op: Op = "select";
  private columns = "*";
  private payload: Row | null = null;
  private conflict: string | null = null;
  private filters: { col: string; op: string; val: unknown }[] = [];
  private orders: { col: string; ascending: boolean }[] = [];
  private limitN: number | null = null;
  private rowMode: "many" | "single" | "maybe" = "many";

  /**
   * `tenantId` is null ONLY for global tables. For a tenant table the builder
   * cannot be constructed without one (see `from()`), so by the time a query is
   * built the scope is guaranteed rather than hoped for.
   */
  constructor(private table: string, private tenantId: string | null = null) {}

  select(cols = "*"): this {
    this.columns = cols || "*";
    // On a mutation, .select() just requests the returned rows (we always
    // RETURNING *), so don't override the op.
    return this;
  }
  insert(obj: Row): this {
    this.op = "insert";
    this.payload = obj;
    return this;
  }
  update(obj: Row): this {
    this.op = "update";
    this.payload = obj;
    return this;
  }
  upsert(obj: Row, opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = obj;
    this.conflict = opts?.onConflict ?? null;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: "=", val });
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push({ col, op: "<>", val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orders.push({ col, ascending: opts?.ascending ?? true });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  single(): this {
    this.rowMode = "single";
    return this;
  }
  maybeSingle(): this {
    this.rowMode = "maybe";
    return this;
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((value: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private build(): { text: string; values: unknown[] } {
    // Applied HERE rather than at the call sites, so it cannot be forgotten by
    // one of them. A select/update/delete gains the predicate; an insert/upsert
    // gains the column, because a row written without an owner is unreachable
    // afterwards by every scoped read — invisible rather than wrong.
    if (this.tenantId !== null) {
      if (this.op === "insert" || this.op === "upsert") {
        this.payload = { tenant_id: this.tenantId, ...(this.payload ?? {}) };
      }
      if (this.op !== "insert") {
        this.filters = [
          { col: "tenant_id", op: "=", val: this.tenantId },
          ...this.filters,
        ];
      }
    }
    const t = ident(this.table);
    const values: unknown[] = [];
    const ph = (v: unknown) => {
      values.push(encode(v));
      return "$" + values.length;
    };
    const where = () =>
      this.filters.length
        ? " where " +
          this.filters
            .map((f) => `${ident(f.col)} ${f.op} ${ph(f.val)}`)
            .join(" and ")
        : "";
    const orderBy = () =>
      this.orders.length
        ? " order by " +
          this.orders
            .map((o) => `${ident(o.col)} ${o.ascending ? "asc" : "desc"}`)
            .join(", ")
        : "";
    const limit = () => (this.limitN != null ? ` limit ${Number(this.limitN)}` : "");

    if (this.op === "select") {
      return {
        text: `select ${this.columns} from ${t}${where()}${orderBy()}${limit()}`,
        values,
      };
    }
    if (this.op === "delete") {
      return { text: `delete from ${t}${where()} returning *`, values };
    }
    if (this.op === "insert" || this.op === "upsert") {
      const row = this.payload ?? {};
      const keys = Object.keys(row).filter((k) => row[k] !== undefined);
      const cols = keys.map(ident).join(", ");
      const vals = keys.map((k) => ph(row[k])).join(", ");
      let text = `insert into ${t} (${cols}) values (${vals})`;
      if (this.op === "upsert") {
        const target = (this.conflict || "")
          .split(",")
          .map((s) => ident(s.trim()))
          .join(", ");
        const updates = keys
          .map((k) => `${ident(k)} = excluded.${ident(k)}`)
          .join(", ");
        text += ` on conflict (${target}) do update set ${updates}`;
      }
      return { text: text + " returning *", values };
    }
    // update
    const row = this.payload ?? {};
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    const sets = keys.map((k) => `${ident(k)} = ${ph(row[k])}`).join(", ");
    return { text: `update ${t} set ${sets}${where()} returning *`, values };
  }

  private async execute(): Promise<Result<T>> {
    try {
      const { text, values } = this.build();
      // A tenant-scoped query runs with the GUC set so Postgres policies apply;
      // a global one goes straight to the pool, unchanged.
      const res = this.tenantId
        ? await withTenant(this.tenantId, (c) => c.query(text, values))
        : await getPool().query(text, values);
      if (this.rowMode === "single") {
        if (res.rows.length === 0) {
          return { data: null as T, error: { message: "No rows returned" } };
        }
        return { data: res.rows[0] as T, error: null };
      }
      if (this.rowMode === "maybe") {
        return { data: (res.rows[0] ?? null) as T, error: null };
      }
      return { data: res.rows as T, error: null };
    } catch (e) {
      return { data: null as T, error: describeThrown(e) };
    }
  }
}

export const supabase = {
  /**
   * Global tables only. Throws for a tenant-scoped table rather than returning
   * an unscoped builder — an unscoped read of `jobs` is every tenant's pipeline,
   * and it would return rows and look correct.
   */
  from(table: string) {
    if (isTenantTable(table)) {
      throw new Error(
        `supabase.from("${table}") is tenant-scoped — use supabase.forTenant(id).from("${table}")`
      );
    }
    return new QueryBuilder(table);
  },

  /** Scoped accessor. Every query it builds carries the tenant automatically. */
  forTenant(tenantId: string) {
    if (!tenantId) {
      // An empty tenant would produce `tenant_id = ''`, which matches nothing
      // and reads as "this tenant has no data" — the silent-empty failure this
      // whole design exists to avoid.
      throw new Error("supabase.forTenant() requires a tenant id");
    }
    return {
      from(table: string) {
        return new QueryBuilder(table, isTenantTable(table) ? tenantId : null);
      },
    };
  },
};

/**
 * Escape hatch for queries the chainable builder cannot express (interval
 * arithmetic, IN lists, ORDER BY ... NULLS FIRST). Returns the same
 * { data, error } shape as the builder so callers handle errors identically.
 */
/**
 * Escape hatch for SQL the builder cannot express.
 *
 * `tenantId` is OPTIONAL only because the auth adapter and the migration ledger
 * genuinely have no tenant. Every call that touches an app table must pass one:
 * raw SQL is invisible to the builder's registry, so this parameter is the only
 * thing that puts a policy in front of it.
 */
export async function rawQuery<T = Row>(
  text: string,
  values: unknown[] = [],
  tenantId?: string
): Promise<{ data: T[]; error: { message: string } | null }> {
  try {
    const res = tenantId
      ? await withTenant(tenantId, (c) => c.query(text, values))
      : await getPool().query(text, values);
    return { data: res.rows as T[], error: null };
  } catch (e) {
    return { data: [], error: describeThrown(e) };
  }
}
