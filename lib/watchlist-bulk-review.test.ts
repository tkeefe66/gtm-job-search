import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {expect,test} from "vitest";
import WatchlistBulkReview from "../components/WatchlistBulkReview";
import {deepSearchAdvice} from "./deep-search-advice";

const advice=(company:string,blocked?:string,paused=false)=>deepSearchAdvice({company,attempts:[],latestCheck:null,modelRetryAfter:paused?"2999-01-01T00:00:00Z":null},{blocked});
const render=(kind:"deep"|"remove",items= [advice("Ready"),advice("Retry",undefined,true),advice("Blocked","Allowance reached.")])=>renderToStaticMarkup(createElement(WatchlistBulkReview,{
  kind,names:items.map(item=>item.company),advice:items,busy:false,onCancel:()=>{},onRemove:()=>{},onSearch:()=>{},onReview:()=>{},
}));
// Mutation: enable the batch start while a selected retry is still unacknowledged.
test("bulk paid review names blocked skips and disables start until retry acknowledgement",()=>{
  const html=render("deep");
  expect(html).toContain("Will be skipped");expect(html).toContain("Allowance reached.");
  expect(html).toContain("1 ready · 1 need retry confirmation · 1 will be skipped");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Deep search 1 company/);
  expect(html).toContain("previous result and want to pay to retry");
});
// Mutation: make a successful/untested selected company unusable without a failure acknowledgement.
test("eligible selections can start without an unnecessary retry checkbox",()=>{
  const html=render("deep",[advice("Ready")]);
  expect(html).not.toContain('type="checkbox"');expect(html).not.toContain('disabled=""');
  expect(html).toContain("Deep search 1 company");
});
// Mutation: removal confirmation omits scope or claims saved roles will be deleted.
test("removal review names exact companies and explains reversible tracking removal",()=>{
  const html=render("remove",[advice("First"),advice("Second")]);
  expect(html).toContain("First, Second");expect(html).toContain("Remove 2 companies");
  expect(html).toContain("Saved roles and history stay available");expect(html).toContain("Resume");
});
