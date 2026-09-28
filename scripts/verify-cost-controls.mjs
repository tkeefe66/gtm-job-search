import {createServer} from 'vite';
const {chromium} = await import(process.env.COST_QA_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=path.join(root,'tests/fixtures/cost-controls');
const outputDir=mkdtempSync(path.join(tmpdir(),'cost-controls-'));
const mocks=path.join(dir,'mocks.tsx');
const server=await createServer({root,configFile:false,oxc:{jsx:{runtime:'automatic'}},resolve:{alias:[
 {find:'@/app/actions/watchlist',replacement:mocks},{find:'@/app/actions/spend-limits',replacement:mocks},
 {find:'next/link',replacement:mocks},{find:'@',replacement:root}]},
 server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root,realpathSync(path.join(root,'node_modules'))]}},
 plugins:[{name:'qa-page',configureServer(s){s.middlewares.use('/__costqa',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/${dir}/main.tsx"></script></body></html>`);});}}]});
let browser;
try{
 await server.listen();
 const baseUrl=server.resolvedUrls.local[0];
 browser=await chromium.launch({executablePath:process.env.COST_QA_BROWSER || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${baseUrl}__costqa`);
 await page.getByRole('button',{name:'Open',exact:true}).click();
 const toggle=page.getByRole('checkbox',{name:/Allow automatic paid/});
 await toggle.check();assert.equal(await toggle.isChecked(),true);
 await page.evaluate(()=>window.costQA.failEmpty=true);
 await toggle.click();assert.equal(await toggle.isChecked(),true);
 assert.match(await page.locator('body').innerText(),/Could not save automatic paid search/);
 await page.evaluate(()=>window.costQA.failEmpty=false);
 await page.getByRole('button',{name:'Check now',exact:true}).click();
 await page.getByRole('button',{name:'Deep search · up to 5 paid searches',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.costQA.calls.filter(x=>x[0]==='check').map(x=>x[2])),['check','deep']);
 await page.locator('#background-daily-limit').fill('0');
 await page.getByRole('button',{name:'Save background limits',exact:true}).click();
 await page.getByText('Background spending limits saved and confirmed.',{exact:false}).waitFor();
 assert.equal(await page.locator('#background-daily-limit').inputValue(),'0.00');
 await page.locator('#background-daily-limit').fill('');
 await page.locator('#background-monthly-limit').fill('');
 await page.getByRole('button',{name:'Save background limits',exact:true}).click();
 await page.getByText('Background spending limits saved and confirmed.',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>window.costQA.background.dailyCents),null);
 await page.evaluate(()=>window.costQA.failEmpty=true);
 await page.locator('#background-daily-limit').fill('1');
 await page.locator('#background-monthly-limit').fill('10');
 await page.getByRole('button',{name:'Save background limits',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Could not save your spending limits'}).waitFor();
 assert.equal(await page.evaluate(()=>window.costQA.background.dailyCents),null);
 assert.equal(await page.getByText('Background spending limits saved and confirmed.',{exact:false}).count(),0);
 await page.evaluate(()=>window.costQA.failEmpty=false);
 await page.getByRole('button',{name:'Reload spending',exact:true}).click();
 await page.getByRole('button',{name:'Save background limits',exact:true}).waitFor();
 await page.screenshot({path:path.join(outputDir,'desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:path.join(outputDir,'mobile.png'),fullPage:true});
 const width=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
 assert.equal(width.scroll,width.viewport);assert.deepEqual(errors,[]);
 await page.goto(`${baseUrl}__costqa?member=1`);
 await page.locator('#daily-spend-limit').fill('30');
 await page.locator('#background-daily-limit').fill('2');
 await page.getByRole('button',{name:'Save background limits',exact:true}).click();
 await page.getByText('Background spending limits saved and confirmed.',{exact:false}).waitFor();
 assert.equal(await page.locator('#daily-spend-limit').inputValue(),'30');
 await page.locator('#background-daily-limit').fill('3');
 await page.getByRole('button',{name:'Save spending limits',exact:true}).click();
 await page.getByText('Overall spending limits saved and confirmed.',{exact:false}).waitFor();
 assert.equal(await page.locator('#background-daily-limit').inputValue(),'3');
 // Mutation caught: the row keeps the generic badge, details leak legacy provider JSON, or longer labels overflow mobile.
 for (const [issue,label,remedy] of [['credit','API credits too low','Review credits and billing limits'],['incomplete','AI response incomplete','Use Check now to retry the direct source']]) {
  await page.goto(`${baseUrl}__costqa?issue=${issue}`);
  await page.getByText(label,{exact:true}).waitFor();
  await page.getByRole('button',{name:'Open',exact:true}).click();
  await page.getByText(`Last check: ${label}`,{exact:true}).waitFor();
  assert.ok((await page.locator('body').innerText()).includes(remedy));
  assert.ok(!(await page.locator('body').innerText()).includes('synthetic-request'));
  assert.equal(await page.getByRole('link',{name:'Careers ↗',exact:true}).getAttribute('href'),'https://example.test/careers');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  assert.deepEqual(await page.evaluate(()=>window.costQA.calls),[]);
  await page.screenshot({path:path.join(outputDir,`mobile-${issue}.png`),fullPage:true});
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,outputDir,checks:['automatic toggle persistence','empty-string toggle failure retains saved state','direct and deep triggers','zero pauses','blank removes extra cap','limits read back','empty save error visible','admin background controls','390px no overflow','no browser errors','saving one limits form preserves edits in the other','specific failure badges and explanations','saved careers links remain available','viewing failures triggers no check'],width}));
}finally{await browser?.close();await server.close();}
