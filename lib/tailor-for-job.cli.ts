// CLI for tailorForJob — paste a job description in, get an HTML file out.
//
//   set -a; source .env.local; set +a          # ANTHROPIC_API_KEY
//   npx vite-node --config vitest.config.ts lib/tailor-for-job.cli.ts -- jd.txt
//   cat jd.txt | npx vite-node --config vitest.config.ts lib/tailor-for-job.cli.ts -- -
//
// vite-node rather than node, because this imports lib/model-call.ts and the
// `@/` alias — and `npx tsx` is not installed in this repo (see CLAUDE.md).
// vitest.config.ts is where the alias is declared, hence --config.
//
// No billing scope is set, so lib/model-call's `routing()` falls through to
// ANTHROPIC_API_KEY and the platform default model. That fallback is a
// documented, intentional path — the same one db/apply-schema and one-off
// scripts take — not a hole this script is sneaking through.
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tailorForJob, TailorResponseError } from "@/lib/tailor-for-job";

/** Where the rendered page looks for styles.css / doc-page.js, relative to the
 *  written file. Absolute so the HTML opens correctly from anywhere on disk. */
const DESIGN_BASE = path.resolve(process.cwd(), "public/resume-design");

function usage(): never {
  console.error(
    [
      "usage: tailor-for-job.cli.ts <jd-file | -> [--out <file.html>]",
      "",
      "  <jd-file>   a file holding the job description text; - reads stdin",
      "  --out       where to write the résumé (default: ./tailored-<jd-name>.html)",
    ].join("\n")
  );
  process.exit(2);
}

function readJd(source: string): string {
  if (source === "-") return readFileSync(0, "utf8");
  return readFileSync(source, "utf8");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith("--"));
  const source = positional[0];
  if (!source) usage();

  const outFlag = argv.indexOf("--out");
  const stem = source === "-" ? "stdin" : path.basename(source).replace(/\.[^.]+$/, "");
  const out =
    outFlag !== -1 && argv[outFlag + 1] ? argv[outFlag + 1] : path.resolve(`tailored-${stem}.html`);

  const jd = readJd(source);
  const result = await tailorForJob(jd, { render: { base: DESIGN_BASE } });
  writeFileSync(out, result.html, "utf8");

  const strength = result.coverage.strength;
  console.log("");
  console.log(`  wrote        ${out}`);
  console.log(`  themes       ${result.themes.length ? result.themes.join(", ") : "(none)"}`);
  console.log(`  positioning  ${result.positioning ?? "(none)"}`);
  console.log(`  strength     ${strength === null ? "n/a" : `${Math.round(strength * 100)}%`}`);
  console.log(`  gaps         ${result.coverage.gaps.length ? result.coverage.gaps.join(", ") : "(none)"}`);
  console.log(
    `  unsupported  ${result.unsupported.length ? result.unsupported.join("; ") : "(none)"}`
  );
  console.log(`  reasoning    ${result.reasoning}`);
  if (result.warning) {
    console.log("");
    console.log(`  ⚠ WARNING    ${result.warning}`);
  }
  console.log("");
}

main().catch((err) => {
  // A TailorResponseError is the designed loud failure — print what the model
  // actually said, since that is the only way to tell a flaky answer from a
  // prompt that needs fixing. Anything else is a real crash and keeps its stack.
  if (err instanceof TailorResponseError) {
    console.error(`\n  tailoring failed: ${err.message}\n`);
    err.responses.forEach((r, i) => console.error(`  --- model response ${i + 1} ---\n${r}\n`));
  } else {
    console.error(err);
  }
  process.exit(1);
});
