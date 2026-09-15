import {beforeEach,expect,test,vi} from "vitest";
import {DEFAULT_STATUSES} from "@/lib/job-statuses";
const h=vi.hoisted(()=>({error:undefined as string|undefined,statuses:[] as unknown[],patch:vi.fn(),read:vi.fn()}));
vi.mock("@/lib/require-actor",()=>({requireActor:async()=>({tenantId:"trusted-tenant"})}));
vi.mock("@/app/actions/jobs",()=>({getJobStatuses:async()=>({statuses:h.statuses,error:h.error})}));
vi.mock("@/lib/job-disposition-store",()=>({patchJobWithActor:h.patch,readSourceQuality:h.read}));
import {setJobDisposition,getSourceQuality} from "./job-dispositions";
beforeEach(()=>{vi.clearAllMocks();h.error=undefined;h.statuses=DEFAULT_STATUSES;h.patch.mockResolvedValue({});});
test("manual missing role files separately from posting closure and uses trusted identity",async()=>{
 await setJobDisposition("role","job_not_found");
 expect(h.patch).toHaveBeenCalledWith("trusted-tenant","role",{status:"Not Interested",disposition:"job_not_found",disposition_reason:null},"user",true);
});
test("missing filing status and empty database errors never write",async()=>{
 h.statuses=DEFAULT_STATUSES.filter(s=>s.key==="Posting Closed");
 expect((await setJobDisposition("role","not_a_fit")).error).toMatch(/Settings/);
 h.error="";expect(await setJobDisposition("role","not_a_fit")).toEqual({error:""});
 expect(h.patch).not.toHaveBeenCalled();
});
test("invalid and mismatched reasons are rejected before writing",async()=>{
 expect((await setJobDisposition("role","not_interested","pay")).error).toBeDefined();
 expect((await setJobDisposition("role","invalid" as never)).error).toBeDefined();
 expect(h.patch).not.toHaveBeenCalled();
});
test("source report reads the trusted tenant",async()=>{
 h.read.mockResolvedValue({startedAt:"now",records:[]});
 expect(await getSourceQuality()).toEqual({startedAt:"now",records:[]});
 expect(h.read).toHaveBeenCalledWith("trusted-tenant");
});
