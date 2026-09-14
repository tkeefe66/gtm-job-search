import { chromium } from 'playwright';
import { create } from 'fontkit';
import { readFileSync } from 'node:fs';
import { getDocumentProxy } from 'unpdf';
let browser,server;
try {
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>8_000_000)throw Error('Resume input is too large. Shorten the document.');}
 const {html,profile,design}=JSON.parse(input);
 const font=create(readFileSync(new URL(`../assets/resume-builder/v1/Noto${design.font==='serif'?'Serif':'Sans'}.ttf`,import.meta.url)));
 const visible=[profile.name,profile.headline,profile.contact,profile.summary,...profile.sections.flatMap(s=>[s.title,...s.entries.flatMap(e=>[e.heading,e.subheading,e.dates,...e.bullets.map(b=>b.text)])])].join('');
 for(const char of visible){if(!/\s/.test(char)&&!font.hasGlyphForCodePoint(char.codePointAt(0)))throw Error(`The selected font cannot render character U+${char.codePointAt(0).toString(16).toUpperCase()}. Replace that character before exporting.`);}
 try{server=await chromium.launchServer({headless:true,args:['--disable-background-networking','--disable-component-update','--disable-sync','--disable-default-apps','--no-first-run','--renderer-process-limit=1'],timeout:10000});process.send?.({browserPid:server.process().pid});browser=await chromium.connect(server.wsEndpoint(),{timeout:10000});}catch{throw Error('Chromium is unavailable. Ask the operator to run npx playwright install --with-deps chromium for this release.');}
 const context=await browser.newContext({offline:true,serviceWorkers:'block',viewport:{width:1000,height:1200}});
 await context.route('**/*',route=>route.abort());
 const page=await context.newPage();await page.emulateMedia({media:'print'});await page.setContent(html,{waitUntil:'load',timeout:10000});
 await page.waitForFunction(()=>window.__resumeRender,undefined,{timeout:10000});
 const geometry=await page.evaluate(()=>window.__resumeRender);
 if(geometry.error)throw Error(geometry.error);
 if(geometry.pageCount>design.pageLimit)throw Error(`Resume uses ${geometry.pageCount} pages, exceeding the ${design.pageLimit}-page limit. Shorten content or choose two pages.`);
 const pdf=await page.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false,scale:1,timeout:10000});
 const parsed=await getDocumentProxy(new Uint8Array(pdf));const pageCount=parsed.numPages;await parsed.destroy();
 if(pageCount!==geometry.pageCount||pageCount>design.pageLimit)throw Error('PDF page count did not match the validated layout. Retry rendering.');
 process.stdout.write(JSON.stringify({pdf:pdf.toString('base64'),pageCount}));
}catch(error){process.stdout.write(JSON.stringify({error:error instanceof Error?error.message:'Resume rendering failed. Retry.'}));process.exitCode=1;}finally{if(browser)await browser.close();if(server)await server.close();}
