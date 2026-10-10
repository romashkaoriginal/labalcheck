// Main process of the experimental desktop shell. It owns three things:
// the window, the app:// pages served to it from the build folder, and the
// OCR utility process. It reads no user documents: files reach the page
// through the page's own file picker, and only pixels go on to the OCR process.
import {app,BrowserWindow,ipcMain,protocol,session,utilityProcess,Menu} from 'electron';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root=app.getAppPath(),pages=path.join(root,'build'),modelsDir=path.join(root,'models'),origin='app://label-check';
const argument=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const benchMode=process.argv.includes('--bench');
const defaults={det:argument('det')||'PP-OCRv6_medium_det',rec:argument('rec')||'eslav_PP-OCRv5_mobile_rec'};
// The engines of the «Проверка» page: who reads first and who gives the second opinion (see docs/desktop-spike/RESULTS.md).
const product={primary:argument('primary')||'local',second:argument('second')||'tesseract'};

protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.pdf':'application/pdf','.gz':'application/gzip','.tar':'application/x-tar','.wasm':'application/wasm','.bcmap':'application/octet-stream','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
// Pages may load their own files and nothing else: no remote script, no remote request.
const policy=scripts=>`default-src 'self' blob: data:; script-src 'self' ${scripts} blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'`;
// The web version's PaddleOCR SDK (OpenCV.js) evaluates strings and stops
// working without 'unsafe-eval'; it gets it for its own pages only. The page
// of the desktop shell does not.
const policies={web:policy("'unsafe-eval' 'wasm-unsafe-eval'"),desktop:policy("'wasm-unsafe-eval'")};
async function serve(request){
 const url=new URL(request.url);
 if(url.host!=='label-check')return new Response('',{status:404});
 const name=decodeURIComponent(url.pathname),file=path.resolve(pages,'.'+(name.endsWith('/')?name+'index.html':name));
 if(!file.startsWith(pages+path.sep))return new Response('',{status:403});
 try{return new Response(await readFile(file),{headers:{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Security-Policy':name.startsWith('/web/')?policies.web:policies.desktop,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});}
 catch{return new Response('',{status:404});}
}

// ── OCR process ─────────────────────────────────────────────────────────────
let ocr=null;const jobs=new Map();
const fail=(id,error)=>{const job=jobs.get(id);if(!job)return;jobs.delete(id);clearTimeout(job.killer);job.resolve({error});};
function ocrProcess(){
 if(ocr)return ocr;
 const child=utilityProcess.fork(path.join(root,'src/ocr/worker.mjs'),[],{serviceName:'label-check-ocr',stdio:'inherit',env:{...process.env,LABEL_CHECK_MODELS:modelsDir}});
 child.on('message',message=>{
  const job=jobs.get(message.id);if(!job)return;
  if(message.type==='progress'){if(!job.sender.isDestroyed())job.sender.send('ocr:progress',{id:message.id,stage:message.stage,done:message.done,total:message.total});return;}
  jobs.delete(message.id);clearTimeout(job.killer);
  job.resolve(message.type==='result'?{result:message.result,engine:message.engine,loadMs:message.loadMs}:{error:message.error});
 });
 child.on('exit',code=>{
  if(ocr===child)ocr=null;
  for(const id of [...jobs.keys()])fail(id,jobs.get(id).cancelling?{code:'CANCELLED',message:'Обработка отменена.',stage:'process',retryable:false}:{code:'PROCESS_EXITED',message:`Процесс распознавания завершился (код ${code}). Повторите проверку.`,stage:'process',retryable:true});
 });
 return ocr=child;
}
function stopOcr(){const child=ocr;ocr=null;child?.kill();}

const modelsOf=job=>({det:job.models?.det||defaults.det,rec:job.models?.rec||defaults.rec});
ipcMain.handle('ocr:recognize',(event,job)=>new Promise(resolve=>{
 if(!job?.id||!job.image?.data||!(job.image.width>0)||!(job.image.height>0))return resolve({error:{code:'BAD_INPUT',message:'Изображение для распознавания не передано.',stage:'input',retryable:false}});
 jobs.set(job.id,{resolve,sender:event.sender});
 ocrProcess().postMessage({type:'recognize',id:job.id,image:job.image,models:modelsOf(job),options:{scale:job.options?.scale||1,upright:job.options?.upright===true,allow:String(job.options?.allow||'')}});
}));
// Lines already cut out by the page: reading only, no search for lines.
ipcMain.handle('ocr:lines',(event,job)=>new Promise(resolve=>{
 if(!job?.id||!Array.isArray(job.images)||job.images.some(image=>!image?.data||!(image.width>0)||!(image.height>0)))return resolve({error:{code:'BAD_INPUT',message:'Изображения строк не переданы.',stage:'input',retryable:false}});
 jobs.set(job.id,{resolve,sender:event.sender});
 ocrProcess().postMessage({type:'lines',id:job.id,images:job.images,models:modelsOf(job),options:{allow:String(job.options?.allow||'')}});
}));
// A cancel is a request first. The engine stops between two steps; if it has
// not answered in five seconds the process is ended and started again later.
ipcMain.on('ocr:cancel',(_event,id)=>{
 const job=jobs.get(id);if(!job||job.cancelling)return;
 job.cancelling=true;ocr?.postMessage({type:'cancel',id});
 job.killer=setTimeout(()=>{if(jobs.has(id))stopOcr();},5000);
});

const megabytes=kilobytes=>Math.round(kilobytes/1024);
function memoryNow(){
 const byType={};let total=0;
 for(const item of app.getAppMetrics()){const name=item.type==='Utility'?(item.serviceName||item.name||'Utility'):item.type;byType[name]=(byType[name]||0)+item.memory.workingSetSize;total+=item.memory.workingSetSize;}
 return {totalMb:megabytes(total),byTypeMb:Object.fromEntries(Object.entries(byType).map(([name,value])=>[name,megabytes(value)]))};
}
ipcMain.handle('app:memory',()=>memoryNow());
ipcMain.handle('app:info',()=>({version:app.getVersion(),electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node,models:defaults,product,modelsReady:['det','rec'].every(kind=>existsSync(path.join(modelsDir,defaults[kind],'inference.onnx'))),cpu:os.cpus()[0]?.model||'',threads:os.cpus().length,ramGb:Math.round(os.totalmem()/2**30),bench:benchMode}));

function createWindow(query=''){
 const window=new BrowserWindow({width:1480,height:940,minWidth:1100,minHeight:700,backgroundColor:'#f5f6f8',title:'Контроль маркировки — настольный эксперимент',show:false,
  webPreferences:{preload:path.join(root,'src/preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false,spellcheck:false}});
 window.once('ready-to-show',()=>benchMode?window.showInactive():window.show());
 window.loadURL(`${origin}/desktop/index.html${query}`);
 return window;
}

// ── Scripted comparison: electron . --bench ─────────────────────────────────
// One fresh window per sheet and method, one after another, so that neither
// time nor memory of one run leaks into the next.
const bench={runs:[],current:null,sampler:null,peak:null,results:[]};
function corpus(){
 const file=argument('corpus')?path.resolve(argument('corpus')):path.join(root,'bench/corpus.json'),dir=process.env.LABEL_CORPUS_DIR||path.join(os.homedir(),'Downloads'),repo=path.resolve(root,'..');
 const locate=name=>name.startsWith('repo:')?path.join(repo,name.slice(5)):name.startsWith('corpus:')?path.join(dir,name.slice(7)):path.resolve(name);
 return JSON.parse(readFileSync(file,'utf8')).sheets.map(sheet=>({...sheet,artwork:locate(sheet.artwork),requirements:locate(sheet.requirements)}));
}
function nextRun(){
 clearInterval(bench.sampler);stopOcr();
 const run=bench.runs.shift();
 if(!run){writeFileSync(path.join(root,'bench/out/summary.json'),JSON.stringify({finished:new Date().toISOString(),machine:{cpu:os.cpus()[0]?.model,threads:os.cpus().length,ramGb:Math.round(os.totalmem()/2**30),os:`${os.type()} ${os.release()}`},versions:{electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node},models:defaults,runs:bench.results},null,1));app.quit();return;}
 bench.current={...run,window:createWindow(`?bench=${run.method}&sheet=${encodeURIComponent(run.sheet.id)}`),timeout:setTimeout(()=>finishRun({error:'Время ожидания истекло (20 минут).'}),20*60*1000)};
 console.log(`bench: ${run.sheet.id} · ${run.method}`);
}
function finishRun(summary){
 const run=bench.current;if(!run)return;bench.current=null;clearTimeout(run.timeout);clearInterval(bench.sampler);
 bench.results.push({sheet:run.sheet.id,method:run.method,...summary});
 console.log(`bench: ${run.sheet.id} · ${run.method} · ${summary.error?'ошибка: '+summary.error:Math.round(summary.ms/1000)+' с · пик '+summary.memory?.peakTotalMb+' МБ'}`);
 if(!run.window.isDestroyed())run.window.destroy();
 setTimeout(nextRun,1500);
}
ipcMain.handle('bench:plan',()=>bench.current&&{sheet:{id:bench.current.sheet.id,title:bench.current.sheet.title,volume:bench.current.sheet.volume,artworkName:path.basename(bench.current.sheet.artwork),requirementsName:path.basename(bench.current.sheet.requirements)},method:bench.current.method,models:defaults,scale:Number(argument('scale')||0)||undefined});
// Only the two files of the sheet being measured, by role — never a path from the page.
ipcMain.handle('bench:file',(_event,role)=>{const sheet=bench.current?.sheet,file=role==='artwork'?sheet?.artwork:role==='requirements'?sheet?.requirements:null;if(!file)throw new Error('Нет такого файла в плане.');return readFileSync(file);});
ipcMain.handle('bench:phase',(_event,name)=>{
 if(name==='start'){const idle=memoryNow();bench.peak={idleTotalMb:idle.totalMb,peakTotalMb:idle.totalMb,peakByTypeMb:{...idle.byTypeMb}};clearInterval(bench.sampler);
  bench.sampler=setInterval(()=>{const now=memoryNow();bench.peak.peakTotalMb=Math.max(bench.peak.peakTotalMb,now.totalMb);for(const [type,value] of Object.entries(now.byTypeMb))bench.peak.peakByTypeMb[type]=Math.max(bench.peak.peakByTypeMb[type]||0,value);},200);return idle;}
 clearInterval(bench.sampler);return bench.peak;
});
ipcMain.handle('bench:save',(_event,name,data)=>{const out=path.join(root,'bench/out');mkdirSync(out,{recursive:true});writeFileSync(path.join(out,String(name).replace(/[^\w.-]/g,'_')+'.json'),JSON.stringify(data));});
ipcMain.on('bench:done',(_event,summary)=>finishRun(summary||{}));
// A picture of the window as it stands, for checking the interface without a person at the screen.
ipcMain.handle('bench:shot',async(event,name)=>{const out=path.join(root,'bench/out');mkdirSync(out,{recursive:true});writeFileSync(path.join(out,String(name).replace(/[^\w.-]/g,'_')+'.png'),(await event.sender.capturePage()).toPNG());});

app.on('web-contents-created',(_event,contents)=>{
 contents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/'))event.preventDefault();});
 contents.on('will-attach-webview',event=>event.preventDefault());
 contents.setWindowOpenHandler(()=>({action:'deny'}));
 // Errors of the pages, and a reading engine that gave up, are shown where the app was started from.
 contents.on('console-message',(event,...old)=>{const level=event.level??old[0],message=event.message??old[1];const text=String(message);if(level==='error'||level===3||(level==='warning'||level===2)&&/unavailable|Error/.test(text))console.error(`[page] ${text.slice(0,600)}`);});
});
app.on('window-all-closed',()=>{if(!benchMode){stopOcr();app.quit();}});

app.whenReady().then(()=>{
 protocol.handle('app',serve);
 // Nothing leaves the machine: every request that is not to the app's own pages is refused.
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!/^(app|blob|data|devtools|chrome-extension):/.test(details.url)}));
 session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 if(app.isPackaged)Menu.setApplicationMenu(null);
 if(!existsSync(path.join(pages,'desktop/index.html'))){console.error('Нет собранных страниц: выполните «npm run build» в каталоге desktop.');app.exit(1);return;}
 if(benchMode){
  const only=argument('sheets')?.split(','),methods=(argument('methods')||'local,baseline').split(',');
  for(const sheet of corpus().filter(item=>!only||only.includes(item.id))){
   if(!existsSync(sheet.artwork)||!existsSync(sheet.requirements)){console.error(`bench: нет файлов листа ${sheet.id} (${sheet.artwork})`);continue;}
   for(const method of methods)bench.runs.push({sheet,method});
  }
  mkdirSync(path.join(root,'bench/out'),{recursive:true});nextRun();
 }else if(argument('demo')){
  // electron . --demo=<sheet>: the ordinary window, with the two files of a corpus sheet already chosen and compared.
  const sheet=corpus().find(item=>item.id===argument('demo'));
  if(!sheet){console.error(`Нет листа ${argument('demo')} в bench/corpus.json.`);app.exit(1);return;}
  bench.current={sheet,method:'demo',window:createWindow('?demo=1')};
 }else createWindow();
});
