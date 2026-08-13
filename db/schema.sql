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
