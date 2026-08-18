-- Canonical schema for the GTM Job Search app on Railway Postgres.
-- Reconstructed from lib/types.ts and the server actions (the original
-- supabase/migrations were incomplete — jobs was missing ~13 columns and
-- watchlist / discovered_roles / insights_cache had no migrations at all).
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- Tracked job pipeline.
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  role_title text not null,
  status text not null default 'New',
  seniority text,
  department text,
  location text,
  job_url text,
  careers_url text,
  category text,
  raised text,
  stage text,
  traction text,
  key_skills text,
  salary_range text,
  source text,
  notes text,
  fit_score integer check (fit_score between 1 and 5),
  fit_summary text,
  recruiter_name text,
  recruiter_email text,
  recruiter_company text,
  recruiter_notes text,
  company_url text,
  company_description text,
  arr text,
  exit_signal text,
  backer text,
  ic_flag boolean default false,
  added_date date default current_date,
  applied_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Companies the user is watching (upserted on company).
create table if not exists watchlist (
  id uuid primary key default gen_random_uuid(),
  company text not null unique,
  tagline text,
  raised text,
  stage text,
  lead_investor text,
  founded text,
  traction text,
  careers_url text,
  category text,
  headquarters text,
  added_at timestamptz default now(),
  last_checked_at timestamptz
);

-- Cached role-search results per company (upserted on company).
create table if not exists discovered_roles (
  id uuid primary key default gen_random_uuid(),
  company text not null unique,
  roles jsonb not null default '[]',
  fetched_at timestamptz default now()
);

-- Cached Discover funding results per (date_range, search_term).
create table if not exists discovered_startups (
  id uuid primary key default gen_random_uuid(),
  date_range text not null,
  search_term text default '',
  startups jsonb not null default '[]',
  fetched_at timestamptz default now(),
  unique (date_range, search_term)
);

-- Single-row-ish cache of the latest pipeline insights.
create table if not exists insights_cache (
  id uuid primary key default gen_random_uuid(),
  insights jsonb not null,
  fetched_at timestamptz default now()
);

-- Where a role was originally found, kept when job_url is replaced with the
-- employer's own posting. Without it, relinking is lossy: a wrong slug guess
-- would overwrite the only link we ever had with no way back.
alter table jobs add column if not exists source_url text;

