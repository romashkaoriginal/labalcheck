import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.pdf':'application/pdf','.wasm':'application/wasm','.gz':'application/gzip'};
const server=createServer(async(req,res)=>{
 try{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  const body=await readFile(file);
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(body);
 }catch{res.writeHead(404);res.end();}
});
const close=()=>new Promise(resolve=>server.close(resolve));
const chrome=process.env.CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
assert.ok(chrome,'Set CHROME_PATH to a Chrome/Chromium executable');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({executablePath:chrome,headless:true,args:['--disable-gpu']});
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.waitForFunction(()=>document.querySelectorAll('button.rule-row').length===17,{},{timeout:30000});
 await page.locator('#recognize').click();
 await page.waitForFunction(()=>{const button=document.querySelector('#recognize');return button&&!button.disabled&&button.textContent.includes('Проверить ещё раз');},{},{timeout:300000});
 const rows=await page.locator('button.rule-row').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.rule,status:node.querySelector('.status')?.textContent})));
 assert.equal(rows.length,17);
 assert.equal(rows.find(row=>row.id==='r0')?.status,'Текст найден');
 assert.equal(rows.find(row=>row.id==='r13')?.status,'Текст найден');
 await page.locator('button.rule-row[data-rule="r11"]').click();
 assert.match(await page.locator('.quantity-review').innerText(),/На макете\s+0,7 л/);
 assert.match(await page.locator('.quantity-review').innerText(),/совпадают с Word/);
 assert.deepEqual(errors,[]);
 console.log('Browser smoke passed: contour, product, barcode, physical volume.');
}finally{await browser?.close();await close();}
