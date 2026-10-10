// The local OCR method: PaddleOCR detection and recognition models run by the
// native ONNX Runtime. No expected text of any kind enters this file — it sees
// pixels and returns what it read, with the place of every word on the image.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {toTensor,lineTensor,lineLayout,extendLines,uprightSize,regions,quarterTurn} from './imaging.mjs';

export class OcrError extends Error{
 constructor(code,message,{stage='',retryable=false,cause}={}){super(message,{cause});this.name='OcrError';this.code=code;this.stage=stage;this.retryable=retryable;}
 toJSON(){return {code:this.code,message:this.message,stage:this.stage,retryable:this.retryable};}
}
const cancelled=stage=>new OcrError('CANCELLED','Обработка отменена.',{stage});
const failure=(stage,what,cause)=>new OcrError(/alloc|memory/i.test(cause.message)?'OUT_OF_MEMORY':'INFERENCE_FAILED',`${what}: ${cause.message}`,{stage,retryable:true,cause});

// inference.yml is written by PaddleOCR's exporter. Only the post-processing
// numbers and the character list are read from it.
export function readConfig(file){
 let text;
 try{text=readFileSync(file,'utf8');}catch(cause){throw new OcrError('MODEL_MISSING',`Нет файла модели: ${file}. Выполните «npm run models».`,{stage:'load',cause});}
 const number=name=>{const match=text.match(new RegExp(`^\\s*${name}:\\s*([\\d.]+)\\s*$`,'m'));return match?Number(match[1]):null;};
 const lines=text.split(/\r?\n/),start=lines.findIndex(line=>/^\s*character_dict:\s*$/.test(line)),characters=[];
 if(start>=0)for(let i=start+1;i<lines.length;i++){
  const match=lines[i].match(/^\s*-\s?(.*)$/);if(!match)break;
  let value=match[1];
  if(value.startsWith("'"))value=value.slice(1,-1).replaceAll("''","'");else if(value.startsWith('"'))value=JSON.parse(value);
  characters.push(value);
 }
 return {name:text.match(/model_name:\s*(\S+)/)?.[1]||path.basename(path.dirname(file)),thresh:number('thresh'),boxThresh:number('box_thresh'),unclipRatio:number('unclip_ratio'),characters};
}

