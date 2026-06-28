create extension if not exists "pgcrypto";

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  role_title text not null,
  status text not null default 'Tracking',
  -- status values: 'Tracking' | 'Applied' | 'Interviewing' | 'Offer' | 'Passed'
  seniority text,
  location text,
  job_url text,
  careers_url text,
  category text,
  raised text,
  stage text,
  traction text,
  notes text,
  fit_score integer check (fit_score between 1 and 5),
  fit_summary text,
  added_date date default current_date,
  applied_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
