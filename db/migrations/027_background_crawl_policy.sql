-- Additional sublimits; existing user limits and historical page-health evidence stay intact.
alter table watchlist add column if not exists allow_paid_search boolean not null default false;
alter table watchlist add column if not exists consecutive_model_failures integer not null default 0;
alter table watchlist add column if not exists model_retry_after timestamptz;
alter table watchlist add column if not exists last_attempted_at timestamptz;
alter table watchlist add column if not exists last_successful_check_at timestamptz;
alter table watchlist add column if not exists next_attempt_at timestamptz;
-- last_checked_at historically includes errors, so never copy it into last_successful_check_at.
update watchlist set last_attempted_at = last_checked_at where last_attempted_at is null;
alter table usage_events add column if not exists workload text;
-- Only this historic action proves automatic origin. Other origins remain unknown.
update usage_events set workload = 'background' where workload is null and action = 'crawl';
