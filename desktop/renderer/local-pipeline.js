// The experimental method: the sheet is read by the local OCR process, and
// what it read is judged by the SAME functions the web version uses
// (detectFrames, declaredLabelSize, matchRequirements, assess …). Nothing here
// decides whether a section matches; this file only gets pixels to the OCR
// process and words back into the shape the comparison takes.
//
// Not done by this method (the web version does them): reading each line cut
// out by its own ink, re-reading the places of missing words, size callouts of
// the technical sheet, letter heights. A section's size is therefore never
// measured here — only its text is compared.
import * as pdfjs from 'pdfjs-dist';
import {detectFrames,refineFrame,detectArtworkRegion,matchRequirements,assess} from '../../src/automatic.js';
import {variantText} from '../../src/engine.js';
import {scanEan13} from '../../src/barcode.js';
import {imageDensity,resolveScale,declaredLabelSize} from '../../src/scale.js';
import {SCHEMA,wordsFromEngine,toAppWords} from '../shared/ocr-result.mjs';

pdfjs.GlobalWorkerOptions.workerSrc=new URL('../web/vendor/pdf.worker.min.mjs',location.href).href;
const cmaps=new URL('../web/vendor/cmaps/',location.href).href;

const canvasOf=(width,height)=>{const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width));canvas.height=Math.max(1,Math.round(height));return canvas;};
const pixelsOf=(canvas,x=0,y=0,width=canvas.width,height=canvas.height)=>canvas.getContext('2d',{willReadFrequently:true}).getImageData(x,y,width,height);
function reduced(source,limit){
 const factor=Math.min(1,limit/Math.max(source.width,source.height)),canvas=canvasOf(source.width*factor,source.height*factor),context=canvas.getContext('2d',{willReadFrequently:true});
 context.imageSmoothingQuality='high';context.drawImage(source,0,0,canvas.width,canvas.height);return canvas;
}

// A PDF page that is one picture has no outlines to draw again: its real
// resolution is that of the picture. (The same test as pdfPicture in src/app.js.)
async function pagePicture(page){
 const list=await page.getOperatorList(),OPS=pdfjs.OPS,painted=new Set([OPS.fill,OPS.eoFill,OPS.stroke,OPS.fillStroke,OPS.eoFillStroke,OPS.closeStroke,OPS.closeFillStroke,OPS.closeEOFillStroke,OPS.showText,OPS.showSpacedText,OPS.nextLineShowText,OPS.nextLineSetSpacingShowText,OPS.shadingFill]),stack=[],pictures=[];
 let matrix=[1,0,0,1,0,0],drawn=0;
 list.fnArray.forEach((fn,i)=>{
  const args=list.argsArray[i];
  if(fn===OPS.save)stack.push(matrix);else if(fn===OPS.restore)matrix=stack.pop()||matrix;else if(fn===OPS.transform)matrix=pdfjs.Util.transform(matrix,args);
  else if(fn===OPS.paintImageXObject||fn===OPS.paintInlineImageXObject){const width=args[1]??args[0]?.width,height=args[2]??args[0]?.height,w=Math.hypot(matrix[0],matrix[1]),h=Math.hypot(matrix[2],matrix[3]);if(width&&height&&w&&h)pictures.push({dpi:Math.min(width/w,height/h)*72,area:w*h});}
  else if(painted.has(fn))drawn++;
 });
 const view=page.getViewport({scale:1}),largest=pictures.sort((a,b)=>b.area-a.area)[0];
 return !drawn&&largest&&largest.area>=view.width*view.height*.8?{dpi:largest.dpi}:null;
}

// The artwork as pixels that really exist in the file. A picture, and a PDF
// that only wraps a picture, are taken at their own resolution and never
// enlarged; a PDF drawn with outlines can be drawn again finer (`detail`),
// which does add detail.
export async function openArtwork(file){
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(/\.pdf$/i.test(file.name)){
  const pdf=await pdfjs.getDocument({data:bytes.slice(),cMapUrl:cmaps,cMapPacked:true}).promise,page=await pdf.getPage(1),natural=page.getViewport({scale:1}),picture=await pagePicture(page);
  const dpi=Math.min(picture?picture.dpi:300,8000/Math.max(natural.width,natural.height)*72),viewport=page.getViewport({scale:dpi/72}),canvas=canvasOf(Math.ceil(viewport.width),Math.ceil(viewport.height));
  await page.render({canvasContext:canvas.getContext('2d',{willReadFrequently:true}),viewport,background:'#fff'}).promise;
  const detail=picture?null:async(region,wanted)=>{
   const fine=page.getViewport({scale:wanted/72}),crop=canvasOf(fine.width*region.w,fine.height*region.h);
   await page.render({canvasContext:crop.getContext('2d',{willReadFrequently:true}),viewport:fine,background:'#fff',transform:[1,0,0,1,-fine.width*region.x,-fine.height*region.y]}).promise;
   return {canvas:crop,zoom:wanted/dpi};
  };
  return {kind:picture?'raster-pdf':'vector-pdf',name:file.name,canvas,dpi,picture,density:null,pageMm:{width:natural.width*25.4/72,height:natural.height*25.4/72},page,pages:pdf.numPages,detail};
 }
 if(!/^image\/(png|jpeg|webp)$/.test(file.type)&&!/\.(png|jpe?g|webp)$/i.test(file.name))throw Object.assign(new Error('Поддерживаются PDF, PNG, JPEG и WebP.'),{code:'UNSUPPORTED_FILE'});
 const bitmap=await createImageBitmap(file),canvas=canvasOf(bitmap.width,bitmap.height);canvas.getContext('2d',{willReadFrequently:true}).drawImage(bitmap,0,0);bitmap.close?.();
 return {kind:'image',name:file.name,canvas,dpi:null,picture:null,density:imageDensity(bytes),pageMm:null,page:null,pages:1,detail:null};
}

