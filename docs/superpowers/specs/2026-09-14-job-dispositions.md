# Job dispositions and source quality

Approved in conversation: start from launch; no historical review or rewriting. Five dispositions: Not interested, Not a fit, Job not found, Posting closed, Duplicate. Listing inaccurate is excluded. Not a fit may carry pay/location/seniority/responsibilities/other as an optional reason. No automatic source exclusions.

Keep pipeline statuses separate from dispositions. A disposition files the role into a terminal status compatible with tenant configuration. Job not found must not use Posting Closed. Record original source URL, discovery method, date, and user versus automation. Automatic low-fit filing is Not a fit, never personal rejection. Reopening clears the current disposition but preserves events. Old rows changed after launch are a separate legacy cohort. No backfill of old dispositions.

New source records capture every future accepted role, including roles dead at import. An atomic database trigger records status/disposition changes across manual and automatic write paths. New tables have forced tenant RLS. Source records retain original attribution after relinking and snapshot title/company for reporting. Counts are unique roles; repeat transitions must not inflate percentages. Reporting shows total newly sourced roles, current outcomes, human versus automated feedback, and legacy feedback separately. Group BuiltIn regional domains but preserve employer tenant identities on shared ATS hosts. Unknown provenance is labeled rather than invented.

UI extends existing single and bulk role controls with the five dispositions, optional fit reason, current disposition display, and a Source quality page linked from Roles. Report offers source groups and underlying roles with safe links and actor/date/evidence. Empty report explains tracking starts now.

Validate pure mapping and grouping, real SQL atomicity/RLS/no backfill/cohort/reopen behavior, unauthenticated actions, full build/test, and rendered UI. Deploy only after verifying a concrete release and migration.
