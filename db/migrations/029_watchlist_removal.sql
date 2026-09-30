-- Preserve stopped companies and the evidence for each version of their source.
-- Legacy removals keep unknown dates/reasons; never manufacture past intent.
alter table watchlist add column if not exists removal_reason text
  check (removal_reason in ('stopped', 'not_interested', 'source_problem'));
alter table watchlist add column if not exists removed_at timestamptz;
alter table watchlist add column if not exists source_revision integer not null default 0;
alter table crawl_runs add column if not exists source_revision integer not null default 0;
alter table crawl_runs add column if not exists source_url text;

create or replace function watchlist_source_changed() returns trigger language plpgsql as $$
begin
  if new.careers_url is distinct from old.careers_url then
    new.source_revision := old.source_revision + 1;
    new.crawl_method := null;
    new.last_crawl_status := null;
    new.last_crawl_error := null;
    new.consecutive_failures := 0;
    new.failing_since := null;
    new.consecutive_model_failures := 0;
    new.model_retry_after := null;
    new.last_checked_at := null;
    new.last_attempted_at := null;
    new.last_successful_check_at := null;
    new.next_attempt_at := null;
  end if;
  return new;
end $$;
drop trigger if exists watchlist_source_changed on watchlist;
create trigger watchlist_source_changed before update of careers_url on watchlist
  for each row execute function watchlist_source_changed();
