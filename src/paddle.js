import {mapBox} from './automatic.js';

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
