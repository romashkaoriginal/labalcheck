// The OCR process of the desktop app: an Electron utility process that holds
// the models and reads pixels sent to it. It opens no user files and no
// network connections; the only files it reads are the models.
//
// In:   {type:'recognize', id, image:{data,width,height}, models:{det,rec}, options:{scale,upright,allow}}
//       {type:'lines', id, images:[{data,width,height}], models, options:{allow}}   lines cut out beforehand
//       {type:'cancel', id}
// Out:  {type:'progress', id, stage, done, total}
//       {type:'result', id, result:{lines,timings,image}, engine:{det,rec,runtime}, loadMs}
//       {type:'error', id, error:{code,message,stage,retryable}}
import path from 'node:path';
import {createEngine,OcrError} from './engine.mjs';

const modelsDir=process.env.LABEL_CHECK_MODELS||path.resolve(import.meta.dirname,'../../models');
const engines=new Map(),cancelled=new Set(),port=process.parentPort;
const send=message=>port.postMessage(message);

async function engineFor({det,rec}={}){
 const key=`${det||''}|${rec||''}`;
 // One pair of models stays loaded; another pair replaces it.
 if(!engines.has(key)){for(const [other,engine] of engines){engines.delete(other);(await engine).release().catch(()=>{});}engines.set(key,createEngine({modelsDir,det,rec,threads:Number(process.env.LABEL_CHECK_THREADS||0)}));}
 try{return await engines.get(key);}catch(error){engines.delete(key);throw error;}
}
const pixels=image=>({data:new Uint8ClampedArray(image.data.buffer??image.data,image.data.byteOffset||0,image.width*image.height*4),width:image.width,height:image.height});

// Jobs are done one after another, in the order they came: the models use every core already.
let queue=Promise.resolve();
port.on('message',({data:message})=>{
 if(message?.type==='cancel'){cancelled.add(message.id);return;}
 if(message?.type!=='recognize'&&message?.type!=='lines')return;
 queue=queue.then(async()=>{
  const {id}=message;
  try{
   if(cancelled.has(id))throw new OcrError('CANCELLED','Обработка отменена.',{stage:'queue'});
   const started=performance.now(),engine=await engineFor(message.models),loadMs=performance.now()-started;
   const options={...message.options,isCancelled:()=>cancelled.has(id),progress:state=>send({type:'progress',id,...state})};
   const result=message.type==='lines'?await engine.readLines(message.images.map(pixels),options):await engine.recognize(pixels(message.image),options);
   send({type:'result',id,result,engine:{...engine.models,runtime:engine.runtime},loadMs});
  }catch(error){
   const known=error instanceof OcrError?error:new OcrError('INTERNAL',error?.message||String(error),{stage:'unknown'});
   send({type:'error',id,error:known.toJSON()});
  }finally{cancelled.delete(id);}
 });
});
send({type:'ready'});
