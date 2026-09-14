import { describe, it, expect } from 'vitest';
import { builderHtml } from './resume-builder-html';
import { renderBuilderPdf } from './resume-builder-render';
import type { BuilderProfile, BuilderDesign } from './resume-builder-model';
export const profile: BuilderProfile = {name:'Zoë Martínez', headline:'Community health educator',contact:'zoe@example.test • https://example.test/long-path', summary:'Helping communities access reliable education.', sourceText:'PRIVATE SOURCE NOT PRINTED', sections:[{id:'experience',title:'Experience',entries:[{id:'role',heading:'Health educator',subheading:'Community Centre',dates:'2020–2026',bullets:[{id:'one',text:'Designed multilingual workshops for local families.'},{id:'two',text:'Coordinated training with community partners.'}]}]}]};
export const design: BuilderDesign = {template:'classic',pageLimit:1,pageSize:'letter',accent:'blue',font:'sans'};
describe('builder HTML',()=>{
 it('escapes all content and retains every visible field',()=>{
 // Mutation: skipping escaping on any content field permits injected elements.
 const attack='<img src=x onerror=alert(1)>';
 const p={...profile,name:attack,headline:attack,contact:attack,summary:attack,sections:[{id:'x',title:attack,entries:[{id:'e',heading:attack,subheading:attack,dates:attack,bullets:[{id:'b',text:attack}]}]}]};
 const html=builderHtml(p,design); expect(html).not.toContain('<img'); expect(html.match(/&lt;img/g)?.length).toBe(9); expect(html).not.toContain(profile.sourceText);
 });
 it('defines distinct layouts and fixed paper dimensions',()=>{
 // Mutation: aliasing templates or applying shrink-to-fit loses explicit layout choices.
 for(const template of ['classic','editorial','sidebar'] as const){ const h=builderHtml(profile,{...design,template});expect(h).toContain(`data-template="${template}"`);expect(h).toContain('8.5in');expect(h).not.toContain('scale('); }
 expect(builderHtml(profile,{...design,pageSize:'a4'})).toContain('210mm');
 });
});
const live=process.env.RESUME_RENDER_INTEGRATION==='1'?describe:describe.skip;
live('actual isolated Chromium PDF',()=>{
 it('renders every template and size with searchable Unicode text',async()=>{
 // Mutation: missing a template content block or wrong PDF pagination fails extracted text/count.
 const {extractText,getDocumentProxy}=await import('unpdf');
 for(const template of ['classic','editorial','sidebar'] as const)for(const pageSize of ['letter','a4'] as const){const out=await renderBuilderPdf(profile,{...design,template,pageSize});expect(out.pageCount).toBe(1);const parsed=await getDocumentProxy(new Uint8Array(out.pdf));const page=await parsed.getPage(1);const viewport=page.getViewport({scale:1});expect(Math.abs(viewport.width-(pageSize==='letter'?612:595.28))).toBeLessThan(1);expect(Math.abs(viewport.height-(pageSize==='letter'?792:841.89))).toBeLessThan(1);await parsed.destroy();const t=await extractText(new Uint8Array(out.pdf),{mergePages:true});expect(t.text).toContain('Zoë Martínez');expect(t.text).toContain('Coordinated training');}
 },120000);
 it('renders dense two-page continuations with every bullet retained',async()=>{
 // Mutation: dropping continuation bullets or adding a blank page fails text/count assertions.
 const {extractText}=await import('unpdf');
 const dense={...profile,sections:[{...profile.sections[0],entries:[{...profile.sections[0].entries[0],bullets:Array.from({length:28},(_,i)=>({id:`dense${i}`,text:`Workshop ${i}: taught practical health education.\nShared reliable resources with community partners.`}))}]}]};
 for(const template of ['classic','editorial','sidebar'] as const)for(const pageSize of ['letter','a4'] as const)for(const font of ['sans','serif'] as const){const out=await renderBuilderPdf(dense,{...design,template,pageSize,font,pageLimit:2});expect(out.pageCount).toBe(2);if(process.env.RESUME_RENDER_ARTIFACTS){const fs=await import('node:fs/promises');await fs.mkdir(process.env.RESUME_RENDER_ARTIFACTS,{recursive:true});await fs.writeFile(`${process.env.RESUME_RENDER_ARTIFACTS}/${template}-${pageSize}-${font}.pdf`,out.pdf);}const t=await extractText(new Uint8Array(out.pdf),{mergePages:true});for(let i=0;i<28;i++)expect(t.text).toContain(`Workshop ${i}:`);}
 },120000);
 it('rejects overflow instead of clipping or shrinking',async()=>{
 // Mutation: ignoring page limit silently emits more pages.
 const dense={...profile,sections:[{...profile.sections[0],entries:Array.from({length:8},(_,i)=>({...profile.sections[0].entries[0],id:`e${i}`,bullets:Array.from({length:5},(_,j)=>({id:`b${i}-${j}`,text:`Workshop ${i}-${j}: planned and delivered public health education for families, coordinating local partners and improving access to resources.`}))}))}]};
 await expect(renderBuilderPdf(dense,design)).rejects.toThrow(/page limit|fit/i);
 },30000);
 it('fails closed without Chromium and releases the bounded queue for retry',async()=>{
 // Mutation: unbounded queue accepts a fifth concurrent request; stuck worker blocks the retry.
 const old=process.env.PLAYWRIGHT_BROWSERS_PATH;process.env.PLAYWRIGHT_BROWSERS_PATH='/private/tmp/nonexistent-builder-browser';
 try{const requests=Array.from({length:5},()=>renderBuilderPdf(profile,design));const results=await Promise.allSettled(requests);expect(results[4]).toMatchObject({status:'rejected',reason:expect.objectContaining({message:expect.stringMatching(/busy/)} )});for(const r of results.slice(0,4))expect(r).toMatchObject({status:'rejected',reason:expect.objectContaining({message:expect.stringMatching(/Chromium is unavailable/)} )});}finally{if(old===undefined)delete process.env.PLAYWRIGHT_BROWSERS_PATH;else process.env.PLAYWRIGHT_BROWSERS_PATH=old;}
 await expect(renderBuilderPdf(profile,design)).resolves.toMatchObject({pageCount:1});
 },30000);
 it('wraps long names and URLs without clipping',async()=>{
 // Mutation: removing overflow wrapping causes glyph geometry to exceed the page.
 const long={...profile,name:'María-José Alexandra Fernández de la Cruz',contact:'https://example.test/'+ 'verylongpath'.repeat(18)};
 for(const template of ['classic','editorial','sidebar'] as const) await expect(renderBuilderPdf(long,{...design,template})).resolves.toMatchObject({pageCount:1});
 },30000);
 it('rejects unsupported glyphs rather than using system fonts',async()=>{
 // Mutation: deleting glyph validation silently substitutes platform-dependent fonts.
 await expect(renderBuilderPdf({...profile,name:'Test 🦄'},design)).rejects.toThrow(/character|glyph/i);
 },30000);
});
