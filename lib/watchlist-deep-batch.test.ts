import {expect,test} from "vitest";
import {runWatchlistChecks} from "./watchlist-batch";
// Mutation: the selected Deep action is silently replaced with a normal check.
test("deep batches dispatch the requested mode, once per selected company",async()=>{
  const calls:string[]=[];
  const result=await runWatchlistChecks(["A","A","B"],{
    trigger:"deep",check:async(company,trigger)=>{
      calls.push(`${company}:${trigger}`);
      return {company,method:"search",status:"ok",rolesFound:1,newRoles:1};
    },shouldStop:()=>false,onProgress:()=>{},
  });
  expect(calls).toEqual(["A:deep","B:deep"]);expect(result.completed).toBe(2);
});
