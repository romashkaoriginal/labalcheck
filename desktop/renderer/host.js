// The desktop window.
//   «Проверка»    the whole checking interface of the web version, with its
//                 reading order unchanged and its OCR engines replaced by the
//                 ones this app is set to use (renderer/lab) — the product.
//   «Сравнение»   the same pair of files through that and through the web
//                 version exactly as it is on the site, side by side.
//   «Веб-версия»  the site as it is.
// Both are judged by the same comparison code of the web version.
import {evaluate,escapeHtml as esc} from '../../src/engine.js';
import {fromAppWords} from '../shared/ocr-result.mjs';
import {openArtwork,runLocal} from './local-pipeline.js';
import {compareSections,verdictNames,boundsOf} from './compare.js';

const $=id=>document.getElementById(id),plain=value=>JSON.parse(JSON.stringify(value??null));
const frames={best:$('app'),web:$('web')},titles={best:'Настольный режим',web:'Веб-версия как есть'};
const state={docx:null,art:null,rules:[],best:null,web:null,running:false,abort:null,selected:null,onlyDifferent:false,stage:{best:'',web:''},failed:{best:'',web:''},info:null,focus:null,tab:'app'};

// ── A copy of the web version in a frame ────────────────────────────────────
const siteOf=frame=>frame.contentWindow?.__labelCheckState;
const until=(test,timeout,what)=>new Promise((resolve,reject)=>{
 const started=Date.now(),timer=setInterval(()=>{
  let value;try{value=test();}catch(error){clearInterval(timer);reject(error);return;}
  if(value){clearInterval(timer);resolve(value);}
  else if(state.abort?.signal.aborted){clearInterval(timer);reject(Object.assign(new Error('Обработка отменена.'),{code:'CANCELLED'}));}
  else if(Date.now()-started>timeout){clearInterval(timer);reject(Object.assign(new Error(`${what}: время ожидания истекло.`),{code:'TIMEOUT'}));}
 },150);
});
const ready=frame=>until(()=>siteOf(frame)&&frame.contentDocument.querySelector('#docx-input'),30000,'Страница проверки не загрузилась');
// Another page in a frame (lab.html: the same site with replaceable engines).
const open=(frame,page)=>new Promise(resolve=>{frame.addEventListener('load',resolve,{once:true});frame.src=`../web/${page}`;});
function give(frame,inputId,file){
 // The page's own file input, filled the way a person's choice would fill it.
 const input=frame.contentDocument.getElementById(inputId),transfer=new frame.contentWindow.DataTransfer();
 transfer.items.add(new frame.contentWindow.File([file],file.name,{type:file.type}));input.files=transfer.files;input.dispatchEvent(new frame.contentWindow.Event('change',{bubbles:true}));
}
async function loadRequirements(frame,file,volume){
 await ready(frame);const site=siteOf(frame);site.error='';give(frame,'docx-input',file);
 await until(()=>site.error||(site.sourceName===file.name&&site.rules.length>0&&!site.busy),30000,'Требования не разобраны');
 if(site.error&&site.sourceName!==file.name)throw Object.assign(new Error(site.error),{code:'REQUIREMENTS'});
 if(volume&&site.volume!==volume){const input=frame.contentDocument.getElementById('volume');if(input){input.value=volume;input.dispatchEvent(new frame.contentWindow.Event('change',{bubbles:true}));}}
 return {rules:plain(site.rules),volume:site.volume};
}
// One check of the artwork by the page in the frame; what it read and concluded.
async function check(frame,file,onStage=()=>{}){
 const started=performance.now(),site=siteOf(frame);onStage('Открываем макет');
 give(frame,'art-input',file);
 await until(()=>site.busy||site.error,15000,'Проверка не началась');
 const watch=setInterval(()=>{try{onStage(site.busy?site.busyMessage:'');}catch{}},500);
 try{await until(()=>!site.busy&&(site.error||site.fileName===file.name&&site.progress===1),30*60*1000,'Проверка не завершилась');}finally{clearInterval(watch);}
 if(site.error&&!site.words.length)throw Object.assign(new Error(site.error),{code:'CHECK'});
 const page={width:site.image.width,height:site.image.height},matches=site.matches,rows=evaluate(plain(site.rules),site.actual,{volume:site.volume,margin:false,review:{},automatic:matches});
 return {ms:Math.round(performance.now()-started),rows,matches,page,image:site.image,label:plain(site.label),hasContour:site.hasContour,scale:plain(site.scale),words:site.words,secondaryWords:site.secondaryWords,edgeProbes:site.edgeProbes||[],calloutReadings:site.calloutReadings||[],pdfRaster:plain(site.pdfRaster),pageMm:plain(site.pageMm),volume:site.volume};
}
// The web version has no cancel of its own: its page is loaded again, which ends its workers.
const reset=frame=>new Promise(resolve=>{frame.addEventListener('load',resolve,{once:true});frame.contentWindow.location.reload();});

