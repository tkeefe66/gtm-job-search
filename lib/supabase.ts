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

// Return timestamps as ISO strings (parity with Supabase/PostgREST). The app
// treats these as strings, e.g. `new Date(iso)` in components.
types.setTypeParser(1184, (v) => (v == null ? null : new Date(v).toISOString())); // timestamptz
types.setTypeParser(1114, (v) => (v == null ? null : new Date(v + "Z").toISOString())); // timestamp
types.setTypeParser(1082, (v) => v); // date -> keep raw 'YYYY-MM-DD' string (parity, no tz shift)

const connectionString =
  process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || "";

// Reuse a single pool across hot reloads / lambda invocations.
const globalForPg = globalThis as unknown as { __pgPool?: Pool };

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

  constructor(private table: string) {}

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
      const res = await getPool().query(text, values);
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
      return {
        data: null as T,
        error: { message: e instanceof Error ? e.message : String(e) },
      };
    }
  }
}

export const supabase = {
  from(table: string) {
    return new QueryBuilder(table);
  },
};

/**
 * Escape hatch for queries the chainable builder cannot express (interval
 * arithmetic, IN lists, ORDER BY ... NULLS FIRST). Returns the same
 * { data, error } shape as the builder so callers handle errors identically.
 */
export async function rawQuery<T = Row>(
  text: string,
  values: unknown[] = []
): Promise<{ data: T[]; error: { message: string } | null }> {
  try {
    const res = await getPool().query(text, values);
    return { data: res.rows as T[], error: null };
  } catch (e) {
    return {
      data: [],
      error: { message: e instanceof Error ? e.message : String(e) },
    };
  }
}
