import {safeHttp} from "./safe-http";
import {CAREERS_PAGE_MAX_BYTES} from "./careers-page-limits";
import {fetchAllowed} from "./fetch-page";
import {employerBoardCandidates} from "./employer-board-evidence";
import {parseBoardUrl, parseBoardLink, classifyJobLink} from "./job-link";
import {boardRecall, type StoredBoard} from "./board-store";
import {boardTrust, type BoardResolution} from "./board-source";
import {fetchBoardSnapshot, fetchBoardIdentity, resolveBoardForCompany} from "./resolve-job-link";
import {companyIdentityKey} from "./role-key";
import {rawQuery} from "./supabase";
import type {Posting} from "./ats-boards";
import {describeWriteFailure} from "./write-failure";

export interface VerifiedBoard { resolution:BoardResolution; postings:Posting[]; }

async function remember(tenantId:string,company:string,careersUrl:string|null,resolution:BoardResolution,dryRun:boolean) {
  if(dryRun) return;
  const {error}=await rawQuery(`insert into company_boards
    (tenant_id,company_key,company,vendor,slug,source,checked_at,verified_at,last_fetched_at,careers_url,evidence_url,evidence_kind,board_url)
    values($1,$2,$3,$4,$5,$6,now(),now(),now(),$7,$8,$9,$10)
    on conflict(tenant_id,company_key) do update set company=excluded.company,vendor=excluded.vendor,
      slug=excluded.slug,source=excluded.source,checked_at=now(),verified_at=now(),last_fetched_at=now(),
      careers_url=excluded.careers_url,evidence_url=excluded.evidence_url,evidence_kind=excluded.evidence_kind,board_url=excluded.board_url`,
    [tenantId,companyIdentityKey(company),company,resolution.vendor,resolution.slug,resolution.source,careersUrl,
      resolution.evidenceUrl??null,resolution.evidenceKind??null,resolution.boardUrl??null],tenantId);
  const failure=describeWriteFailure(error?.message,"remember verified employer board");
  if(failure!==undefined) throw new Error(failure);
}