// ── Running ─────────────────────────────────────────────────────────────────
async function run(compare){
 if(state.running||!state.docx||!state.art)return;
 const kinds=compare?['best','web']:['best'];
 Object.assign(state,{running:true,abort:new AbortController(),best:null,web:null,selected:null,failed:{best:'',web:''},stage:{best:'Разбираем требования',web:compare?'ждёт очереди':''},focus:null});
 show(compare?'compare':'app');paint();
 try{
  for(const kind of kinds){
   if(state.abort.signal.aborted){state.failed[kind]='Отменено.';continue;}
   try{
    const requirements=await loadRequirements(frames[kind],state.docx);
    if(kind==='best'){state.rules=requirements.rules;state.selected=state.rules[0]?.id||null;}
    state[kind]={...await check(frames[kind],state.art,text=>{state.stage[kind]=text;paintMethods();}),memory:await window.desktop.memory()};
   }catch(error){
    state.failed[kind]=error.code==='CANCELLED'?'Отменено.':error.message||String(error);
    if(error.code==='CANCELLED')await reset(frames[kind]);else console.error(kind,error);
   }
   state.stage[kind]='';paint();
  }
 }finally{state.running=false;state.abort=null;paint();}
}

// ── Painting ────────────────────────────────────────────────────────────────
function notice(text,error=false){const node=$('notice');node.hidden=!text;node.textContent=text||'';node.classList.toggle('error',error);}
const seconds=ms=>ms>=10000?`${Math.round(ms/1000)} с`:`${(ms/1000).toFixed(1)} с`;
const engineNames={tesseract:'Tesseract.js',local:'локальный движок (нативный ONNX Runtime)',web:'PaddleOCR в WASM',none:'нет'};
let cached=null;
function sections(){
 if(cached&&cached.web===state.web&&cached.best===state.best&&cached.rules===state.rules)return cached.list;
 cached={web:state.web,best:state.best,rules:state.rules,list:compareSections(state.rules,state.web,state.best)};return cached.list;
}
const field=kind=>kind==='web'?'baseline':'local';
function methodCard(kind,about){
 const data=state[kind],failed=state.failed[kind],stage=state.stage[kind];
 const summary=data?Object.entries(sections().reduce((all,item)=>{const verdict=item[field(kind)];if(verdict&&verdict!=='skip')all[verdict]=(all[verdict]||0)+1;return all;},{})).map(([verdict,count])=>`${verdictNames[verdict].toLowerCase()}: ${count}`).join(' · '):'';
 return `<div class="method ${kind}"><h2>${titles[kind]}</h2><p>${about}</p>${failed?`<p class="failed">${esc(failed)}</p>`:data?`<p class="figures">${seconds(data.ms)} · прочитано слов: ${data.words.length}</p><p>${esc(summary)}</p>`:stage?`<p>${esc(stage)}</p><progress></progress>`:'<p>ещё не запускался</p>'}</div>`;
}
function paintMethods(){
 const product=state.info?.product||{};
 $('methods').innerHTML=methodCard('best',`порядок чтения сайта; первый движок — ${esc(engineNames[product.primary]||'')}, второй — ${esc(engineNames[product.second]||'')}`)+methodCard('web','Tesseract.js и PaddleOCR в WASM, как на сайте');
}
const badge=(verdict,waiting)=>verdict?`<span class="verdict ${verdict}">${verdictNames[verdict]}</span>`:`<span class="verdict wait">${waiting}</span>`;
function paintSections(){
 const list=sections(),shown=list.filter(item=>!state.onlyDifferent||item.verdictsDiffer||item.readingsDiffer);
 $('counts').textContent=state.web&&state.best?`разный вывод: ${list.filter(item=>item.verdictsDiffer).length} · разное чтение: ${list.filter(item=>item.readingsDiffer).length} из ${list.length}`:'';
 if(!list.length){$('sections').innerHTML='';return;}
 const waiting=kind=>state.failed[kind]?'нет':state.stage[kind]?'ждёт':'—';
 $('sections').innerHTML=`<table><thead><tr><th>Раздел</th><th>${titles.best}</th><th>${titles.web}</th><th>Расхождение</th></tr></thead><tbody>${shown.map(item=>`<tr class="row${item.id===state.selected?' selected':''}" data-id="${esc(item.id)}" tabindex="0"><td>${esc(item.title)}</td><td>${badge(item.local,waiting('best'))}</td><td>${badge(item.baseline,waiting('web'))}</td><td>${item.verdictsDiffer?'<span class="mark">≠ вывод</span>':item.numbersDiffer?'<span class="mark">≠ числа</span>':item.readingsDiffer?'<span class="mark quiet">≠ слова</span>':''}</td></tr>`).join('')}</tbody></table>`;
}
const marked=tokens=>tokens.map(item=>item.same?esc(item.token):`<b>${esc(item.token)}</b>`).join(' ');
const absent=change=>change.anchored?'нет на макете':'не найдено: нет на макете либо не прочитано';
function reading(kind,item){
 const web=kind==='web',match=web?item.baselineMatch:item.localMatch,verdict=item[field(kind)],side=web?item.diff?.left:item.diff?.right,row=web?item.baselineRow:item.localRow;
 if(!state[kind])return `<div class="reading ${kind}"><h4>${titles[kind]}</h4><p class="where">${esc(state.failed[kind]||state.stage[kind]||'не запускался')}</p></div>`;
 const text=match?.recognizedText?(side?marked(side):esc(match.recognizedText)):'<span class="where">фраза не найдена</span>';
 const changes=(match?.diff||[]).map(change=>`<li>Word: ${esc(change.expected||'нет в требовании')} → ${esc(change.actual||absent(change))}${change.kind==='uncertain'||!(change.confidence>=75)&&!change.anchored?' <em>(неуверенно)</em>':''}</li>`).join('');
 const sizes=(row?.dimensions||[]).filter(size=>size.value!=null).map(size=>`${esc(size.label)}: ${size.meta?.method==='declared'?'заявлено ':size.estimated?'≈ ':''}${String(Math.round(size.value*100)/100).replace('.',',')} ${esc(size.unit)} при минимуме ${String(size.min).replace('.',',')}`).join(' · ');
 const box=boundsOf(match?.boxes),where=box?`участок листа: ${Math.round(box.x*100)}–${Math.round((box.x+box.w)*100)} % по ширине, ${Math.round(box.y*100)}–${Math.round((box.y+box.h)*100)} % по высоте${match.rotation?` · текст повёрнут на ${match.rotation}°`:''}`:'участок не определён';
 return `<div class="reading ${kind}"><h4><span>${titles[kind]}</span>${badge(verdict,'—')}</h4><div class="text">${text}</div>${changes?`<ul>${changes}</ul>`:''}${sizes?`<p class="where">${sizes}</p>`:''}<p class="where">${where}</p><canvas data-crop="${kind}"></canvas></div>`;
}
const sheetImage=()=>state.best?.image||state.web?.image||null;
function paintDetail(){
 const item=sections().find(entry=>entry.id===state.selected);
 if(!item||!state.best&&!state.web){$('detail').innerHTML='';return;}
 $('detail').innerHTML=`<h3>${esc(item.title)}</h3><div class="expected">${esc(item.expected||'В Word текст не задан')}</div><div class="readings">${reading('best',item)}${reading('web',item)}</div><p class="note">Выделены слова и числа, которые есть в чтении одного метода и отсутствуют в чтении другого. Вырез под каждым чтением — участок макета, из которого оно получено.</p>`;
 for(const kind of ['best','web']){
  const canvas=$('detail').querySelector(`canvas[data-crop="${kind}"]`),match=kind==='web'?item.baselineMatch:item.localMatch,box=boundsOf(match?.boxes),page=sheetImage();
  if(!canvas)continue;if(!box||!page){canvas.remove();continue;}
  // The same pixels for both methods: places are kept as shares of the page.
  const pad=Math.max(box.w,box.h)*.06,x=Math.max(0,(box.x-pad)*page.width),y=Math.max(0,(box.y-pad)*page.height),w=Math.min(page.width-x,(box.w+pad*2)*page.width),h=Math.min(page.height-y,(box.h+pad*2)*page.height),zoom=Math.min(1.5,520/Math.max(w,1),700/Math.max(h,1));
  canvas.width=Math.round(w*zoom);canvas.height=Math.round(h*zoom);const context=canvas.getContext('2d');context.imageSmoothingQuality='high';context.drawImage(page,x,y,w,h,0,0,canvas.width,canvas.height);
  context.strokeStyle=kind==='web'?'#2563eb':'#d9620b';context.lineWidth=1;
  for(const part of match.boxes)context.strokeRect((part.x*page.width-x)*zoom,(part.y*page.height-y)*zoom,part.w*page.width*zoom,part.h*page.height*zoom);
 }
}
function paintSheet(){
 const canvas=$('sheet'),page=sheetImage(),view=$('sheet-view');$('sheet-empty').hidden=!!page;canvas.hidden=!page;if(!page||state.tab!=='compare')return;
 const item=sections().find(entry=>entry.id===state.selected),boxes={web:item?.baselineMatch?.boxes||[],best:item?.localMatch?.boxes||[]},all=boundsOf([...boxes.web,...boxes.best]);
 const fit=(view.clientWidth-24)/page.width,zoom=state.focus&&all?Math.min(1.2,Math.max(fit,Math.min((view.clientWidth*.6)/(all.w*page.width),(view.clientHeight*.4)/(all.h*page.height)))):fit;
 canvas.width=page.width;canvas.height=page.height;canvas.style.width=Math.round(page.width*zoom)+'px';
 const context=canvas.getContext('2d');context.drawImage(page,0,0);context.lineWidth=Math.max(2,2/zoom);
 for(const [kind,colour] of [['web','#2563eb'],['best','#d9620b']])for(const box of boxes[kind]){context.fillStyle=colour+'14';context.strokeStyle=colour;const inset=kind==='best'?context.lineWidth:0;context.fillRect(box.x*page.width,box.y*page.height,box.w*page.width,box.h*page.height);context.strokeRect(box.x*page.width+inset,box.y*page.height+inset,box.w*page.width-inset*2,box.h*page.height-inset*2);}
 if(state.focus&&all){view.scrollLeft=Math.max(0,(all.x+all.w/2)*page.width*zoom-view.clientWidth/2);view.scrollTop=Math.max(0,(all.y+all.h/2)*page.height*zoom-view.clientHeight/2);}
}
function paint(){
 const ready=!state.running&&state.docx&&state.art&&state.info?.modelsReady;
 $('run').disabled=!ready;$('run-compare').disabled=!ready;$('cancel').hidden=!state.running;
 $('docx-name').textContent=state.docx?.name||'DOCX или TXT';$('art-name').textContent=state.art?.name||'PDF или изображение';
 $('pick-docx').classList.toggle('filled',!!state.docx);$('pick-art').classList.toggle('filled',!!state.art);
 paintMethods();paintSections();paintDetail();paintSheet();
}
function select(id){state.selected=id;state.focus=true;paintSections();paintDetail();paintSheet();$('sections').querySelector('.row.selected')?.scrollIntoView({block:'nearest'});}
function show(tab){
 state.tab=tab;
 for(const name of ['app','compare','web'])$(`tab-${name}`).setAttribute('aria-selected',String(name===tab));
 $('compare').hidden=tab!=='compare';frames.best.classList.toggle('parked',tab!=='app');frames.web.classList.toggle('parked',tab!=='web');
 if(tab==='compare')paintSheet();
}

