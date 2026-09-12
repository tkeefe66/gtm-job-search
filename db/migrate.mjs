// Forward-only upgrades; --dry reads the ledger without creating or changing it.
import { runDatabaseCommand } from "./migration-runner.mjs";
await runDatabaseCommand({ dry: process.argv.includes("--dry") });