export async function createEngine({modelsDir,det='PP-OCRv6_medium_det',rec='eslav_PP-OCRv5_mobile_rec',threads=0}={}){
 let ort;
 try{ort=await import('onnxruntime-node');}catch(cause){throw new OcrError('RUNTIME_MISSING','Не установлен onnxruntime-node. Выполните «npm install» в каталоге desktop.',{stage:'load',cause});}
 // No memory arena: the runtime then returns what one large page took
 // instead of keeping it for the life of the process.
 const options={intraOpNumThreads:threads,interOpNumThreads:1,graphOptimizationLevel:'all',logSeverityLevel:3},lean={...options,enableCpuMemArena:false,enableMemPattern:false};
 const open=async(name,settings)=>{
  try{return await ort.InferenceSession.create(path.join(modelsDir,name,'inference.onnx'),settings);}
  catch(cause){throw new OcrError('MODEL_MISSING',`Модель ${name} не загружена: ${cause.message}. Выполните «npm run models».`,{stage:'load',cause});}
 };
 const detConfig=readConfig(path.join(modelsDir,det,'inference.yml')),recConfig=readConfig(path.join(modelsDir,rec,'inference.yml'));
 if(!recConfig.characters.length)throw new OcrError('MODEL_MISSING',`В ${rec}/inference.yml нет списка символов.`,{stage:'load'});
 // The detector takes a whole page at once and would keep that memory for
 // good; the recogniser takes small batches and is faster with an arena.
 const detSession=await open(det,lean),recSession=await open(rec,options);
 // Index 0 is the CTC blank; the list is followed by the space.
 const alphabet=['',...recConfig.characters,' '];

 // Boxes of text lines in the pixels of `image`. `scale` enlarges the image
 // for the detector only: small print is found more reliably at the letter
 // size the model was trained on, and the reading below still uses the
 // original pixels.
 async function detect(image,{scale=1,maxSide=4000}={}){
  const fit=Math.min(scale,maxSide/Math.max(image.width,image.height)),round=value=>Math.max(32,Math.round(value*fit/32)*32);
  const width=round(image.width),height=round(image.height);
  const input=toTensor(image,width,height,[.485,.456,.406],[.229,.224,.225]);
  let output;
  try{output=await detSession.run({[detSession.inputNames[0]]:new ort.Tensor('float32',input,[1,3,height,width])});}
  catch(cause){throw failure('detect','Поиск строк не выполнен',cause);}
  const map=output[detSession.outputNames[0]],mapHeight=map.dims[2],mapWidth=map.dims[3],kx=image.width/mapWidth,ky=image.height/mapHeight;
  return regions(map.data,mapWidth,mapHeight,detConfig.thresh??.3)
   .filter(box=>box.score>=(detConfig.boxThresh??.6)&&box.x1-box.x0>=3&&box.y1-box.y0>=3)
   .map(box=>{
    // The model marks the shrunken core of a line; it is grown back by the
    // rule PaddleOCR uses (area × ratio / perimeter).
    const w=box.x1-box.x0,h=box.y1-box.y0,grow=w*h*(detConfig.unclipRatio??1.5)/(2*(w+h));
    return {x0:Math.max(0,Math.floor((box.x0-grow)*kx)),y0:Math.max(0,Math.floor((box.y0-grow)*ky)),x1:Math.min(image.width,Math.ceil((box.x1+grow)*kx)),y1:Math.min(image.height,Math.ceil((box.y1+grow)*ky)),score:box.score};
   })
   .filter(box=>box.x1-box.x0>=4&&box.y1-box.y0>=4);
 }
 const detectLines=async(image,options)=>extendLines(image,await detect(image,options));

 // Reads line images (a box and the turn that makes it upright), a few at a
 // time. Returns for each the characters with their probability and their
 // place along the line (0…1).
 // A job may bring an image of its own (a line cut out beforehand).
 async function read(image,jobs,{batch=8,allow='',isCancelled=()=>false,progress=()=>{}}={}){
  const height=48,results=new Array(jobs.length),of=job=>job.image||image;
  // With a list of allowed characters the model chooses among them and the blank only.
  const allowed=allow?[0,...[...new Set(allow)].map(char=>alphabet.indexOf(char)).filter(index=>index>0)]:null;
  // Wide gaps of a justified line are closed up before it is read (see lineLayout).
  const order=jobs.map((job,index)=>{const size=uprightSize(job.box,job.rotation),layout=lineLayout(of(job),job.box,job.rotation);return {index,layout,width:Math.max(16,Math.min(3200,Math.round(layout.length*height/size.height*(job.stretch||1))))};}).sort((a,b)=>a.width-b.width);
  for(let start=0;start<order.length;start+=batch){
   if(isCancelled())throw cancelled('recognize');
   const group=order.slice(start,start+batch),rowWidth=Math.ceil(Math.max(...group.map(item=>item.width))/8)*8,plane=height*rowWidth,input=new Float32Array(group.length*3*plane);
   group.forEach((item,i)=>lineTensor(of(jobs[item.index]),jobs[item.index].box,jobs[item.index].rotation,height,item.width,input,i*3*plane,rowWidth,across=>item.layout.columnAt(across/item.width*item.layout.length)));
   let output;
   try{output=await recSession.run({[recSession.inputNames[0]]:new ort.Tensor('float32',input,[group.length,3,height,rowWidth])});}
   catch(cause){throw failure('recognize','Чтение строк не выполнено',cause);}
   const logits=output[recSession.outputNames[0]],steps=logits.dims[1],classes=logits.dims[2],stride=rowWidth/steps;
   group.forEach((item,i)=>{
    const characters=[];let previous=0;
    for(let t=0;t<steps;t++){
     const base=(i*steps+t)*classes;let best=0,value=logits.data[base];
     if(allowed){for(const c of allowed)if(logits.data[base+c]>value){value=logits.data[base+c];best=c;}}
     else for(let c=1;c<classes;c++)if(logits.data[base+c]>value){value=logits.data[base+c];best=c;}
     // Steps over the padding to the right of a shorter line are not its text.
     if(best&&best!==previous&&t*stride<item.width)characters.push({char:alphabet[best]??'',probability:value,at:Math.min(1,item.layout.columnAt(Math.min(1,(t+.5)*stride/item.width)*item.layout.length)/item.layout.width)});
     previous=best;
    }
    results[item.index]=characters;
   });
   progress(Math.min(order.length,start+batch),order.length);
  }
  return results;
 }

 const sureness=characters=>{const inked=characters.filter(item=>item.char.trim());return inked.length?inked.reduce((sum,item)=>sum+item.probability,0)/inked.length:0;};
 // The recogniser emits at most one character per 8 pixels of a line 48
 // pixels high and was trained on type of ordinary width — about three such
 // steps to a letter. Narrow type packs letters tighter than that and they
 // get dropped. Such a line is read again widened to the ordinary density:
 // the same pixels, no new detail.
 const widening=(image,box,rotation,characters)=>{
  const size=uprightSize(box,rotation),steps=lineLayout(image,box,rotation).length*48/size.height/8,inked=characters.filter(item=>item.char.trim()).length,density=inked/Math.max(1,steps);
  return inked>=4&&density>.45?Math.min(2.5,density/.33):0;
 };
 // A read line as words and characters with their places. A character stands
 // where the model emitted it; its box runs half-way towards its neighbours
 // along the line and over the whole height of the line.
 function lineOf(box,reading,extra={}){
  const characters=reading.characters,text=characters.map(item=>item.char).join('').replace(/\s+/g,' ').trim(),turn=reading.rotation,along=turn%180?box.y1-box.y0:box.x1-box.x0;
  const place=(a,b)=>turn===90?{x0:box.x0,y0:box.y1-b,x1:box.x1,y1:box.y1-a}:turn===270?{x0:box.x0,y0:box.y0+a,x1:box.x1,y1:box.y0+b}:turn===180?{x0:box.x1-b,y0:box.y0,x1:box.x1-a,y1:box.y1}:{x0:box.x0+a,y0:box.y0,x1:box.x0+b,y1:box.y1};
  const typical=characters.length>1?(characters.at(-1).at-characters[0].at)/(characters.length-1):.5;
  const edges=characters.map((item,i)=>({from:Math.max(0,i?(characters[i-1].at+item.at)/2:item.at-typical/2),to:Math.min(1,i<characters.length-1?(item.at+characters[i+1].at)/2:item.at+typical/2)}));
  const words=[];let current=null;
  characters.forEach((item,i)=>{
   if(!item.char.trim()){current=null;return;}
   if(!current){current={text:'',from:edges[i].from,to:edges[i].to,symbols:[]};words.push(current);}
   current.text+=item.char;current.to=edges[i].to;current.symbols.push({text:item.char,confidence:item.probability*100,box:place(edges[i].from*along,edges[i].to*along)});
  });
  return {text,confidence:reading.score*100,rotation:turn,box:{x0:box.x0,y0:box.y0,x1:box.x1,y1:box.y1},widened:reading.stretched||1,...extra,
   words:words.map(word=>({text:word.text,confidence:word.symbols.reduce((sum,symbol)=>sum+symbol.confidence,0)/word.symbols.length,box:place(word.from*along,word.to*along),symbols:word.symbols}))};
 }

 // image: {data: RGBA bytes, width, height}. Returns the lines read, each with
 // its words, in the pixels of that image.
 //   upright  only print that reads left to right is looked for and each line
 //            is read once — for a sheet already turned the way it reads
 //   allow    the only characters the reading may contain ("0123456789.,")
 async function recognize(image,{scale=1,maxSide=4000,minConfidence=.5,sideways=true,upright:uprightOnly=false,allow='',isCancelled=()=>false,progress=()=>{}}={}){
  if(!image?.data||!(image.width>0)||!(image.height>0)||image.data.length<image.width*image.height*4)throw new OcrError('BAD_INPUT','Изображение для распознавания пустое или повреждено.',{stage:'input'});
  const timings={};let started=performance.now();
  progress({stage:'detect',done:0,total:sideways&&!uprightOnly?2:1});
  // (Lines are not extended to a lone letter beside them in the upright-only
  // mode: its caller reads every line again by itself, cut out by its ink,
  // and a sign standing beside a line must not be drawn into it.)
  const upright=await (uprightOnly?detect:detectLines)(image,{scale,maxSide});
  if(isCancelled())throw cancelled('detect');
  // The detector is trained on print that runs left to right: a long line
  // running up the sheet comes back in pieces. So the sheet is searched a
  // second time lying on its side, and lines along the sheet's height are
  // taken from that search alone.
  const tall=box=>box.y1-box.y0>(box.x1-box.x0)*1.5,wide=box=>box.x1-box.x0>(box.y1-box.y0)*1.5;
  let boxes=uprightOnly?upright.filter(box=>!tall(box)):upright;
  if(sideways&&!uprightOnly){
   progress({stage:'detect',done:1,total:2});
   const turned=await detectLines(quarterTurn(image),{scale,maxSide});
   if(isCancelled())throw cancelled('detect');
   boxes=[...upright.filter(box=>!tall(box)),...turned.filter(wide).map(box=>({x0:box.y0,y0:image.height-box.x1,x1:box.y1,y1:image.height-box.x0,score:box.score,turned:true}))];
  }
  timings.detectMs=performance.now()-started;started=performance.now();
  // The detector does not say which way a line reads. Each box is first read
  // the likelier way (a line along the sheet's height from bottom to top);
  // the other ways are tried where that reading is unsure, and all four for
  // a near-square box. The reading the model is surest of is kept.
  const first=boxes.map(box=>({box,rotation:box.turned||tall(box)?90:0}));
  let jobCount=first.length,doneBefore=0;
  const round=async jobs=>{const out=await read(image,jobs,{allow,isCancelled,progress:done=>progress({stage:'recognize',done:doneBefore+done,total:jobCount})});doneBefore+=jobs.length;return out;};
  const best=(await round(first)).map((characters,index)=>({rotation:first[index].rotation,characters,score:sureness(characters)}));
  const others=[];
  boxes.forEach((box,index)=>{
   const turns=box.turned||tall(box)?[270]:wide(box)?[180]:[90,270,180];
   if(!uprightOnly&&(best[index].score<.9||turns.length>1))for(const rotation of turns)others.push({index,box,rotation});
  });
  jobCount+=others.length;
  (await round(others)).forEach((characters,j)=>{const score=sureness(characters),at=others[j].index;if(score>best[at].score)best[at]={rotation:others[j].rotation,characters,score};});
  const narrow=[];
  boxes.forEach((box,index)=>{const stretch=widening(image,box,best[index].rotation,best[index].characters);if(stretch)narrow.push({index,box,rotation:best[index].rotation,stretch});});
  jobCount+=narrow.length;
  (await round(narrow)).forEach((characters,j)=>{const score=sureness(characters),at=narrow[j].index;if(score>=best[at].score-.1)best[at]={rotation:narrow[j].rotation,characters,score,stretched:narrow[j].stretch};});
  timings.recognizeMs=performance.now()-started;
  const lines=boxes.map((box,index)=>lineOf(box,best[index],{detection:box.score})).filter(line=>line.text&&line.confidence>=minConfidence*100);
  // A near-square box of the upright search may be a piece of a line that
  // the sideways search read whole: of two readings of one place in
  // different directions the surer one stays.
  const shared=(a,b)=>Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0)),area=box=>(box.x1-box.x0)*(box.y1-box.y0);
  const kept=lines.filter(line=>!lines.some(other=>other!==line&&other.rotation%180!==line.rotation%180&&shared(line.box,other.box)>Math.min(area(line.box),area(other.box))*.5&&(other.confidence>line.confidence||other.confidence===line.confidence&&area(other.box)>area(line.box))));
  return {lines:kept,timings,image:{width:image.width,height:image.height}};
 }

 // Images that each hold one upright line (cut out by whoever calls): no
 // search for lines, only reading. Returns one line per image, in its pixels.
 async function readLines(images,{allow='',isCancelled=()=>false,progress=()=>{}}={}){
  const started=performance.now();
  for(const image of images)if(!image?.data||!(image.width>0)||!(image.height>0)||image.data.length<image.width*image.height*4)throw new OcrError('BAD_INPUT','Изображение строки пустое или повреждено.',{stage:'input'});
  const jobs=images.map(image=>({image,box:{x0:0,y0:0,x1:image.width,y1:image.height},rotation:0}));
  const best=(await read(null,jobs,{allow,isCancelled,progress:done=>progress({stage:'recognize',done,total:jobs.length})})).map(characters=>({rotation:0,characters,score:sureness(characters)}));
  const narrow=[];
  jobs.forEach((job,index)=>{const stretch=widening(job.image,job.box,0,best[index].characters);if(stretch)narrow.push({...job,index,stretch});});
  (await read(null,narrow,{allow,isCancelled})).forEach((characters,j)=>{const score=sureness(characters),at=narrow[j].index;if(score>=best[at].score-.1)best[at]={rotation:0,characters,score,stretched:narrow[j].stretch};});
  return {lines:jobs.map((job,index)=>lineOf(job.box,best[index])),timings:{recognizeMs:performance.now()-started}};
 }

 return {recognize,readLines,models:{det:detConfig.name,rec:recConfig.name},runtime:'onnxruntime-node',release:async()=>{await detSession.release?.();await recSession.release?.();}};
}
