// Auth.js's catch-all handler. The callback path Google Cloud Console must
// allowlist is derived from this route: /api/auth/callback/google
//
// `export const { GET, POST } = handlers` — NOT `export { handlers as GET }`,
// which type-checks as a module export and then fails Next's route validation,
// because `handlers` is an object of two functions rather than a handler itself.
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
