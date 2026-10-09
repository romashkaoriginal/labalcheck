// A real run of the built site in Chrome, returning what the page computed.
// The page exposes its state under ?audit as window.__labelCheckState; nothing
// is read from the screen except the status labels a person would see.
//
//   node scripts/browser-run.mjs --docx req.docx --art sheet.pdf --out run.json
//   node scripts/browser-run.mjs --out run.json            (the bundled sample)
import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';

const dist=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.pdf':'application/pdf','.wasm':'application/wasm','.gz':'application/gzip'};
const chromePath=()=>process.env.CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);

export async function serveDist(root=dist){
 const server=createServer(async(req,res)=>{
  try{
   const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
   if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
   const body=await readFile(file);
   res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(body);
  }catch{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}/`,close:()=>new Promise(resolve=>server.close(resolve))};
}

// Runs one sheet. Without docx and artwork the bundled sample is analysed.
export async function browserRun({docx,artwork,volume,timeout=900000,log=()=>{}}={}){
 const chrome=chromePath();assert.ok(chrome,'Set CHROME_PATH to a Chrome/Chromium executable');
 for(const file of [docx,artwork])if(file)assert.ok(existsSync(file),`No such file: ${file}`);
 assert.equal(!docx,!artwork,'Give both --docx and --art, or neither for the bundled sample');
 const server=await serveDist();let browser;
 try{
  browser=await chromium.launch({executablePath:chrome,headless:true,args:['--disable-gpu']});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  if(docx){await page.route('**/assets/sample.docx',route=>route.abort());await page.route('**/assets/sample.pdf',route=>route.abort());}
  await page.goto(server.url+'?audit');
  const done=()=>page.waitForFunction(()=>{const button=document.querySelector('#recognize');return button&&!button.disabled&&button.textContent.includes('Проверить ещё раз');},undefined,{timeout});
  const started=Date.now(),timer=setInterval(async()=>{try{log(`${Math.round((Date.now()-started)/1000)} s · ${await page.locator('.progress-panel span').first().textContent({timeout:800})}`);}catch{}},20000);
  try{
   if(docx){
    await page.waitForSelector('#docx-input',{state:'attached'});
    await page.locator('#docx-input').setInputFiles(docx);
    await page.waitForFunction(()=>window.__labelCheckState?.rules.length>0&&!window.__labelCheckState.busy,undefined,{timeout:30000});
    if(volume){await page.locator('#volume').fill(volume);await page.locator('#volume').dispatchEvent('change');}
    await page.locator('#art-input').setInputFiles(artwork);
   }else{
    await page.waitForFunction(()=>window.__labelCheckState?.rules.length>0&&window.__labelCheckState.image&&!window.__labelCheckState.busy,undefined,{timeout:30000});
    await page.locator('#recognize').click();
   }
   await done();
  }finally{clearInterval(timer);}
  const run=await page.evaluate(()=>{
   const s=window.__labelCheckState,plain=value=>JSON.parse(JSON.stringify(value??null));
   return {volume:s.volume,product:s.product,fileName:s.fileName,sourceName:s.sourceName,rules:plain(s.rules),label:plain(s.label),hasContour:s.hasContour,scale:plain(s.scale),pageMm:plain(s.pageMm),image:{width:s.image.width,height:s.image.height},
    words:plain(s.words),secondaryWords:plain(s.secondaryWords),calloutReadings:plain(s.calloutReadings),edgeProbes:plain(s.edgeProbes||[]),pdfRaster:plain(s.pdfRaster),actual:s.actual,error:s.error||'',
    rows:[...document.querySelectorAll('button.rule-row')].map(node=>({id:node.dataset.rule,title:node.querySelector('.rule-content strong')?.textContent,status:node.querySelector('.status')?.textContent}))};
  });
  return {...run,ms:Date.now()-started,errors};
 }finally{await browser?.close();await server.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),value=name=>{const at=args.indexOf('--'+name);return at>=0?args[at+1]:undefined;};
 const out=value('out');assert.ok(out,'Usage: node scripts/browser-run.mjs [--docx file --art file] [--volume 0,7] --out run.json');
 const run=await browserRun({docx:value('docx'),artwork:value('art'),volume:value('volume'),log:line=>console.log(line)});
 writeFileSync(out,JSON.stringify(run));
 console.log(`${run.fileName}: ${run.rows.length} разделов, ${run.words.length} слов OCR, ${run.calloutReadings.length} выносок, ${Math.round(run.ms/1000)} с${run.errors.length?' · ошибки: '+run.errors.join('; '):''}`);
 for(const row of run.rows)console.log(` ${row.id}\t${row.status}\t${row.title}`);
}
