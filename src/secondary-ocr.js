import {PaddleOCR} from '@paddleocr/paddleocr-js';
import {paddleWords,lineSheets,sheetWords} from './paddle.js';

let instancePromise;

function instance(){
 if(!instancePromise){
  instancePromise=PaddleOCR.create({
   textDetectionModelName:'PP-OCRv5_mobile_det',
   textDetectionModelAsset:{url:new URL('./assets/models/PP-OCRv5_mobile_det_onnx_infer.tar',location.href).href},
   textRecognitionModelName:'cyrillic_PP-OCRv5_mobile_rec',
   textRecognitionModelAsset:{url:new URL('./assets/models/cyrillic_PP-OCRv5_mobile_rec_onnx_infer.tar',location.href).href},
   ortOptions:{backend:'wasm',wasmPaths:new URL('./vendor/ort/',location.href).href,numThreads:1,simd:true},
  }).catch(error=>{instancePromise=null;throw error;});
 }
 return instancePromise;
}

function rotated(canvas,rotation){
 if(!rotation)return canvas;
 const output=document.createElement('canvas');
 output.width=rotation%180?canvas.height:canvas.width;
 output.height=rotation%180?canvas.width:canvas.height;
 const ctx=output.getContext('2d');
 ctx.translate(output.width/2,output.height/2);
 ctx.rotate(rotation*Math.PI/180);
 ctx.drawImage(canvas,-canvas.width/2,-canvas.height/2);
 return output;
}

export async function readWithSecondaryOcr(canvas,region,rotations=[0]){
 const ocr=await instance(),words=[];
 // Large production sheets can exhaust the browser WASM decoder. Scale the
 // selected print contour, not the whole technical sheet, before detection.
 const scale=Math.min(1,1800/Math.max(canvas.width,canvas.height));
 let source=canvas;
 if(scale<1){source=document.createElement('canvas');source.width=Math.max(1,Math.round(canvas.width*scale));source.height=Math.max(1,Math.round(canvas.height*scale));source.getContext('2d').drawImage(canvas,0,0,source.width,source.height);}
 for(const rotation of [...new Set(rotations)]){
  const [result]=await ocr.predict(rotated(source,rotation),{textDetLimitSideLen:1800});
  words.push(...paddleWords(result,region,source.width,source.height,rotation,`paddle:${rotation}`));
 }
 return words;
}

// Lines that were cut out one by one, each with only its own ink, are read
// by the second engine too. They are set on plain sheets with wide leading:
// detection then meets no tight leading and no neighbouring inscriptions, and
// every reading still comes from the pixels of one line alone.
export async function readLinesWithSecondaryOcr(lines,aspect=1){
 if(!lines.length)return [];
 const ocr=await instance(),words=[];
 for(const sheet of lineSheets(lines)){
  const canvas=document.createElement('canvas');canvas.width=sheet.width;canvas.height=sheet.height;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingQuality='high';
  for(const slot of sheet.slots){
   const image=slot.line.image,source=document.createElement('canvas');source.width=image.width;source.height=image.height;
   source.getContext('2d').putImageData(new ImageData(image.data,image.width,image.height),0,0);
   for(const piece of slot.pieces)ctx.drawImage(source,piece.from,0,piece.to-piece.from,image.height,slot.x+piece.at*slot.scale,slot.y,(piece.to-piece.from)*slot.scale,slot.h);
  }
  const [result]=await ocr.predict(canvas,{textDetLimitSideLen:Math.max(canvas.width,canvas.height)});
  words.push(...sheetWords(result,sheet,aspect));
 }
 return words;
}
