// Stands where `src/secondary-ocr.js` stands in the web version: the second,
// independent reading. Which engine gives it is chosen in the address:
//   ?second=web        the web version's own PaddleOCR in WASM (as on the site)
//   ?second=local      the local OCR process
//   ?second=tesseract  Tesseract.js — the second opinion when the local
//                      engine is the first reader (?primary=local)
//   ?second=none       no second reading
// The two functions and the shape of their words are those of the original.
import {createWorker} from 'tesseract.js';
import * as web from '../../../src/secondary-ocr.js';
import {mapBox,wordsFromOcr} from '../../../src/automatic.js';
import {pageReadingBox} from '../../../src/phrase.js';
import {readingOrder,onTesseractScale} from '../../shared/ocr-result.mjs';

const settings=new URLSearchParams(location.search),desktop=window.parent?.desktop;
const second=['local','tesseract','none'].includes(settings.get('second'))&&(desktop||settings.get('second')!=='local')?settings.get('second'):'web';

const pixelsOf=canvas=>{const image=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height);return {data:image.data,width:image.width,height:image.height};};
const canvasOf=image=>{const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').putImageData(new ImageData(image.data,image.width,image.height),0,0);return canvas;};
// A word at an edge where the line was cut off is not a whole word (as in src/paddle.js).
const cutOff=(line,x0,x1)=>{const edge=line.image.height*.8;return line.cut?.left&&x0<edge||line.cut?.right&&x1>line.image.width-edge;};

// ── The local OCR process ───────────────────────────────────────────────────
async function localLabel(canvas,region){
 const image=pixelsOf(canvas),long=Math.max(image.width,image.height),aspect=image.width*region.h/(image.height*region.w),words=[];
 // The region twice, at the two sizes the detector reads small and large print at; every direction of print in each.
 for(const target of [1000,2000]){
  const reply=await desktop.recognize({id:crypto.randomUUID(),image,options:{scale:Math.min(1,target/long)}});
  for(const line of readingOrder(reply.result.lines))for(const word of line.words){
   const box={x:region.x+word.box.x0/image.width*region.w,y:region.y+word.box.y0/image.height*region.h,w:(word.box.x1-word.box.x0)/image.width*region.w,h:(word.box.y1-word.box.y0)/image.height*region.h};
   words.push({text:word.text,confidence:onTesseractScale(word.confidence),box,rotation:line.rotation,pass:`local-${target}:${line.rotation}`,line:`local-${target}-${line.row}`,readingBox:pageReadingBox(box,line.rotation,aspect),pageAspect:aspect,glyphs:[],ocrEngine:'paddle'});
  }
 }
 return words;
}
async function localLines(lines,aspect){
 const words=[];
 // A few dozen lines at a time: each is copied on its way to the OCR process.
 for(let start=0;start<lines.length;start+=40){
  const part=lines.slice(start,start+40),reply=await desktop.lines({id:crypto.randomUUID(),images:part.map(line=>({data:line.image.data,width:line.image.width,height:line.image.height}))});
  reply.result.lines.forEach((read,i)=>{
   const line=part[i],image=line.image,rotation=line.rotation||0;
   for(const word of read.words){
    // The whole height of the line image: the place of a word along the line is what matters.
    const box=mapBox({x0:word.box.x0,y0:0,x1:word.box.x1,y1:image.height},line.region,rotation%180?image.height:image.width,rotation%180?image.width:image.height,rotation);
    words.push({text:word.text,confidence:Math.min(cutOff(line,word.box.x0,word.box.x1)?50:100,onTesseractScale(word.confidence)),box,rotation,pass:`paddle-line:${rotation}`,line:String(line.id),readingBox:pageReadingBox(box,rotation,aspect),glyphs:[],ocrEngine:'paddle'});
   }
  });
 }
 return words;
}

// ── Tesseract.js as the second reader ───────────────────────────────────────
let tesseract=null;
const tesseractWorker=()=>tesseract??=createWorker('rus',1,{workerPath:new URL('./vendor/worker.min.js',location.href).href,corePath:new URL('./vendor/core/',location.href).href,langPath:new URL('./assets/lang/',location.href).href}).catch(error=>{tesseract=null;throw error;});
const turned=(canvas,rotation)=>{
 if(!rotation)return canvas;
 const output=document.createElement('canvas');output.width=rotation%180?canvas.height:canvas.width;output.height=rotation%180?canvas.width:canvas.height;
 const context=output.getContext('2d');context.translate(output.width/2,output.height/2);context.rotate(rotation*Math.PI/180);context.drawImage(canvas,-canvas.width/2,-canvas.height/2);return output;
};
// Tesseract reads the narrow type of labels better widened by half — the web
// version always hands it pictures widened so (`stretch` in src/app.js); the
// boxes are brought back to the picture as it was.
const widen=1.5;
async function widened(worker,canvas){
 const wide=document.createElement('canvas');wide.width=Math.round(canvas.width*widen);wide.height=canvas.height;
 const context=wide.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,wide.width,wide.height);context.drawImage(canvas,0,0,wide.width,wide.height);
 const {data}=await worker.recognize(wide,{},{text:true,blocks:true});
 for(const block of data.blocks||[])for(const paragraph of block.paragraphs||[])for(const line of paragraph.lines||[])for(const word of line.words||[])for(const box of [word.bbox,...(word.symbols||[]).map(symbol=>symbol.bbox)]){box.x0/=widen;box.x1/=widen;}
 return data;
}
async function tesseractLabel(canvas,region,rotations){
 const worker=await tesseractWorker(),words=[];
 await worker.setParameters({tessedit_pageseg_mode:'3',preserve_interword_spaces:'1'});
 for(const rotation of [...new Set(rotations)]){
  const data=await widened(worker,turned(canvas,rotation));
  for(const word of wordsFromOcr(data,region,canvas.width,canvas.height,rotation,null,`second:${rotation}`))words.push({...word,glyphs:[],ocrEngine:'tesseract'});
 }
 return words;
}
async function tesseractLines(lines,aspect){
 const worker=await tesseractWorker(),words=[];
 await worker.setParameters({tessedit_pageseg_mode:'7',preserve_interword_spaces:'1'});
 for(const line of lines){
  const image=line.image,rotation=line.rotation||0,data=await widened(worker,canvasOf(image));
  for(const word of wordsFromOcr(data,line.region,rotation%180?image.height:image.width,rotation%180?image.width:image.height,rotation,null,`second-line:${rotation}`)){
   if(cutOff(line,word.readingBox.x,word.readingBox.x+word.readingBox.w))word.confidence=Math.min(50,word.confidence);
   words.push({...word,line:String(line.id),readingBox:pageReadingBox(word.box,rotation,aspect),glyphs:[],ocrEngine:'tesseract'});
  }
 }
 // The worker is ended so that its memory does not stay with the page.
 await worker.terminate();tesseract=null;
 return words;
}

export async function readWithSecondaryOcr(canvas,region,rotations=[0]){
 return second==='local'?localLabel(canvas,region):second==='tesseract'?tesseractLabel(canvas,region,rotations):second==='none'?[]:web.readWithSecondaryOcr(canvas,region,rotations);
}
export async function readLinesWithSecondaryOcr(lines,aspect=1){
 if(!lines.length)return [];
 return second==='local'?localLines(lines,aspect):second==='tesseract'?tesseractLines(lines,aspect):second==='none'?[]:web.readLinesWithSecondaryOcr(lines,aspect);
}