-- A role that was ALREADY dead when ingest first saw it — checkJobUrl returned
-- a definitive 404/410 at save time, so it was stored closed and never scored.
-- It is noise, not history: the user never had the option to apply. Hidden from
-- the table and both tiles by getJobs, but never DELETED — ingestRoles dedupes
-- against every row regardless of status, so deleting these makes the next Find
-- Roles run re-find and re-insert them permanently.
--
-- Deliberately narrower than the condition that CLOSES a role: `unlisted` (the
-- employer's guessed board does not list the title) also closes, but does not
-- hide. See lib/ingest-roles.ts.
--
-- This alter must stay here so a fresh install has the column, but it is not
-- the mechanism for an EXISTING database: that is
-- db/migrations/008_never_live.sql, run through db/migrate.mjs. See that
-- file's comment for why apply-schema.mjs is the wrong tool for an existing
-- database.
alter table jobs add column if not exists never_live boolean not null default false;

-- Tracking: watchlist rows are crawled on a recurring schedule until the user
-- stops tracking them. Untracking sets tracking_enabled = false rather than
-- deleting, so crawl history survives and the company does not resurface in
-- Discover as though newly found.
alter table watchlist add column if not exists tracking_enabled     boolean not null default true;
alter table watchlist add column if not exists crawl_method         text;
alter table watchlist add column if not exists crawl_interval_days  integer not null default 7;
alter table watchlist add column if not exists last_crawl_status    text;
alter table watchlist add column if not exists last_crawl_error     text;
alter table watchlist add column if not exists consecutive_failures integer not null default 0;
alter table watchlist add column if not exists source               text;

-- One row per crawl attempt. Without this, a silently failing crawler is
-- indistinguishable from a company that genuinely is not hiring.
-- role_titles holds the normalized titles seen on that run, so stale-posting
-- closure can compare consecutive successful runs.
create table if not exists crawl_runs (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  method       text,
  roles_found  integer not null default 0,
  new_roles    integer not null default 0,
  role_titles  jsonb not null default '[]',
  status       text not null,
  error        text
);
create index if not exists crawl_runs_company_idx on crawl_runs (company, started_at desc);

-- Cached role-first search results per (family, search_term). Same
-- cache-first pattern as discovered_startups and insights_cache.
create table if not exists role_searches (
  id          uuid primary key default gen_random_uuid(),
  family      text not null,          -- 'title' | 'stack'
  search_term text not null default '',
  roles       jsonb not null default '[]',
  fetched_at  timestamptz default now(),
  unique (family, search_term)
);

-- User-editable search criteria and scoring inputs. One row per setting;
-- a missing row means "use the shipped default" (see lib/search-criteria.ts),
-- which is also what makes "reset to defaults" a plain DELETE.
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Auth (sub-project B). Additive and idempotent: these tables are unused until
-- the Auth.js wiring lands, so applying this early is safe.
--
-- Shapes follow @auth/pg-adapter, which issues quoted camelCase identifiers
-- ("userId", "sessionToken", "emailVerified", "providerAccountId") — hence the
-- quoted columns in an otherwise snake_case schema. Renaming them to match house
-- style would break the adapter's SQL, which is not configurable.

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  email         text not null unique,
  "emailVerified" timestamptz,
  image         text,

  -- IDENTITY IS (provider, sub), NOT email. Google's sub is permanent; the email
  -- is a mutable attribute a Workspace admin can reassign to a new hire, who
  -- would otherwise match this row and inherit the previous holder's pipeline,
  -- fit brain and stored API key. Nullable so the seeded admin row can be
  -- claimed once by its first verified sign-in. See lib/auth-policy.ts.
  google_sub    text unique,

  -- Only 'active' is allowed in; everything else, INCLUDING an unrecognised
  -- value, is refused (accessFor fails closed). 'pending' is what the waitlist
  -- lists — the row must be written even though no session is issued, or the
  -- admin has nothing to approve.
  status        text not null default 'pending',
  role          text not null default 'user',

  created_at    timestamptz not null default now(),
  approved_at   timestamptz,
  approved_by   uuid references users(id),
  suspended_at  timestamptz
);
create index if not exists users_status_idx on users (status);

create table if not exists accounts (
  id                  uuid primary key default gen_random_uuid(),
  "userId"            uuid not null references users(id) on delete cascade,
  type                text not null,
  provider            text not null,
  "providerAccountId" text not null,
  refresh_token       text,
  access_token        text,
  expires_at          bigint,
  token_type          text,
  scope               text,
  id_token            text,
  session_state       text,
  unique (provider, "providerAccountId")
);

create table if not exists sessions (
  id             uuid primary key default gen_random_uuid(),
  "sessionToken" text not null unique,
  "userId"       uuid not null references users(id) on delete cascade,
  expires        timestamptz not null,

  -- The ABSOLUTE lifetime cap Auth.js does not provide. It rolls `expires`
  -- forward on every request, so an actively-used stolen cookie never dies —
  -- the attacker's own traffic keeps renewing it. Only a bound measured from
  -- created_at stops that, and created_at must NEVER be advanced. Enforced in a
  -- wrapper around the adapter's getSessionAndUser (the `session` callback
  -- cannot deny — its return type has no null). See lib/auth-policy.ts.
  created_at     timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions ("userId");

-- Created by the adapter and unused under Google-only sign-in. Kept because the
-- adapter's schema expects it; if email magic links are ever added, revisit the
-- identity rule above first — a magic link authenticates an ADDRESS, which is
-- the mutable thing google_sub exists to avoid trusting.
create table if not exists verification_token (
  identifier text not null,
  token      text not null,
  expires    timestamptz not null,
  primary key (identifier, token)
);
