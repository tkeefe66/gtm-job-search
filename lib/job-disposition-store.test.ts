import {beforeEach,expect,test,vi} from "vitest";
const h=vi.hoisted(()=>({query:vi.fn(),tenant:vi.fn(),error:undefined as Error|undefined}));
vi.mock("@/lib/supabase",()=>({
 tenantTransaction:async(tenant:string,fn:(q:unknown)=>unknown)=>{h.tenant(tenant);if(h.error)throw h.error;return fn(h.query);},
 describeThrown:(e:Error)=>({message:e.message}),rawQuery:vi.fn(),
}));
vi.mock("@/lib/tenant",()=>({resolveTenantId:async()=>"trusted"}));
import {patchJobWithActor,updateAutomaticJob} from "./job-disposition-store";
beforeEach(()=>{vi.clearAllMocks();h.error=undefined;h.query.mockResolvedValue({rows:[{id:"role"}]});});
test("internal writer sets local trusted actor and cannot move job identity or tenant",async()=>{
 await patchJobWithActor("trusted","role",{id:"spoofed",tenant_id:"other",created_at:"old",status:"New"} as never,"user");
 expect(h.tenant).toHaveBeenCalledWith("trusted");
 expect(h.query.mock.calls[0]).toEqual(["select set_config('app.disposition_actor',$1,true)",["user"]]);
 expect(h.query.mock.calls[1][0]).toMatch(/^update jobs set "status"=\$3,"updated_at"=\$4 where tenant_id=\$1 and id=\$2 returning id$/);
 expect(h.query.mock.calls[1][1].slice(0,3)).toEqual(["trusted","role","New"]);
});
test("automation cannot inherit human feedback provenance",async()=>{
 await updateAutomaticJob("role",{status:"Posting Closed"});
 expect(h.query.mock.calls[0][1]).toEqual(["automation"]);
});
test("empty database errors remain failures and missing rows are explicit",async()=>{
 h.error=new Error("");expect(await patchJobWithActor("trusted","role",{},"user")).toEqual({error:""});
 h.error=undefined;h.query.mockResolvedValue({rows:[]});
 expect((await patchJobWithActor("trusted","role",{},"user")).error).toMatch(/no longer available/);
});
