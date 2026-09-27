import {expect,test,vi} from "vitest";
vi.mock("./supabase",()=>({rawQuery:vi.fn()}));
import {rawQuery} from "./supabase";
import {settledCrawlRoles} from "./crawl-snapshot-store";
const role={role_title:"Systems Lead",job_url:"https://example.test/jobs/1",location:"",salary_range:"",description_summary:"",seniority:"",fit_signal:"",ic_flag:false};
const row={...role,fit_score:4,posting:null,source:"Crawl",status:"New",grading_chosen:false,never_live:false};
test("a successful blind grade cannot acknowledge a failed posting read",async()=>{
  // Mutation: acknowledge fit_score alone, permanently suppressing a failed extraction retry.
  vi.mocked(rawQuery).mockResolvedValue({data:[row],error:null});
  expect(await settledCrawlRoles("tenant","Example",[role])).toEqual([]);
  vi.mocked(rawQuery).mockResolvedValue({data:[{...row,posting:{enrichedAt:new Date().toISOString()}}],error:null});
  expect(await settledCrawlRoles("tenant","Example",[role])).toEqual([role]);
});
test("protected user choices are intentional outcomes even without a posting read",async()=>{
  // Mutation: require processing of manually chosen or terminal rows and repeatedly bill them.
  vi.mocked(rawQuery).mockResolvedValue({data:[{...row,fit_score:null,status:"Applied"}],error:null});
  expect(await settledCrawlRoles("tenant","Example",[role])).toEqual([role]);
});
