// Empty database bootstrap. Existing installations must use migrate.mjs.
import { runDatabaseCommand } from "./migration-runner.mjs";
await runDatabaseCommand({ bootstrap: true });
