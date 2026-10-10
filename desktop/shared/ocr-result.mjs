// One format for whatever read the artwork — the browser engines of the web
// version, the local OCR process, the text layer of a PDF, the barcode reader.
// It is the only thing that crosses the boundary between an OCR method and the
// comparison with the requirements.
//
//   {
//    schema: 'label-check.ocr-result/1',
//    method: 'baseline-web' | 'local-onnx' | …,
//    engine: {det, rec, runtime, params},          what produced the readings
//    page:   {width, height},                      pixels of the source page image
//    scale:  {mmPerPixel, level, origin, sourcePixelMm},
//            physical scale of a page pixel; sourcePixelMm is the size of the
//            pixels that really exist in the file (a picture inside a PDF keeps
//            its own however large the page is drawn); null where unknown
//    words: [{
//      text,                                       as read, never corrected
//      box: {x, y, w, h},                          pixels of the source page
//      rotation: 0 | 90 | 180 | 270,               clockwise turn that makes it upright
//      confidence: 0…100,
//      source: 'ocr' | 'pdf-text' | 'barcode',     where the reading comes from
//      engine: 'tesseract' | 'paddle-web' | 'paddle-local' | 'pdf' | 'barcode',
//      pass,                                       one reading of one area in one direction
//      line                                        id of its line inside the pass, or null
//    }]
//   }
export const SCHEMA='label-check.ocr-result/1';

// The comparison of the web version decides what is "read with confidence" by
// thresholds (75, 80) that were set for Tesseract's confidence. The local
// engine is far surer of itself: where Tesseract says 80–90 its words are
// right 87 times in 100, while the local engine's are right only 58 times —
// it reaches 88 at 95–99 and 98 only above 99 (measured on the Rose sheet,
// bench/truth). This puts the local engine's confidence on Tesseract's scale,
// so that the same thresholds mean the same share of right words. It changes
// no threshold and no reading.
const scale=[[0,0],[62,40],[85,62],[92.5,72],[97,85],[99.5,97],[100,99]];
export function onTesseractScale(confidence){
 const value=Math.max(0,Math.min(100,confidence));
 for(let i=1;i<scale.length;i++)if(value<=scale[i][0]){const [x0,y0]=scale[i-1],[x1,y1]=scale[i];return y0+(value-x0)/(x1-x0)*(y1-y0);}
 return 99;
}

// Lines of the local engine, read on a crop of the page, as words of the page.
// `crop`: {x, y} of the crop on the page in page pixels and `zoom`, the number
// of crop pixels per page pixel (above 1 when outlines of a PDF were drawn
// again larger for reading).
export function wordsFromEngine(lines,{crop={x:0,y:0},zoom=1,pass='local'}={}){
 return readingOrder(lines).flatMap(line=>line.words.map(word=>({
  text:word.text,
  box:{x:crop.x+word.box.x0/zoom,y:crop.y+word.box.y0/zoom,w:(word.box.x1-word.box.x0)/zoom,h:(word.box.y1-word.box.y0)/zoom},
  rotation:line.rotation,confidence:word.confidence,source:'ocr',engine:'paddle-local',pass:`${pass}:${line.rotation}`,line:`${pass}-${line.row}`,
 })));
}

