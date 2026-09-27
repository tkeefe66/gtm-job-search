import React from 'react';
const fixture = {company:'Example employer',tracking_enabled:true,careers_url:'https://example.test/careers',crawl_interval_days:7,last_crawl_status:'partial',last_crawl_error:'Grading paused at your background limit.',consecutive_failures:0,ignore_location_rule:false,allow_paid_search:false,added_at:'2026-09-01T12:00:00Z',last_checked_at:'2026-09-27T12:00:00Z',last_attempted_at:'2026-09-27T12:00:00Z',last_successful_check_at:null,next_attempt_at:'2026-10-04T12:00:00Z',failing_since:null};
const state = {company:fixture,background:{dailyCents:100,monthlyCents:1000,spentTodayCents:100,spentMonthCents:2100,dailyReset:'2026-09-28',monthlyReset:'2026-10-01',usesDefaults:true},calls:[] as unknown[],failEmpty:false};
(window as any).costQA=state;
export const getTrackedCompanies=async()=>({companies:[{...state.company}]});
export const getCompanySpendSummaries=async()=>({summaries:[{company:fixture.company,month:'2026-09',knownCostMicrousd:204500,unknownRequests:1,inFlightRequests:0,latest:{occurredAt:'2026-09-27T12:00:00Z',costMicrousd:3200,costComplete:false,status:'partial',newRoles:2}}]});
export const setAutomaticPaidSearch=async(company:string,enabled:boolean)=>{state.calls.push(['automatic',company,enabled]);if(state.failEmpty)return{error:''};state.company.allow_paid_search=enabled;return{}};
export const checkCompanyNow=async(company:string,trigger:string)=>{state.calls.push(['check',company,trigger]);return{status:'skipped',rolesFound:0,newRoles:0,error:'Direct check completed; paid processing is paused.'}};
export const trackCompanyByName=async()=>({outcome:{status:'skipped',rolesFound:0,newRoles:0,error:'Add a careers page to start direct checks.'}});
export const renameTrackedCompany=async()=>({company:fixture.company});
export const setCareersUrl=async()=>({});
export const setCrawlInterval=async()=>({});
export const setIgnoreLocationRule=async()=>({});
export const setTracking=async()=>({});
export const getOwnSpendOverview=async()=>({overview:{dailyCents:2000,monthlyCents:10000,spentTodayCents:100,spentMonthCents:7642,dailyReset:'2026-09-28',monthlyReset:'2026-10-01',background:{...state.background}}});
export const saveSpendLimits=async()=>({});
export const saveBackgroundSpendLimits=async(limits:object)=>{state.calls.push(['background',limits]);if(state.failEmpty)return{error:''};Object.assign(state.background,limits,{usesDefaults:false});return{}};
export default function Link({href,children,...rest}:any){return <a href={href} {...rest}>{children}</a>}
