import { requireResumeBuilder } from "@/lib/require-resume-builder";
import { BuilderInputError, validateBuilderId } from "@/lib/resume-builder-model";
import { loadBuilderDocument, loadBuilderVersionPdf } from "@/lib/resume-builder-store";
import { BuilderRenderError, renderBuilderPdf } from "@/lib/resume-builder-render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
function failure(error:string,status:number){return Response.json({error},{status,headers});}
function download(pdf:Buffer,title:string){
 const name=(title.replace(/[^a-zA-Z0-9 _-]/g,"").trim().slice(0,80)||"resume")+".pdf";
 return new Response(new Uint8Array(pdf),{headers:{...headers,"Content-Type":"application/pdf","Content-Disposition":`attachment; filename="${name}"`}});
}
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 let actor;
 try { actor=await requireResumeBuilder(); }
 catch(error){
  const message=error instanceof Error?error.message:"";
  if(message==="Not authenticated")return failure("Sign in to download your résumé.",401);
  if(message.includes("not enabled")||message.includes("onboarding"))return failure(message,403);
  console.error("resume-builder.pdf.authorization-failed",error);
  return failure("Could not verify access. Please try again.",503);
 }
 try {
  const {id}=await params;validateBuilderId(id);
  const query=new URL(request.url).searchParams;
  const versionId=query.get("versionId");
  if(versionId){
   validateBuilderId(versionId);
   const version=await loadBuilderVersionPdf(actor.tenantId,id,versionId);
   return download(version.pdf,version.title);
  }
  const revision=Number(query.get("revision"));
  if(!Number.isSafeInteger(revision)||revision<1)return failure("Choose a saved draft revision before downloading.",400);
  const document=await loadBuilderDocument(actor.tenantId,id);
  if(document.revision!==revision)return failure("This résumé changed. Reload it before downloading.",409);
  const rendered=await renderBuilderPdf(document.profile,document.design);
  const latest=await loadBuilderDocument(actor.tenantId,id);
  if(latest.revision!==revision)return failure("This résumé changed while preparing the PDF. Reload and try again.",409);
  return download(rendered.pdf,document.title);
 }catch(error){
  if(error instanceof BuilderInputError)return failure(error.message,400);
  if(error instanceof BuilderRenderError)return failure(error.message,422);
  console.error("resume-builder.pdf.failed",error);
  return failure("Could not create the PDF. Check the preview fits your page limit, then try again.",422);
 }
}
