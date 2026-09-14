import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), load: vi.fn(), version: vi.fn(), render: vi.fn() }));
vi.mock("@/lib/require-resume-builder", () => ({ requireResumeBuilder: mocks.actor }));
vi.mock("@/lib/resume-builder-store", () => ({ loadBuilderDocument: mocks.load, loadBuilderVersionPdf: mocks.version }));
vi.mock("@/lib/resume-builder-render", () => ({ renderBuilderPdf: mocks.render, BuilderRenderError: class BuilderRenderError extends Error {} }));
import { GET } from "./api/resume-builder/[id]/pdf/route";
import { BuilderRenderError } from "@/lib/resume-builder-render";
const id = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id }) };
beforeEach(() => {
 vi.resetAllMocks();
 mocks.actor.mockResolvedValue({tenantId:"tenant-a"});
 mocks.load.mockResolvedValue({revision:3,title:"My résumé",profile:{name:"Person"},design:{pageLimit:1}});
 mocks.render.mockResolvedValue({pdf:Buffer.from("%PDF-synthetic"),pageCount:1});
});
// Mutation: read or render a document before checking account access.
test("refuses disabled accounts before document reads", async () => {
 mocks.actor.mockRejectedValue(new Error("Resume builder is not enabled for this account."));
 expect((await GET(new Request("http://localhost/pdf?revision=3"),context)).status).toBe(403);
 expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
});
// Mutation: export another revision than the one the user reviewed.
test("refuses changed revision without rendering", async () => {
 expect((await GET(new Request("http://localhost/pdf?revision=2"),context)).status).toBe(409);
 expect(mocks.render).not.toHaveBeenCalled();
});
// Mutation: skip revision recheck after expensive render.
test("refuses a draft changed while rendering", async () => {
 mocks.load.mockResolvedValueOnce({revision:3,title:"Resume",profile:{},design:{}}).mockResolvedValueOnce({revision:4});
 expect((await GET(new Request("http://localhost/pdf?revision=3"),context)).status).toBe(409);
});
// Mutation: trust request HTML or omit tenant scope/private download headers.
test("exports server-owned content as private PDF", async () => {
 const response=await GET(new Request("http://localhost/pdf?revision=3&html=evil"),context);
 expect(response.status).toBe(200); expect(mocks.load).toHaveBeenCalledWith("tenant-a",id);
 expect(mocks.render).toHaveBeenCalledWith({name:"Person"},{pageLimit:1});
 expect(response.headers.get("Content-Type")).toBe("application/pdf");
 expect(response.headers.get("Cache-Control")).toContain("no-store");
 expect(response.headers.get("Content-Disposition")).toContain("attachment;");
});
// Mutation: regenerate an immutable version from current content.
test("downloads stored version bytes", async () => {
 mocks.version.mockResolvedValue({pdf:Buffer.from("frozen-pdf"),title:"Snapshot"});
 const response=await GET(new Request(`http://localhost/pdf?versionId=${id}`),context);
 expect(await response.text()).toBe("frozen-pdf"); expect(mocks.render).not.toHaveBeenCalled();
 expect(mocks.version).toHaveBeenCalledWith("tenant-a",id,id);
});
// Mutation: hide an actionable missing-font or overflow error behind generic export advice.
test("returns trusted renderer recovery instructions", async () => {
 mocks.render.mockRejectedValue(new BuilderRenderError("The selected font cannot render character U+4E2D. Replace that character before exporting."));
 const response=await GET(new Request("http://localhost/pdf?revision=3"),context);
 expect(response.status).toBe(422);
 expect((await response.json()).error).toContain("U+4E2D");
});
