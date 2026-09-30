import {expect,test} from "vitest";
import {toggleCompanySelection, selectedTrackedCompanies, deepSearchBatchPlan} from "./watchlist-selection";
import {deepSearchAdvice} from "./deep-search-advice";

// Mutation: selecting a filtered group drops selections outside that group.
test("group selection adds and clears only that group, preserving hidden selections",()=>{
  const selected=new Set(["Hidden","A"]);
  const all=toggleCompanySelection(selected,["A","B"]);
  expect([...all]).toEqual(["Hidden","A","B"]);
  expect([...toggleCompanySelection(all,["A","B"])]).toEqual(["Hidden"]);
  expect([...selected]).toEqual(["Hidden","A"]);
});
// Mutation: a stale selection resurrects an untracked or renamed company.
test("only currently tracked exact company names reach actions",()=>{
  expect(selectedTrackedCompanies(new Set(["Old","A","Removed"]),[
    {company:"A",tracking_enabled:true},{company:"Renamed",tracking_enabled:true},{company:"Removed",tracking_enabled:false},
  ])).toEqual(["A"]);
});
// Mutation: blocked or stale-acknowledged companies enter a paid batch.
test("paid selection excludes blocked companies and requires current acknowledgement",()=>{
  const simple=deepSearchAdvice({company:"A",modelRetryAfter:null,latestCheck:null,attempts:[]},{});
  const retry=deepSearchAdvice({company:"Retry",modelRetryAfter:"2999-01-01T00:00:00Z",latestCheck:null,attempts:[]},{});
  const blocked={...simple,company:"Blocked",blocked:true};
  const names=["A","Retry","Blocked","Missing","A"];
  expect(deepSearchBatchPlan(names,[simple,retry,blocked],{Retry:"old"})).toMatchObject({ready:[{company:"A"}],blocked:["Blocked","Missing"],unreviewed:["Retry"]});
  expect(deepSearchBatchPlan(names,[simple,retry,blocked],{Retry:retry.acknowledgementKey}).ready).toEqual([
    {company:"A",acknowledgementKey:undefined},{company:"Retry",acknowledgementKey:retry.acknowledgementKey},
  ]);
});
