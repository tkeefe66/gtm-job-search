import {expect,test,vi} from "vitest";
vi.mock("./safe-http",()=>({safeHttp:vi.fn()}));
import {safeHttp} from "./safe-http";
import {fetchBoardSnapshot} from "./resolve-job-link";

test("HTTP429 and malformed successful board payloads are unavailable rather than empty listings",async()=>{
  // Mutation: flatten rate limits or partly parsed boards to a trustworthy empty array.
  vi.mocked(safeHttp).mockResolvedValue({status:429,ok:false,url:"https://example.test",text:async()=>"",json:async()=>({})});
  expect((await fetchBoardSnapshot("ashby","example")).kind).toBe("unavailable");
  vi.mocked(safeHttp).mockResolvedValue({status:200,ok:true,url:"https://example.test",text:async()=>"",json:async()=>({jobs:[{id:"req",title:"Systems Lead"}]})});
  expect((await fetchBoardSnapshot("ashby","example")).kind).toBe("unavailable");
});

test("rich supported Ashby fields survive the listing fetch for content comparison and reuse",async()=>{
  // Mutation: drop description/compensation from the parsed board, hiding material changes.
  // Synthetic fixture follows the existing verified Ashby payload contract; no live provider call.
  vi.mocked(safeHttp).mockResolvedValue({status:200,ok:true,url:"https://example.test",text:async()=>"",json:async()=>({jobs:[{
    id:"req",title:"Systems Lead",jobUrl:"https://jobs.ashbyhq.com/example/req",isListed:true,
    descriptionPlain:"Build and lead systems",location:"Remote",compensation:{compensationTierSummary:"$200000–$250000"},department:"Systems",
  }]})});
  const result=await fetchBoardSnapshot("ashby","example");
  expect(result).toMatchObject({kind:"ok",postings:[{body:"Build and lead systems",location:"Remote",compensation:"$200000–$250000",
    material:{compensation:{compensationTierSummary:"$200000–$250000"}}}]});
});
