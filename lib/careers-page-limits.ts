// Careers pages and public job-board feeds can contain several MiB of data.
// Share their allowance across board discovery, feeds and HTML extraction, without
// increasing ordinary posting, robots.txt, or other outbound download limits.
export const CAREERS_PAGE_MAX_BYTES = 8 * 1024 * 1024;
