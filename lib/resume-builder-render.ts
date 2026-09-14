import { spawn } from 'node:child_process';
import path from 'node:path';
import { builderHtml } from './resume-builder-html';
import type { BuilderProfile, BuilderDesign } from './resume-builder-model';
export { builderHtml } from './resume-builder-html';
/** Safe renderer failures that callers may display without exposing database errors. */
export class BuilderRenderError extends Error { constructor(message:string){super(message);this.name='BuilderRenderError';} }
const MAX_WAITING = 3;
const TIMEOUT_MS = 25000;
type QueueEntry = {run:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
const runtime = globalThis as typeof globalThis & { __resumeBuilderQueue?: {active:boolean;waiting:QueueEntry[]} };
const queue = runtime.__resumeBuilderQueue ?? (runtime.__resumeBuilderQueue = {active:false,waiting:[]});
const waiting = queue.waiting;
function next(){const entry=waiting.shift();if(entry){clearTimeout(entry.timer);entry.run();}else queue.active=false;}
function worker(html:string, profile:BuilderProfile,design:BuilderDesign): Promise<{pdf:Buffer;pageCount:number}>{
 return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['--max-old-space-size=256',path.join(process.cwd(),'scripts/resume-builder-render-worker.mjs')],{stdio:['pipe','pipe','pipe','ipc'],detached:process.platform!=='win32',env:{NODE_ENV:"production",PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH}});
 let output='',settled=false,browserPid:number|undefined;
 child.on('message',(message:unknown)=>{const value=message as {browserPid?:unknown};if(Number.isInteger(value?.browserPid)&&Number(value.browserPid)>1)browserPid=Number(value.browserPid);});
 const kill=()=>{if(browserPid)try{process.kill(process.platform!=='win32'?-browserPid:browserPid,'SIGKILL');}catch{/* Browser has already exited. */}try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{/* Process has already exited. */}};
 const finish=(error?:Error,result?:{pdf:Buffer;pageCount:number})=>{if(settled)return;settled=true;clearTimeout(timer);kill();if(error)reject(error);else resolve(result!);};
 const timer=setTimeout(()=>finish(new Error('Resume rendering timed out. Retry or shorten the document.')),TIMEOUT_MS);
 child.on('error',()=>finish(new Error('Resume renderer could not start. Ask the operator to check the Chromium installation.')));
 child.stdin!.on('error',()=>finish(new Error('Resume renderer stopped before receiving the document. Retry rendering.')));
 child.stdout!.on('data',(chunk:Buffer)=>{output+=chunk.toString();if(output.length>16_000_000)finish(new Error('Rendered resume is too large. Shorten the document.'));});
 child.stderr!.resume();
 child.on('close',(code)=>{if(settled)return;try{const result=JSON.parse(output);if(result.error)finish(new Error(result.error));else if(code!==0||!result.pdf||!Number.isInteger(result.pageCount)||result.pageCount<1||result.pageCount>design.pageLimit)finish(new Error('Resume PDF validation failed. Retry rendering.'));else finish(undefined,{pdf:Buffer.from(result.pdf,'base64'),pageCount:result.pageCount});}catch{finish(new Error('Resume renderer failed. Check Chromium installation and retry.'));}});
 child.stdin!.end(JSON.stringify({html,profile,design}));
 });
}
/** At most one isolated Chromium worker per web process; three queued requests, each bounded. */
async function renderQueued(profile:BuilderProfile,design:BuilderDesign):Promise<{pdf:Buffer;pageCount:number}>{
 if(JSON.stringify(profile).length>160000)throw new Error('Resume content is too large. Shorten the document.');
 if(queue.active&&waiting.length>=MAX_WAITING)throw new Error('Resume renderer is busy. Retry in a moment.');
 return new Promise((resolve,reject)=>{
 const run=()=>{queue.active=true;Promise.resolve().then(()=>worker(builderHtml(profile,design),profile,design)).then(resolve,reject).finally(next);};
 if(!queue.active)run();else{const entry={run,reject,timer:setTimeout(()=>{const i=waiting.indexOf(entry);if(i>=0)waiting.splice(i,1);reject(new Error('Resume rendering queue timed out. Retry in a moment.'));},TIMEOUT_MS)};waiting.push(entry);}
 });
}

export async function renderBuilderPdf(profile:BuilderProfile,design:BuilderDesign):Promise<{pdf:Buffer;pageCount:number}>{
 try{return await renderQueued(profile,design);}catch(error){throw new BuilderRenderError(error instanceof Error&&error.message?error.message:'Resume rendering failed. Retry rendering.');}
}
