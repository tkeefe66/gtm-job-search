import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {expect,test} from "vitest";
import DeepSearchControl from "../components/DeepSearchControl";
import {deepSearchAdvice,type CompanySearchEvidence} from "./deep-search-advice";
const evidence:CompanySearchEvidence={company:"Example",modelRetryAfter:null,latestCheck:null,attempts:[{
  id:"failed",startedAt:"2026-09-30T10:00:00Z",finishedAt:"2026-09-30T10:02:00Z",status:"error",rolesFound:0,newRoles:0,
  error:"The AI did not finish a usable answer. Please retry.",costMicrousd:null,costComplete:false,costStatus:"unknown",
}]};
const render=(input:CompanySearchEvidence,blocked?:string)=>renderToStaticMarkup(createElement(DeepSearchControl,{advice:deepSearchAdvice(input,{blocked}),busy:false,onSearch:()=>{},onRefresh:()=>{}}));

// Mutation: enable a retry by default or present missing cost as zero.
test("failed search shows its duration and unknown cost beside an initially disabled paid retry",()=>{
  const html=render(evidence);
  expect(html).toContain("Retry not recommended");expect(html).toContain("2m 0s");expect(html).toContain("Cost unknown");
  expect(html).not.toContain("$0.00");expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Retry Deep search/);
  expect(html).toContain('type="checkbox"');expect(html).toContain("pay for another attempt");
});
test("current account blocks are actionable and cannot be overridden by a checkbox",()=>{
  const html=render(evidence,"Add a usable key in Settings.");
  expect(html).toContain("Paid search is blocked");expect(html).toContain('href="/settings"');
  expect(html).not.toContain('type="checkbox"');expect(html).toMatch(/<button[^>]*disabled=""/);
});
test("legacy costs and partial measured costs remain distinguishable",()=>{
  expect(render({...evidence,attempts:[{...evidence.attempts[0],costStatus:"unrecorded"}]})).toContain("Cost not recorded");
  expect(render({...evidence,attempts:[{...evidence.attempts[0],costMicrousd:12500}]})).toContain("$0.01 recorded; total unknown");
});
test.each([["needs_url","No careers page found"],["skipped","Stopped before completion"]])("paid %s history does not claim the check completed",(status,label)=>{
  const html=render({...evidence,attempts:[{...evidence.attempts[0],status}]});
  expect(html).toContain(label);expect(html).not.toContain("· Completed ·");
  expect(html).toContain('type="checkbox"');
});
