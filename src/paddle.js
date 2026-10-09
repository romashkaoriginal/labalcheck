import {mapBox} from './automatic.js';
import {pageReadingBox} from './phrase.js';

// Convert independent line detections into the same page-coordinate evidence
// used by Tesseract. The OCR model is never supplied with expected copy.
export function paddleWords(result,region,sourceWidth,sourceHeight,rotation=0,pass='paddle'){
 const image=result?.image;
 if(!image?.width||!image?.height||!Number.isFinite(sourceWidth)||!Number.isFinite(sourceHeight))return [];
 return (result.items||[]).flatMap((item,index)=>{
  if(!item.text?.trim()||!Array.isArray(item.poly)||item.poly.length<4)return [];
  const xs=item.poly.map(point=>point[0]),ys=item.poly.map(point=>point[1]);
  const bounds={x0:Math.max(0,Math.min(...xs)),y0:Math.max(0,Math.min(...ys)),x1:Math.min(image.width,Math.max(...xs)),y1:Math.min(image.height,Math.max(...ys))};
  if(bounds.x1<=bounds.x0||bounds.y1<=bounds.y0)return [];
  const box=mapBox(bounds,region,sourceWidth,sourceHeight,rotation);
  return [{text:item.text.trim(),confidence:Math.max(0,Math.min(100,(item.score??0)*100)),box,rotation,pass,
   readingBox:{x:bounds.x0,y:bounds.y0,w:bounds.x1-bounds.x0,h:bounds.y1-bounds.y0},
   line:String(index),pageAspect:sourceWidth*region.h/(sourceHeight*region.w),glyphs:[],ocrEngine:'paddle'}];
 });
}

// Places for single-line images on plain sheets: one line under another with
// wide leading, each scaled to one letter height. Justified lines have gaps a
// detector takes for the end of the line, and a lone letter after such a gap
// is then never read; blank columns beyond an ordinary word space are
// therefore left out of the sheet. No ink is moved or changed: `pieces` tells
// which columns of the line image stand where. `lines`: {image:{data,width,
// height},region,rotation,id,cut}. Returns sheets {width,height,slots}.
export function lineSheets(lines,{height=48,gap=30,margin=24,maxWidth=2400,maxHeight=1900}={}){
 const sheets=[];let sheet=null;
 for(const line of lines){
  const image=line.image;if(!image?.width||!image?.height)continue;
  const inked=new Uint8Array(image.width);for(let y=0,p=0;y<image.height;y++)for(let x=0;x<image.width;x++,p+=4)if(image.data[p]<160)inked[x]=1;
  const space=Math.max(4,Math.round(image.height*.45)),pieces=[];let from=0,at=0,blank=0;
  for(let x=0;x<=image.width;x++){
   if(x<image.width&&!inked[x]){blank++;continue;}
   // A blank run longer than a word space keeps a word space of its width.
   if(blank>space){const end=x-blank+space;pieces.push({from,to:end,at});at+=end-from;from=x;}
   blank=0;
  }
  if(from<image.width)pieces.push({from,to:image.width,at});
  const length=pieces.length?pieces.at(-1).at+pieces.at(-1).to-pieces.at(-1).from:image.width;
  const scale=Math.min(height/image.height,(maxWidth-margin*2)/length),w=Math.max(1,Math.round(length*scale)),h=Math.max(1,Math.round(image.height*scale));
  if(!sheet||sheet.height+h+gap>maxHeight){sheet={width:margin*2,height:gap,slots:[]};sheets.push(sheet);}
  sheet.slots.push({line,x:margin,y:sheet.height,w,h,scale,pieces});sheet.height+=h+gap;sheet.width=Math.max(sheet.width,w+margin*2);
 }
 return sheets;
}
// Detections on such a sheet returned to the page: each belongs to the line
// in whose slot its centre lies.
export function sheetWords(result,sheet,aspect=1){
 const scaleX=(result?.image?.width||sheet.width)/sheet.width,scaleY=(result?.image?.height||sheet.height)/sheet.height;
 return (result?.items||[]).flatMap(item=>{
  if(!item.text?.trim()||!Array.isArray(item.poly)||item.poly.length<4)return [];
  const xs=item.poly.map(point=>point[0]/scaleX),ys=item.poly.map(point=>point[1]/scaleY),cy=(Math.min(...ys)+Math.max(...ys))/2;
  const slot=sheet.slots.find(entry=>cy>=entry.y-4&&cy<entry.y+entry.h+4);if(!slot)return [];
  const {line}=slot,image=line.image,rotation=line.rotation||0;
  // Sheet column → column of the line image, across the columns left out.
  const column=x=>{const at=(x-slot.x)/slot.scale,piece=[...slot.pieces].reverse().find(entry=>entry.at<=at)||slot.pieces[0];return Math.max(0,Math.min(image.width,Math.min(piece.to,piece.from+at-piece.at)));};
  const x0=column(Math.min(...xs)),x1=column(Math.max(...xs));if(x1<=x0)return [];
  // The whole height of the line image: the detector's own box height says nothing about the letters.
  const box=mapBox({x0,y0:0,x1,y1:image.height},line.region,rotation%180?image.height:image.width,rotation%180?image.width:image.height,rotation);
  // A word at an edge where the line was cut off is not a whole word.
  const edge=image.height*.8,partial=line.cut?.left&&x0<edge||line.cut?.right&&x1>image.width-edge;
  return [{text:item.text.trim(),confidence:Math.max(0,Math.min(partial?50:100,(item.score??0)*100)),box,rotation,pass:`paddle-line:${rotation}`,line:String(line.id),readingBox:pageReadingBox(box,rotation,aspect),glyphs:[],ocrEngine:'paddle'}];
 });
}
