// Stands where `tesseract.js` stands in the web version (the desktop build
// puts it there; src/app.js is not changed). With ?primary=local in the
// address the whole reading order of the web version — every pass, every line
// cut out by its ink, every place read again — runs on the local OCR process
// instead of Tesseract; otherwise the real Tesseract.js is handed out.
//
// The web version talks to its engine in Tesseract's terms: a page
// segmentation mode says what the picture is (a page, a block, one line, one
// word), a whitelist says which characters may come back, and the answer is
// blocks → paragraphs → lines → words → symbols with boxes. This file
// translates both ways and decides nothing about the text.
import {createWorker as createTesseract} from 'tesseract.js';
import {readingOrder,onTesseractScale} from '../../shared/ocr-result.mjs';

const settings=new URLSearchParams(location.search),desktop=window.parent?.desktop;
export const primary=settings.get('primary')==='local'&&desktop?'local':'tesseract';

const pixelsOf=source=>{const context=source.getContext('2d',{willReadFrequently:true}),image=context.getImageData(0,0,source.width,source.height);return {data:image.data,width:image.width,height:image.height};};
const corners=box=>({x0:box.x0,y0:box.y0,x1:box.x1,y1:box.y1});
const union=boxes=>({x0:Math.min(...boxes.map(box=>box.x0)),y0:Math.min(...boxes.map(box=>box.y0)),x1:Math.max(...boxes.map(box=>box.x1)),y1:Math.max(...boxes.map(box=>box.y1))});

// Lines of the local engine as Tesseract's page structure: a block of text is
// a block, a printed line (which the detector may return in pieces) a line.
function page(lines){
 const blocks=new Map();
 for(const line of readingOrder(lines)){
  if(!line.words.length)continue;
  if(!blocks.has(line.block))blocks.set(line.block,new Map());
  const rows=blocks.get(line.block);if(!rows.has(line.row))rows.set(line.row,[]);
  rows.get(line.row).push(...line.words.map(word=>({text:word.text,confidence:onTesseractScale(word.confidence),bbox:corners(word.box),symbols:word.symbols.map(symbol=>({text:symbol.text,confidence:onTesseractScale(symbol.confidence),bbox:corners(symbol.box)}))})));
 }
 const all=[...blocks.values()].map(rows=>({paragraphs:[{lines:[...rows.values()].map(words=>({words,bbox:union(words.map(word=>word.bbox)),text:words.map(word=>word.text).join(' ')}))}]}));
 const rows=all.flatMap(block=>block.paragraphs[0].lines),words=rows.flatMap(row=>row.words);
 return {text:rows.map(row=>row.text).join('\n')+(rows.length?'\n':''),confidence:words.length?words.reduce((sum,word)=>sum+word.confidence,0)/words.length:0,blocks:all};
}

// How long the picture should be for the detector, by what the web version
// says the picture is. It always hands over pictures already enlarged for
// Tesseract; the detector finds small print best on a region about 2000
// pixels long, and the sparse pass looks at the same region smaller, where
// large print holds together. Reading uses the picture as it came.
const detectorLength={'3':2000,'11':1200,'6':1600};

function localWorker({logger}={}){
 const parameters={tessedit_pageseg_mode:'3',tessedit_char_whitelist:''};
 return {
  async setParameters(next){Object.assign(parameters,next);},
  async recognize(source){
   const image=pixelsOf(source),mode=String(parameters.tessedit_pageseg_mode),allow=parameters.tessedit_char_whitelist||'',id=crypto.randomUUID();
   // One line or one word: nothing to search for, the picture is the line.
   const single=['7','8','13'].includes(mode);
   const reply=single?await desktop.lines({id,images:[image],options:{allow}}):await desktop.recognize({id,image,options:{scale:Math.min(1,(detectorLength[mode]||1600)/Math.max(image.width,image.height)),upright:true,allow}});
   logger?.({status:'recognizing text',progress:1});
   return {data:page(reply.result.lines.filter(line=>line.text))};
  },
  async terminate(){},
 };
}

export function createWorker(language,engineMode,options){
 return primary==='local'?Promise.resolve(localWorker(options)):createTesseract(language,engineMode,options);
}
