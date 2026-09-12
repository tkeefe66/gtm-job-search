import { databaseReady } from "@/lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ready = await databaseReady();
  return Response.json({ status: ready ? "ok" : "unavailable" }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