// ── Wiring ──────────────────────────────────────────────────────────────────
$('docx').addEventListener('change',event=>{state.docx=event.target.files[0]||null;paint();});
$('art').addEventListener('change',event=>{state.art=event.target.files[0]||null;paint();});
$('run').addEventListener('click',()=>run(false));
$('run-compare').addEventListener('click',()=>run(true));
$('cancel').addEventListener('click',()=>state.abort?.abort());
$('fit').addEventListener('click',()=>{state.focus=null;paintSheet();});
$('only-different').addEventListener('change',event=>{state.onlyDifferent=event.target.checked;paintSections();});
$('sections').addEventListener('click',event=>{const row=event.target.closest('.row');if(row)select(row.dataset.id);});
$('sections').addEventListener('keydown',event=>{const row=event.target.closest('.row');if(row&&(event.key==='Enter'||event.key===' ')){event.preventDefault();select(row.dataset.id);}});
for(const tab of ['app','compare','web'])$(`tab-${tab}`).addEventListener('click',()=>show(tab));
// Which engine reads first and which gives the second opinion; the checking page is loaded again with them.
const useEngines=async value=>{const [primary,second]=value.split('-');state.info.product={primary,second};state.best=null;await open(frames.best,`lab.html?audit&primary=${primary}&second=${second}`);paint();};
$('engines').addEventListener('change',event=>{if(state.running){event.target.value=`${state.info.product.primary}-${state.info.product.second}`;return;}useEngines(event.target.value);});
window.addEventListener('resize',()=>paintSheet());
// Files dropped on the window's own bar go to the picker they belong to.
window.addEventListener('dragover',event=>event.preventDefault());
window.addEventListener('drop',event=>{event.preventDefault();for(const file of event.dataTransfer?.files||[]){if(/\.(docx|txt)$/i.test(file.name))state.docx=file;else if(/\.(pdf|png|jpe?g|webp)$/i.test(file.name))state.art=file;}paint();});

