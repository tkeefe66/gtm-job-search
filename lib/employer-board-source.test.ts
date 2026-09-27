import {beforeEach,expect,test,vi} from "vitest";
vi.mock("./supabase",()=>({rawQuery:vi.fn()}));
vi.mock("./safe-http",()=>({safeHttp:vi.fn()}));
vi.mock("./fetch-page",()=>({fetchAllowed:vi.fn(async()=>true)}));
vi.mock("./resolve-job-link",()=>({fetchBoardSnapshot:vi.fn(),fetchBoardIdentity:vi.fn(async()=>null),resolveBoardForCompany:vi.fn(async()=>null)}));
import {rawQuery} from "./supabase";
import {safeHttp} from "./safe-http";
import {fetchBoardSnapshot,resolveBoardForCompany,fetchBoardIdentity} from "./resolve-job-link";
import {verifiedCompanyBoard} from "./employer-board-source";

const opts={tenantId:"tenant",company:"Example Labs",careersUrl:"https://example.test/careers",storedUrls:[],dryRun:false};
const postings=[{title:"Systems Lead",url:"https://jobs.ashbyhq.com/example/req"}];
const proof={vendor:"ashby",slug:"example",source:"read",checkedAt:new Date().toISOString(),verifiedAt:new Date().toISOString(),careersUrl:opts.careersUrl,evidenceKind:"employer_link",evidenceUrl:opts.careersUrl,boardUrl:"https://jobs.ashbyhq.com/example"};
beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(rawQuery).mockResolvedValue({data:[],error:null});
  vi.mocked(fetchBoardSnapshot).mockResolvedValue({kind:"ok",postings});
  vi.mocked(fetchBoardIdentity).mockResolvedValue(null);
  vi.mocked(safeHttp).mockResolvedValue({status:200,ok:true,url:opts.careersUrl,text:async()=>'<a href="https://jobs.ashbyhq.com/example">Jobs</a>',json:async()=>({})});
});

test("only an employer-published link upgrades an uncorroborated Ashby candidate",async()=>{
  // Mutation: accept a guessed nonempty board without employer evidence.
  const verified=await verifiedCompanyBoard(opts);
  expect(verified?.resolution).toMatchObject({source:"read",evidenceKind:"employer_link",evidenceUrl:opts.careersUrl});
  vi.mocked(safeHttp).mockResolvedValue({status:200,ok:true,url:opts.careersUrl,text:async()=>"No board link",json:async()=>({})});
  vi.mocked(resolveBoardForCompany).mockResolvedValue({resolution:{vendor:"ashby",slug:"example",source:"guessed"},postings});
  expect(await verifiedCompanyBoard(opts)).toBeNull();
});

test("a transient unavailable board retains proof and cannot provide an empty inventory",async()=>{
  // Mutation: erase verified proof or return [] on a transient HTTP failure.
  vi.mocked(rawQuery).mockResolvedValue({data:[proof],error:null});
  vi.mocked(fetchBoardSnapshot).mockResolvedValue({kind:"unavailable",message:"HTTP 429"});
  expect(await verifiedCompanyBoard(opts)).toBeNull();
  expect(rawQuery).toHaveBeenCalledTimes(1);
  expect(safeHttp).not.toHaveBeenCalled();
});

test("ordinary successful fetches never refresh ownership age",async()=>{
  // Mutation: advance verified_at on every listing fetch, preventing expiry.
  vi.mocked(rawQuery).mockResolvedValue({data:[proof],error:null});
  expect(await verifiedCompanyBoard(opts)).not.toBeNull();
  const writes=vi.mocked(rawQuery).mock.calls.slice(1).map(call=>call[0]);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain("last_fetched_at=now()");
  expect(writes[0]).not.toContain("verified_at");
});

test("changed employer source does not reuse its old board and dry runs write no proof",async()=>{
  // Mutation: ignore the configured URL in source recall, or persist dry-run evidence.
  vi.mocked(rawQuery).mockResolvedValue({data:[{...proof,careersUrl:"https://old.test/careers"}],error:null});
  await verifiedCompanyBoard({...opts,dryRun:true});
  expect(safeHttp).toHaveBeenCalledWith(opts.careersUrl,expect.anything());
  expect(rawQuery).toHaveBeenCalledTimes(1);
});

test("conflicting official links cannot fall through to a remembered posting",async()=>{
  // Mutation: when two official boards conflict, choose a convenient stored one.
  vi.mocked(safeHttp).mockResolvedValue({status:200,ok:true,url:opts.careersUrl,text:async()=>'<a href="https://jobs.ashbyhq.com/a">A</a><a href="https://jobs.ashbyhq.com/b">B</a>',json:async()=>({})});
  expect(await verifiedCompanyBoard({...opts,storedUrls:[postings[0].url]})).toBeNull();
  expect(fetchBoardSnapshot).not.toHaveBeenCalled();
});

test("a changed careers URL cannot be rebound to its old Greenhouse board by a matching company name",async()=>{
  // Mutation: invalidate cached proof but then recover the same old board through the guessed-candidate path.
  vi.mocked(rawQuery).mockResolvedValue({data:[{...proof,vendor:"greenhouse",slug:"oldexample",careersUrl:"https://old.test/careers",boardUrl:"https://job-boards.greenhouse.io/oldexample"}],error:null});
  vi.mocked(safeHttp).mockResolvedValue({status:200,ok:true,url:opts.careersUrl,text:async()=>"New direct careers page",json:async()=>({})});
  vi.mocked(fetchBoardIdentity).mockResolvedValue("Example Labs");
  expect(await verifiedCompanyBoard(opts)).toBeNull();
  expect(fetchBoardSnapshot).not.toHaveBeenCalled();
  expect(resolveBoardForCompany).not.toHaveBeenCalled();
  expect(rawQuery).toHaveBeenCalledTimes(1);
});

test("an explicitly changed board URL can establish fresh identity evidence",async()=>{
  // Mutation: refuse all new sources when the previous careers URL differs, including explicit verified replacements.
  vi.mocked(rawQuery).mockResolvedValue({data:[proof],error:null});
  vi.mocked(fetchBoardIdentity).mockResolvedValue("Example Labs");
  expect(await verifiedCompanyBoard({...opts,careersUrl:"https://job-boards.greenhouse.io/newexample"}))
    .toMatchObject({resolution:{vendor:"greenhouse",slug:"newexample",evidenceKind:"board_identity"}});
});