// The detector looks at a region twice, at two sizes: small print is found
// when the region is about 2000 pixels long, large print when it is about
// 1000. Each size is a reading of its own; the comparison joins readings only
// where they stand on the same place of the sheet.
const detectorScales=image=>{const long=Math.max(image.width,image.height);return long>2400?[1]:[...new Set([1000,2000].map(target=>Math.round(Math.max(.5,Math.min(3,target/long))*100)/100))];};

export async function runLocal({artwork,rules,volume,models,signal,onStage=()=>{}}){
 const started=performance.now(),timings={ocr:[]},page=artwork.canvas,size={width:page.width,height:page.height};
 let current=null,engine=null;
 const halt=()=>{if(signal?.aborted)throw Object.assign(new Error('Обработка отменена.'),{code:'CANCELLED'});};
 signal?.addEventListener('abort',()=>{if(current)window.desktop.cancel(current);});
 const read=async(image,scale,what,options={})=>{
  halt();current=crypto.randomUUID();onStage(what);
  try{
   const reply=await window.desktop.recognize({id:current,image:{data:image.data,width:image.width,height:image.height},models,options:{scale,...options}});
   engine=reply.engine;timings.ocr.push({what,scale,width:image.width,height:image.height,loadMs:Math.round(reply.loadMs),detectMs:Math.round(reply.result.timings.detectMs),recognizeMs:Math.round(reply.result.timings.recognizeMs),lines:reply.result.lines.length});
   return reply.result.lines;
  }finally{current=null;}
 };

 // Contours: exactly as the web version finds them.
 onStage('Ищем контуры этикетки');
 let mark=performance.now();
 const probePixels=pixelsOf(reduced(page,1200)),artworkRegion=detectArtworkRegion(probePixels),sheet=pixelsOf(reduced(page,3600));
 const frames=detectFrames(probePixels).map(frame=>refineFrame(sheet,frame));
 let hasContour=frames.length>0;
 timings.contourMs=Math.round(performance.now()-mark);

 // The order table names the label size: a witness for the contour and the scale.
 mark=performance.now();
 const overview=reduced(page,2000),overviewLines=(await read(pixelsOf(overview),1,'Читаем параметры заказа на листе',{upright:true})).map(line=>({text:line.text,box:{x:line.box.x0/overview.width,y:line.box.y0/overview.height,w:(line.box.x1-line.box.x0)/overview.width,h:(line.box.y1-line.box.y0)/overview.height}}));
 const declared=declaredLabelSize(overviewLines)||declaredLabelSize(overviewLines.map(line=>line.text).join(' '));
 timings.overviewMs=Math.round(performance.now()-mark);
 const scaleFor=frame=>resolveScale({density:artwork.density,contour:hasContour?{w:frame.w*size.width,h:frame.h*size.height}:null,declared});
 const fitsDeclared=frame=>{
  if(!declared)return false;if(!artwork.pageMm)return scaleFor(frame).level!=='none';
  const sides=[frame.w*artwork.pageMm.width,frame.h*artwork.pageMm.height],long=Math.max(...declared),short=Math.min(...declared);
  return Math.abs(Math.max(...sides)-long)<=long*.03&&Math.abs(Math.min(...sides)-short)<=short*.03;
 };
 let candidates=frames.length?frames:[artworkRegion];
 const fitting=frames.filter(fitsDeclared);if(fitting.length)candidates=fitting;

 let sourcePixelMm=null;
 const readRegion=async(region,what,pass)=>{
  const x=Math.round(region.x*size.width),y=Math.round(region.y*size.height),w=Math.max(1,Math.min(size.width-x,Math.round(region.w*size.width))),h=Math.max(1,Math.min(size.height-y,Math.round(region.h*size.height)));
  let image=null,zoom=1;
  // Outlines of a PDF are drawn again finer for reading; pixels of a picture are taken as they are.
  if(artwork.detail){const wanted=Math.min(600,6000/Math.max(w,h)*artwork.dpi);if(wanted>artwork.dpi*1.15){onStage('Перерисовываем этикетку из PDF крупнее');const fine=await artwork.detail(region,wanted);image=pixelsOf(fine.canvas);zoom=fine.zoom;}}
  image??=pixelsOf(page,x,y,w,h);
  if(artwork.pageMm)sourcePixelMm=artwork.pageMm.width/size.width/zoom;
  const words=[];
  for(const scale of detectorScales(image))words.push(...wordsFromEngine(await read(image,scale,`${what} (×${scale})`),{crop:{x,y},zoom,pass:`${pass}-x${scale}`}));
  return words;
 };
 const appWords=words=>toAppWords({page:size,words});
 mark=performance.now();
 let best=null;
 for(const [index,region] of candidates.entries()){
  const words=await readRegion(region,candidates.length>1?`Распознаём макет ${index+1} из ${candidates.length}`:'Распознаём этикетку',`local${index}`);
  const score=candidates.length>1?Object.values(matchRequirements(rules,appWords(words),volume,false,region,hasContour)).reduce((sum,match)=>sum+(match?.coverage||0),0):1;
  if(!best||score>best.score)best={region,words,score};
 }
 // No contour holds the text of the requirements: the whole artwork is read instead.
 if(hasContour&&candidates.length>1&&best.score===0){hasContour=false;best={region:artworkRegion,words:await readRegion(artworkRegion,'Ищем текст по всему макету','sheet'),score:0};}
 const {region,words}=best;
 timings.readMs=Math.round(performance.now()-mark);

 // The text layer of a PDF inside the region, as the web version adds it.
 if(artwork.page){
  const viewport=artwork.page.getViewport({scale:1}),content=await artwork.page.getTextContent();
  for(const item of content.items){
   if(!item.str?.trim())continue;
   const tx=pdfjs.Util.transform(viewport.transform,item.transform),font=Math.hypot(tx[2],tx[3]),angle=Math.atan2(tx[1],tx[0]),advance=item.width*viewport.scale;
   const corners=[[0,0],[advance,0],[0,-font],[advance,-font]].map(([cx,cy])=>({x:(tx[4]+cx*Math.cos(angle)-cy*Math.sin(angle))/viewport.width,y:(tx[5]+cx*Math.sin(angle)+cy*Math.cos(angle))/viewport.height}));
   const x=Math.min(...corners.map(point=>point.x)),y=Math.min(...corners.map(point=>point.y)),right=Math.max(...corners.map(point=>point.x)),bottom=Math.max(...corners.map(point=>point.y));
   if(x<region.x-.002||y<region.y-.002||right>region.x+region.w+.002||bottom>region.y+region.h+.002||right<=x||bottom<=y)continue;
   words.push({text:item.str,box:{x:x*size.width,y:y*size.height,w:(right-x)*size.width,h:(bottom-y)*size.height},rotation:0,confidence:100,source:'pdf-text',engine:'pdf',pass:'pdf',line:null});
  }
 }
 // The barcode is read from its bars, inside the label when its contour is known.
 const barcodeRule=rules.find(rule=>/штриховой код/i.test(rule.title)),barcodeRegion=hasContour?region:artworkRegion;
 if(barcodeRule){
  const x=Math.round(barcodeRegion.x*size.width),y=Math.round(barcodeRegion.y*size.height),w=Math.max(1,Math.min(size.width-x,Math.round(barcodeRegion.w*size.width))),h=Math.max(1,Math.min(size.height-y,Math.round(barcodeRegion.h*size.height)));
  const barcode=scanEan13(pixelsOf(page,x,y,w,h),variantText(barcodeRule,volume));
  if(barcode)words.push({text:barcode.text,box:{x:x+barcode.box.x*w,y:y+barcode.box.y*h,w:barcode.box.w*w,h:barcode.box.h*h},rotation:0,confidence:100,source:'barcode',engine:'barcode',pass:'barcode',line:null});
 }

 const physical=artwork.pageMm?{mmPerPixel:artwork.pageMm.width/size.width,level:'high',origin:'pdf-geometry'}:(found=>({mmPerPixel:found.mmPerPixel,level:found.level,origin:found.source}))(scaleFor(region));
 const result={schema:SCHEMA,method:'local-onnx',engine:{...engine,passes:[...new Set(words.filter(word=>word.source==='ocr').map(word=>word.pass))]},source:{name:artwork.name,kind:artwork.kind,dpi:artwork.picture?.dpi??artwork.dpi??artwork.density?.x??null},page:size,
  scale:{...physical,sourcePixelMm:artwork.pageMm?sourcePixelMm??artwork.pageMm.width/size.width:physical.mmPerPixel},label:region,hasContour,declared,words};
 mark=performance.now();
 const readings=toAppWords(result),matches=assess({rules,words:readings,secondaryWords:[],volume,margin:false,label:region,hasContour,edgeProbes:[],page:size});
 timings.compareMs=Math.round(performance.now()-mark);timings.totalMs=Math.round(performance.now()-started);
 return {result,words:readings,matches,timings,text:result.words.map(word=>word.text).join(' ')};
}