// The detector returns boxes, not a page layout: a justified line may come as
// several boxes, and two columns of text stand side by side. The comparison
// reads words in the order it is given them and expects a line to have one
// id, as a layout-analysing engine provides. So boxes of one direction are
// put into rows (boxes side by side on one baseline) and rows into blocks
// (rows under one another in one column); blocks follow one another whole.
// Nothing is read or dropped here; `row` is the id of the printed line and
// `block` of the column it belongs to.
export function readingOrder(lines){
 // A box in the frame its text is read in: `start`…`end` along the line, `top`…`bottom` across lines.
 const frame=line=>{const b=line.box;return line.rotation===90?{start:-b.y1,end:-b.y0,top:b.x0,bottom:b.x1}:line.rotation===270?{start:b.y0,end:b.y1,top:-b.x1,bottom:-b.x0}:line.rotation===180?{start:-b.x1,end:-b.x0,top:-b.y1,bottom:-b.y0}:{start:b.x0,end:b.x1,top:b.y0,bottom:b.y1};};
 const sameBaseline=(a,b)=>{const one=a.bottom-a.top,two=b.bottom-b.top;return Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<Math.min(one,two)*.5&&Math.max(one,two)/Math.min(one,two)<1.8;};
 const ordered=[];let rowId=0,blockId=0;
 for(const rotation of [0,90,180,270]){
  const items=lines.filter(line=>line.rotation===rotation).map(line=>({line,...frame(line)})).sort((a,b)=>a.top-b.top||a.start-b.start),rows=[];
  for(const item of items){
   const height=item.bottom-item.top;
   const row=rows.findLast(other=>sameBaseline(item,other)&&item.start>=other.end-height*.5&&item.start-other.end<height*.8);
   if(row){row.items.push(item);row.end=Math.max(row.end,item.end);row.top=Math.min(row.top,item.top);row.bottom=Math.max(row.bottom,item.bottom);}
   else rows.push({items:[item],start:item.start,end:item.end,top:item.top,bottom:item.bottom});
  }
  const blocks=[];
  for(const row of rows.sort((a,b)=>a.top-b.top||a.start-b.start)){
   const height=row.bottom-row.top;let best=null,nearest=Infinity;
   for(const block of blocks){
    const last=block.at(-1),other=last.bottom-last.top,gap=row.top-last.bottom,overlap=Math.min(row.end,last.end)-Math.max(row.start,last.start);
    if(gap<-Math.min(height,other)*.5||gap>Math.max(height,other)*1.5||Math.max(height,other)/Math.min(height,other)>1.8)continue;
    if(overlap<Math.min(row.end-row.start,last.end-last.start)*.3&&Math.abs(row.start-last.start)>Math.max(height,other)*1.5)continue;
    if(gap<nearest){nearest=gap;best=block;}
   }
   if(best)best.push(row);else blocks.push([row]);
  }
  // A justified line comes as several boxes with wide gaps between them. A
  // lone piece joins the row it continues only when it lies inside that
  // row's column: a sign or a caption standing beside a column on the same
  // baseline lies outside it and stays apart.
  const extent=block=>({from:Math.min(...block.map(row=>row.start)),to:Math.max(...block.map(row=>row.end))});
  for(const block of blocks){
   if(block.length>2)continue;
   for(const row of [...block]){
    const height=row.bottom-row.top;let host=null;
    for(const other of blocks){
     if(other===block||other.length<3)continue;
     const column=extent(other);if(row.start<column.from-height*.5||row.end>column.to+height*.5)continue;
     host=other.find(candidate=>sameBaseline(row,candidate)&&row.start>=candidate.end-height*.5&&row.start-candidate.end<height*4);if(host)break;
    }
    if(!host)continue;
    host.items.push(...row.items);host.end=Math.max(host.end,row.end);block.splice(block.indexOf(row),1);
   }
  }
  for(const block of blocks.filter(item=>item.length).sort((a,b)=>a[0].top-b[0].top||a[0].start-b[0].start)){
   blockId++;
   for(const row of block){rowId++;for(const item of row.items.sort((a,b)=>a.start-b.start))ordered.push({...item.line,row:rowId,block:blockId});}
  }
 }
 return ordered;
}

const turned=(box,rotation,aspect)=>{
 const {x,y,w,h}=box;
 if(rotation===90)return {x:1-y-h,y:x*aspect,w:h,h:w*aspect};
 if(rotation===180)return {x:(1-x-w)*aspect,y:1-y-h,w:w*aspect,h};
 if(rotation===270)return {x:y,y:(1-x-w)*aspect,w:h,h:w*aspect};
 return {x:x*aspect,y,w:w*aspect,h};
};

// The shape the existing comparison (src/automatic.js `assess`) takes: places
// as fractions of the page, and a box in reading order for each word.
export function toAppWords(result){
 const {width,height}=result.page,aspect=width/height;
 return result.words.map(word=>{
  const box={x:word.box.x/width,y:word.box.y/height,w:word.box.w/width,h:word.box.h/height},rotation=word.rotation||0;
  if(word.source!=='ocr')return {text:word.text,confidence:word.confidence,box,glyphs:[],pass:word.pass};
  return {text:word.text,confidence:word.confidence,box,rotation,pass:word.pass,line:word.line??undefined,readingBox:turned(box,rotation,aspect),pageAspect:aspect,glyphs:[],ocrEngine:word.engine==='paddle-local'?'paddle':word.engine};
 });
}

// Words as the web version keeps them (state.words, state.secondaryWords), in
// the same format — so both methods are compared from one description.
export function fromAppWords(words,page,{method='baseline-web',engine={},scale=null}={}){
 const source=word=>word.pass==='pdf'?'pdf-text':word.pass==='barcode'?'barcode':'ocr';
 return {schema:SCHEMA,method,engine,page,scale,words:words.filter(word=>word.box&&word.text?.trim()).map(word=>({
  text:word.text,box:{x:word.box.x*page.width,y:word.box.y*page.height,w:word.box.w*page.width,h:word.box.h*page.height},rotation:word.rotation||0,confidence:word.confidence??0,
  source:source(word),engine:word.pass==='pdf'?'pdf':word.pass==='barcode'?'barcode':word.ocrEngine==='paddle'?'paddle-web':'tesseract',pass:word.pass??null,line:word.line??null,
 }))};
}

export function validate(result){
 const problems=[];
 if(result?.schema!==SCHEMA)problems.push(`schema is not ${SCHEMA}`);
 if(!(result?.page?.width>0&&result?.page?.height>0))problems.push('page size is missing');
 for(const [index,word] of (result?.words||[]).entries()){
  if(typeof word.text!=='string'||!word.text.trim())problems.push(`word ${index}: empty text`);
  if(!word.box||![word.box.x,word.box.y,word.box.w,word.box.h].every(Number.isFinite)||word.box.w<=0||word.box.h<=0)problems.push(`word ${index}: bad box`);
  if(![0,90,180,270].includes(word.rotation))problems.push(`word ${index}: rotation ${word.rotation}`);
  if(!(word.confidence>=0&&word.confidence<=100))problems.push(`word ${index}: confidence ${word.confidence}`);
  if(!['ocr','pdf-text','barcode'].includes(word.source))problems.push(`word ${index}: source ${word.source}`);
  if(problems.length>20)break;
 }
 return problems;
}