/** Ownership is reverified independently of routine successful listing fetches. */
export async function verifiedCompanyBoard(opts:{tenantId:string;company:string;careersUrl:string|null;storedUrls:string[];dryRun:boolean}):Promise<VerifiedBoard|null> {
  const {tenantId,company,careersUrl,dryRun}=opts;
  const stored=await rawQuery<StoredBoard>(`select vendor,slug,source,checked_at as "checkedAt",
    verified_at as "verifiedAt",last_fetched_at as "lastFetchedAt",careers_url as "careersUrl",
    evidence_url as "evidenceUrl",evidence_kind as "evidenceKind",board_url as "boardUrl"
    from company_boards where tenant_id=$1 and company_key=$2`,[tenantId,companyIdentityKey(company)],tenantId);
  const failure=describeWriteFailure(stored.error?.message,"read employer source evidence");
  if(failure!==undefined) throw new Error(failure);
  const previous=stored.data[0]??null;
  const recalled=boardRecall(previous,careersUrl);
  if(recalled.kind==="use" && previous?.verifiedAt && previous.evidenceKind && previous.evidenceUrl) {
    const result=await fetchBoardSnapshot(recalled.board.vendor,recalled.board.slug);
    if(result.kind==="ok") {
      if(!dryRun) {
        const {error}=await rawQuery("update company_boards set last_fetched_at=now() where tenant_id=$1 and company_key=$2",[tenantId,companyIdentityKey(company)],tenantId);
        const writeFailure=describeWriteFailure(error?.message,"record employer board fetch");
        if(writeFailure!==undefined) throw new Error(writeFailure);
      }
      return {resolution:{vendor:recalled.board.vendor,slug:recalled.board.slug,source:previous.source as "read"|"guessed",
        evidenceKind:previous.evidenceKind as BoardResolution["evidenceKind"],evidenceUrl:previous.evidenceUrl,boardUrl:previous.boardUrl??undefined},postings:result.postings};
    }
    // Retain proof on outages. No false negative cache, no fabricated empty list.
    if(result.kind==="unavailable") { console.warn(`crawler: ${company} board unavailable; source evidence retained`); return null; }
  }

  let resolution:BoardResolution|null=null;
  if(careersUrl && classifyJobLink(careersUrl)==="other" && await fetchAllowed(careersUrl)) {
    try {
      const response=await safeHttp(careersUrl,{timeoutMs:10000,maxBytes:CAREERS_PAGE_MAX_BYTES});
      if(response.ok) {
        const redirected=parseBoardUrl(response.url);
        if(redirected) resolution={...redirected,source:"read",evidenceKind:"employer_redirect",evidenceUrl:careersUrl,boardUrl:response.url};
        else if(new URL(response.url).hostname===new URL(careersUrl).hostname) {
          const candidates=employerBoardCandidates(response.url,await response.text());
          if(candidates.length>1) return null;
          const evidence=candidates[0];
          if(evidence) resolution={vendor:evidence.vendor,slug:evidence.slug,source:"read",evidenceKind:evidence.kind,evidenceUrl:evidence.evidenceUrl,boardUrl:evidence.boardUrl};
        }
      }
    } catch { console.warn(`crawler: ${company} employer source could not be verified`); }
  }
  // Legacy deep links retain their previous trust boundary. A bare guessed
  // board is never upgraded simply because it appears in a stored URL.
  // A legacy failed lookup records no board at all. It cannot prove that the
  // configured careers page moved away from a previously known source.
  const sourceChanged=!!previous?.vendor&&!!previous.slug&&previous.careersUrl!==careersUrl;
  const expiredEmployerProof=previous?.evidenceKind==="employer_link"||previous?.evidenceKind==="employer_redirect";
  if(!resolution&&!sourceChanged&&!expiredEmployerProof) for(const url of opts.storedUrls) {
    const link=parseBoardLink(url);
    if(link?.slug) {resolution={vendor:link.vendor,slug:link.slug,source:"read",evidenceKind:"stored_posting",evidenceUrl:url,boardUrl:url};break;}
  }
  if(resolution) {
    const result=await fetchBoardSnapshot(resolution.vendor,resolution.slug);
    if(result.kind!=="ok") return null;
    await remember(tenantId,company,careersUrl,resolution,dryRun);
    return {resolution,postings:result.postings};
  }

  // Guesses are useful candidates only. The board's own company name must
  // corroborate them; Ashby/Lever return no such name and remain refused.
  const direct=parseBoardUrl(careersUrl);
  // A changed configured source is authoritative. A matching name on the old
  // board proves ownership, but does not prove that it is still where hiring
  // happens. Let the caller read the new page unless it supplies fresh proof.
  if(sourceChanged&&!direct) return null;
  const candidate=direct ?? (previous?.vendor && previous.slug ? parseBoardUrl(previous.boardUrl) : null);
  const guessed=candidate ? {resolution:{...candidate,source:"guessed" as const}} : await resolveBoardForCompany(company,[]);
  if(!guessed) return null;
  const name=await fetchBoardIdentity(guessed.resolution.vendor,guessed.resolution.slug);
  if(boardTrust({...guessed.resolution,source:"guessed"},company,name?[name]:[])!=="source") return null;
  const result=await fetchBoardSnapshot(guessed.resolution.vendor,guessed.resolution.slug);
  if(result.kind!=="ok") return null;
  resolution={...guessed.resolution,source:"guessed",evidenceKind:"board_identity",evidenceUrl:`https://boards-api.greenhouse.io/v1/boards/${guessed.resolution.slug}`};
  await remember(tenantId,company,careersUrl,resolution,dryRun);
  return {resolution,postings:result.postings};
}
