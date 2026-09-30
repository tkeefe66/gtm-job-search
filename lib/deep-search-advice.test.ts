import { expect, test } from "vitest";
import { deepSearchAdvice, type CompanySearchEvidence, type SearchAttempt } from "./deep-search-advice";

const now = new Date("2026-09-30T15:00:00Z");
const attempt = (changes: Partial<SearchAttempt> = {}): SearchAttempt => ({
  id: "run", startedAt: "2026-09-30T14:00:00Z", finishedAt: "2026-09-30T14:02:00Z",
  status: "error", rolesFound: 0, newRoles: 0, costMicrousd: null, costComplete: false, costStatus: "unknown",
  error: "Anthropic: request timed out, could not connect, or returned an invalid response. Check usage before retrying.",
  ...changes,
});
const evidence = (changes: Partial<CompanySearchEvidence> = {}): CompanySearchEvidence => ({
  company: "Example", modelRetryAfter: null, latestCheck: null, attempts: [], ...changes,
});

// Mutation: allow a failed/unknown request because its recorded cost is zero, or let old successes override the latest failure.
test("a recent failed search requires an explicit retry even if older searches succeeded", () => {
  const advice = deepSearchAdvice(evidence({ attempts: [attempt(), attempt({id:"older",status:"partial",newRoles:2,error:null})] }), {}, now);
  expect(advice).toMatchObject({state:"retry",requiresAcknowledgement:true,blocked:false});
  expect(advice.reason).toContain("failed");
  expect(advice.reason).not.toContain("no jobs");
});

// Mutation: declare a currently running request safe to retry or permanently block an abandoned run.
test("a running search blocks duplicates; an old unfinished search requires review", () => {
  expect(deepSearchAdvice(evidence({attempts:[attempt({startedAt:"2026-09-30T14:59:00Z",finishedAt:null,status:"running"})]}),{},now).blocked).toBe(true);
  expect(deepSearchAdvice(evidence({attempts:[attempt({finishedAt:null,status:"running"})]}),{},now)).toMatchObject({state:"retry",requiresAcknowledgement:true});
});

// Mutation: recommendations override actual key/allowance refusal.
test("current account blocks take priority over successful history", () => {
  const advice=deepSearchAdvice(evidence({attempts:[attempt({status:"partial",newRoles:3,costMicrousd:10000,costComplete:true,error:null})]}),{blocked:"Add an API key in Settings."},now);
  expect(advice).toMatchObject({state:"blocked",blocked:true,reason:"Add an API key in Settings."});
});

// Mutation: search-pinned skipped runs or outdated successful checks become evidence that direct reading works.
test("only the most recent successful direct result earns the direct-check recommendation", () => {
  expect(deepSearchAdvice(evidence({latestCheck:{method:"fetch",status:"ok",startedAt:now.toISOString()}}),{},now).state).toBe("direct");
  expect(deepSearchAdvice(evidence({latestCheck:{method:"search",status:"skipped",startedAt:now.toISOString()}}),{},now).state).toBe("untested");
  expect(deepSearchAdvice(evidence({latestCheck:{method:"fetch",status:"partial",startedAt:now.toISOString()}}),{},now).state).toBe("untested");
});

// Mutation: label any completed search as useful, or promise relevant jobs from an unverified role count.
test("completed searches distinguish added roles from duplicate-only output", () => {
  const withRoles=deepSearchAdvice(evidence({attempts:[attempt({status:"partial",newRoles:2,costMicrousd:10000,costComplete:true,error:null})]}),{},now);
  expect(withRoles.state).toBe("promising");
  expect(withRoles.reason).toContain("2 new roles");
  expect(withRoles.reason).not.toContain("verified");
  const noNew=deepSearchAdvice(evidence({attempts:[attempt({status:"partial",rolesFound:4,newRoles:0,costMicrousd:10000,costComplete:true,error:null})]}),{},now);
  expect(noNew.state).toBe("limited");
  expect(noNew.reason).toContain("no new roles");
  expect(noNew.reason).not.toContain("no jobs");
});

test("active model cooldown remains a visible retry warning", () => {
  expect(deepSearchAdvice(evidence({modelRetryAfter:"2026-10-03T00:00:00Z"}),{},now)).toMatchObject({state:"retry",requiresAcknowledgement:true});
});

test("legacy missing cost stays unknown without making completed results failures", () => {
  const advice=deepSearchAdvice(evidence({attempts:[attempt({status:"ok",newRoles:2,costComplete:false,costMicrousd:null,error:null})]}),{},now);
  expect(advice.state).toBe("promising");
  expect(advice.attempts[0].costMicrousd).toBeNull();
});

test.each(["needs_url", "skipped"])("recorded paid %s attempts are unsuccessful, not untested", status => {
  const advice=deepSearchAdvice(evidence({attempts:[attempt({status,costMicrousd:12000,costComplete:true,costStatus:"complete"})]}),{},now);
  expect(advice).toMatchObject({state:"retry",requiresAcknowledgement:true});
  expect(advice.reason).not.toContain("No completed paid search");
  expect(advice.attempts[0].costMicrousd).toBe(12000);
});

test("retry acknowledgement changes when a new result, cost, or cooldown arrives", () => {
  const base=evidence({attempts:[attempt()]});
  const key=deepSearchAdvice(base,{},now).acknowledgementKey;
  expect(deepSearchAdvice(base,{},new Date(now.getTime()+1000)).acknowledgementKey).toBe(key);
  for(const changed of [
    {...base,attempts:[attempt({id:"another-run"})]},
    {...base,attempts:[attempt({costMicrousd:12000,costComplete:true})]},
    {...base,modelRetryAfter:"2026-10-03T00:00:00Z"},
  ]) expect(deepSearchAdvice(changed,{},now).acknowledgementKey).not.toBe(key);
});
