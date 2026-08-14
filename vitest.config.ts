import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `app/**` as well as `lib/**`. A `"use server"` module was assumed
    // untestable here for a long time and that assumption was wrong: an action
    // is an async function, and one whose guard returns before it queries
    // anything needs no database at all — see app/actions/settings.test.ts,
    // which pins the second bound on the compensation stamp in milliseconds.
    // Actions that DO call Claude or the database still are not tested; the
    // rule is "does this path reach out", not "which folder is it in".
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