const query=new URLSearchParams(location.search),scripted=query.has('bench');
state.info=await window.desktop.info();
if(!state.info.modelsReady)notice('Модели локального OCR не найдены. Выполните «npm run models» в каталоге desktop и запустите приложение снова.',true);
// The product: the site's pages with the engines this app is set to use.
if(!scripted){$('engines').value=`${state.info.product.primary}-${state.info.product.second}`;await useEngines($('engines').value||'tesseract-local');}
show('app');paint();

const benchFile=async(role,name)=>new File([await window.desktop.bench.file(role)],name,{type:/\.pdf$/i.test(name)?'application/pdf':/\.png$/i.test(name)?'image/png':/\.jpe?g$/i.test(name)?'image/jpeg':''});
// electron . --demo=<sheet>: the two files of a corpus sheet, chosen and compared as a person would.
if(query.has('demo')){
 const plan=await window.desktop.bench.plan();
 state.docx=await benchFile('requirements',plan.sheet.requirementsName);state.art=await benchFile('artwork',plan.sheet.artworkName);paint();
 await run(true);
 const differing=sections().find(item=>item.verdictsDiffer)||sections().find(item=>item.readingsDiffer);
 if(differing)select(differing.id);
 await new Promise(resolve=>setTimeout(resolve,400));await window.desktop.bench.shot(`demo-${plan.sheet.id}-compare`);
 show('app');await new Promise(resolve=>setTimeout(resolve,800));await window.desktop.bench.shot(`demo-${plan.sheet.id}-app`);
}
// ── Scripted comparison (electron . --bench) ────────────────────────────────
// One method on one sheet; its readings, time and memory are saved for
// bench/score.mjs. Methods: baseline (the site as it is), lab-<first>-<second>
// (the site's reading order with replaced engines), local (the simple local
// method of renderer/local-pipeline.js, which reads the label and nothing else).
if(scripted){
 const method=query.get('bench'),engines=method.match(/^lab-(\w+)-(\w+)$/),frame=frames.web;let summary={};
 try{
  if(engines)await open(frame,`lab.html?audit&primary=${engines[1]}&second=${engines[2]}`);
  const plan=await window.desktop.bench.plan(),docx=await benchFile('requirements',plan.sheet.requirementsName),art=await benchFile('artwork',plan.sheet.artworkName);
  state.abort=new AbortController();
  const requirements=await loadRequirements(frame,docx,plan.sheet.volume);
  // Time and memory are counted from here: the files are in hand, nothing has been read yet.
  await window.desktop.bench.phase('start');const started=performance.now();
  if(method==='local'){
   const artwork=await openArtwork(art),local=await runLocal({artwork,rules:requirements.rules,volume:requirements.volume,models:plan.models});
   const ms=Math.round(performance.now()-started),memory=await window.desktop.bench.phase('stop');
   await window.desktop.bench.save(`${plan.sheet.id}-local`,{sheet:plan.sheet.id,method,rules:requirements.rules,volume:requirements.volume,result:local.result,timings:local.timings,ms,memory});
   summary={ms,memory,words:local.result.words.length};
  }else{
   const done=await check(frame,art),memory=await window.desktop.bench.phase('stop');
   const sizes=done.rows.map(row=>({id:row.id,title:row.title,status:row.status,statusLabel:row.statusLabel,dimensions:row.dimensions.map(item=>({label:item.label,min:item.min,unit:item.unit,value:item.value??null,estimated:!!item.estimated,pass:!!item.pass,borderline:!!item.borderline,method:item.meta?.method||null}))}));
   await window.desktop.bench.save(`${plan.sheet.id}-${method}`,{sheet:plan.sheet.id,method,sizes,rules:requirements.rules,volume:done.volume,result:fromAppWords(done.words,done.page,{method,scale:done.scale&&{mmPerPixel:done.scale.mmPerPixel,level:done.scale.level,origin:done.scale.source}}),
    run:plain({words:done.words,secondaryWords:done.secondaryWords,edgeProbes:done.edgeProbes,calloutReadings:done.calloutReadings,label:done.label,hasContour:done.hasContour,scale:done.scale,image:done.page,pdfRaster:done.pdfRaster,pageMm:done.pageMm}),ms:done.ms,memory});
   summary={ms:done.ms,memory,words:done.words.length};
  }
 }catch(error){summary={error:error.message||String(error)};console.error(error);}
 window.desktop.bench.done(summary);
}
