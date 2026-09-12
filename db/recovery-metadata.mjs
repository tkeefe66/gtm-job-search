import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
export const identifier = name => '"' + name.replaceAll('"', '""') + '"';
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
// Counts share pg_dump's exported snapshot. No row contents are returned.
export async function recoveryMetadata(client) {
  const { rows: tables } = await client.query(`SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`);
  for (const table of tables) table.count = (await client.query(`SELECT count(*)::text AS count FROM public.${identifier(table.name)}`)).rows[0].count;
  const queries = {
    columns: `SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,is_identity,is_generated FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`,
    constraints: `SELECT c.relname AS table_name,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,k.conname`,
    indexes: `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
    policies: `SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`,
    grants: `SELECT table_name,grantee,privilege_type,is_grantable FROM information_schema.table_privileges WHERE table_schema='public' AND grantee <> (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename=table_name) ORDER BY table_name,grantee,privilege_type,is_grantable`,
    columnGrants: `SELECT table_name,column_name,grantee,privilege_type,is_grantable FROM information_schema.column_privileges WHERE table_schema='public' AND grantee <> (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename=table_name) ORDER BY table_name,column_name,grantee,privilege_type,is_grantable`,
    functions: `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') ORDER BY p.proname,arguments`,
  };
  const result = { tables };
  for (const [key,sql] of Object.entries(queries)) result[key] = (await client.query(sql)).rows;
  return result;
}
export function assertMetadata(expected, actual) {
  for (const key of Object.keys(actual)) if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) throw new Error(`Restored ${key} differ from artifact manifest`);
}
