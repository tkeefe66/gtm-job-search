create table if not exists discovered_startups (
  id uuid primary key default gen_random_uuid(),
  date_range text not null,
  search_term text,
  startups jsonb not null default '[]',
  fetched_at timestamptz default now()
);

-- Only keep the latest result per (date_range, search_term) pair.
create unique index if not exists discovered_startups_range_term_idx
  on discovered_startups (date_range, coalesce(search_term, ''));
