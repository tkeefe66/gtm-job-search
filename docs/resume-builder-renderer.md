# Resume builder renderer version 1

New builder PDFs use Playwright 1.63.0 and its pinned Chromium revision. There is no hosted rendering service, subscription, remote font request, user HTML, or arbitrary URL input.

## Local verification

Run `npm ci` then `npx playwright install chromium`. Linux machines additionally need `npx playwright install --with-deps chromium --only-shell`. Run `RESUME_RENDER_INTEGRATION=1 npx vitest run lib/resume-builder-render.test.ts` for real Chromium tests; normal `npm test` runs the fast HTML checks and explicitly skips browser tests. Optionally set `RESUME_RENDER_ARTIFACTS=/absolute/scratch/path` to retain the synthetic dense PDFs for visual inspection.

## Production image

`railway.toml` selects `Dockerfile.web`. The image installs Chromium and its system libraries during build using the lockfile-pinned Playwright package. It keeps `/app/scripts/resume-builder-render-worker.mjs`, `/app/assets/resume-builder/v1`, the production dependencies, and `/ms-playwright` in the runtime image. `next start` runs from `/app`, as required by the worker path. The image runs as the unprivileged `node` user. `Dockerfile.web.dockerignore` excludes local environment files and unrelated checkout artifacts. Do not enable standalone Next output without also copying these worker/assets/browser/dependency paths.

This session does not deploy the image. Before enabling the capability for ordinary tenants, build the image and verify a PDF from the exact deployed commit, including the browser install and font assets. Missing Chromium fails closed with an operator installation message; no legacy renderer or system font fallback is used. A disabled builder does not launch Chromium.

## Bounds and integrity

The web process launches a child worker, never a browser itself. One worker may run per web process with at most three waiting requests. Queue wait and worker execution each have a 25 second deadline. Timeout kills the worker's whole process group, including Chromium on Linux/macOS. The worker has a 256 MB Node heap limit, caps incoming payload at 8 MB, and the parent caps result at 16 MB. CPU use is bounded by the wall deadline and one active worker; container memory/CPU limits should also be configured before enabling broad access. This is a per-process queue, not a global cluster quota. The database document render state is maintained by builder actions independently of this transient bounded queue.

Only complete server-generated HTML enters the worker. The request environment is reduced to PATH/HOME/TMPDIR and the operator browser-cache location: database and API secrets are not passed. Browser context is offline, aborts all network routes, and blocks service workers; HTML CSP additionally denies connections, images, forms and external scripts. Fonts are inline bundled data. There is no remote executable/font override.

Pagination waits for both font weights, then places heading plus first bullet groups, and remaining whole bullets, into fixed Letter/A4 page boxes. No font-size, margin, scale or spacing adjustment occurs to make content fit. Each text range must be contained in its assigned region; flow blocks must not overlap. A single oversized block is rejected. Actual PDF page count is read independently with unpdf and must match measured page count and the chosen one/two-page maximum. Empty sections are omitted; sourceText is retained for review but intentionally not printed. Sidebar uses contact/summary in the narrow first-page column; section order stays intact in the main column, and continuation pages retain the column grid without repeating contact information.

The browser preview uses exactly the same font/CSS/pagination HTML in an iframe with `sandbox="allow-scripts"` and no same-origin permission. It is advisory. Server exports and candidate acceptance must use `renderBuilderPdf` on tenant-owned, revision-checked snapshots. Do not trust browser-submitted HTML or preview fit.

## Fonts and saved version stability

Version 1 bundles Noto Sans and Noto Serif variable TTF fonts from the Google Fonts repository, under the SIL Open Font License 1.1. Complete redistribution notices are in `assets/resume-builder/v1/OFL-NotoSans.txt` and `OFL-NotoSerif.txt`. `scripts/build-resume-font-assets.mjs` generates the inline client-safe base64 font module from those exact files. Both original files and generated module are committed, making previews independent of external URLs. Supported characters are the font's actual cmap; export refuses unsupported characters with their Unicode code point. It never falls back silently to a system font.

Sources: https://github.com/google/fonts/tree/main/ofl/notosans and https://github.com/google/fonts/tree/main/ofl/notoserif. Playwright browser installation: https://playwright.dev/docs/browsers. PDF print behavior: https://playwright.dev/docs/api/class-page#page-pdf.

`templateVersion: "1"` is explicit in new saved designs; missing version supports initial version-1 drafts only. Unknown versions fail closed. Once shipped, preserve the version-1 CSS, pagination, fonts and browser compatibility behavior; future layout changes require a new registry version and explicit migration. Existing saved PDFs retain their bytes.
