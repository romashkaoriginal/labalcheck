import {dimensionChecks,variantText,words} from './engine.js';
import {mapBox} from './automatic.js';

// Pink prepress callouts are assertions written on the proof, not measured ink.
// Colour isolation only helps OCR find those assertions; it never supplies mm.
export function annotationMask({data,width,height}){
 const output=new Uint8ClampedArray(data.length);let count=0;
 for(let i=0;i<data.length;i+=4){
  const r=data[i],g=data[i+1],b=data[i+2];
  const pink=r>150&&r-g>65&&b-g>35&&b>65;
  output[i]=output[i+1]=output[i+2]=pink?0:255;output[i+3]=255;if(pink)count++;
 }
 return {data:output,width,height,count};
}

// Condensed pink "mm" is often read as Cyrillic тт/пт/пит by rus+eng OCR.
// These aliases are accepted only inside the isolated annotation layer.
const sizeUnit=/(?:мм|mm|тт|пт|пит|тит|гот|гат|тот|тип|плит|глт)/iu;
const sizePattern=/(?<![\p{L}\p{N}.,])((?:\d{1,2})(?:[.,]\d{1,3})?)\s*(?:мм|mm|тт|пт|пит|тит|гот|гат|тот|тип|плит|глт)(?!\p{L})/giu;
export function sizesFromOcr(ocr,rotation,width,height){
 const out=[];
 for(const line of (ocr.blocks||[]).flatMap(block=>block.paragraphs||[]).flatMap(p=>p.lines||[])){
  const text=(line.words||[]).map(word=>word.text).join(' ').replace(/\s+/g,' ');
  // A print-window format such as 49×6 mm and a 5×5 mm symbol are not text heights.
  if(/[×*]|\d\s*[xх]\s*\d/i.test(text))continue;
  const claims=[...text.matchAll(sizePattern)];if(claims.length>1)continue;
  for(const match of claims){
   const value=Number(match[1].replace(',','.'));
   if(value<.4||value>12||!line.bbox)continue;
   const numberIndex=(line.words||[]).findIndex(word=>word.text.includes(match[1]));
   const number=line.words?.[numberIndex]||line.words?.[0];
   const unit=(line.words||[]).slice(Math.max(0,numberIndex)).find(word=>sizeUnit.test(word.text))||number;
   const confidence=number?.confidence??line.confidence??0;
   if(confidence<55)continue;
   const bounds=number?.bbox&&unit?.bbox?{x0:Math.min(number.bbox.x0,unit.bbox.x0),y0:Math.min(number.bbox.y0,unit.bbox.y0),x1:Math.max(number.bbox.x1,unit.bbox.x1),y1:Math.max(number.bbox.y1,unit.bbox.y1)}:line.bbox;
   out.push({value,raw:match[0],box:mapBox(bounds,{x:0,y:0,w:1,h:1},width,height,rotation),confidence,rotation});
  }
 }
 return out;
}

export function dedupeSizes(readings){
 const chosen=[];
 for(const reading of [...readings].sort((a,b)=>b.confidence-a.confidence)){
  const x=reading.box.x+reading.box.w/2,y=reading.box.y+reading.box.h/2;
  if(chosen.some(previous=>Math.abs(previous.value-reading.value)<.011&&Math.abs(previous.box.x+previous.box.w/2-x)<.018&&Math.abs(previous.box.y+previous.box.h/2-y)<.018))continue;
  chosen.push(reading);
 }
 return chosen.sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
}

export function proofLines(ocrWords,label){
 const groups=new Map();
 for(const word of ocrWords){
  if(word.line==null||!word.text?.trim())continue;
  const b=word.box,cx=b.x+b.w/2,cy=b.y+b.h/2;
  if(label&&cx>=label.x&&cx<=label.x+label.w&&cy>=label.y&&cy<=label.y+label.h)continue;
  const key=`${word.pass}:${word.line}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(word);
 }
 return [...groups.values()].map(group=>{
  const x=Math.min(...group.map(w=>w.box.x)),y=Math.min(...group.map(w=>w.box.y));
  return {text:group.map(w=>w.text).join(' '),box:{x,y,w:Math.max(...group.map(w=>w.box.x+w.box.w))-x,h:Math.max(...group.map(w=>w.box.y+w.box.h))-y}};
 });
}

const relevant=text=>[...new Set(words(text).filter(token=>token.length>2&&!/^(?:для|при|это|или|его|она|также|только|всех|согласно)$/u.test(token)))];
const gap=(a,b,axis)=>Math.max(0,b[axis]-a[axis]-(axis==='x'?a.w:a.h),a[axis]-b[axis]-(axis==='x'?b.w:b.h));
const oneSubstitution=(a,b)=>a.length===b.length&&a.length>=9&&[...a].reduce((n,char,i)=>n+(char!==b[i]),0)<=1;
export function linkDeclaredSizes(readings,lines,rules,volume,margin=false){
 return readings.map(reading=>{
  const candidates=[];
  for(const line of lines){
   // Vertical callouts stand beside the indicated inscription. Reading a
   // different line that crosses behind the callout is a common false link.
   if(reading.rotation===90&&line.box.x<reading.box.x+reading.box.w-.004)continue;
   if(reading.rotation===270&&line.box.x+line.box.w>reading.box.x+.004)continue;
   if(reading.rotation===0&&Math.abs(line.box.y+line.box.h/2-reading.box.y-reading.box.h/2)>.009)continue;
   const dx=gap(reading.box,line.box,'x'),dy=gap(reading.box,line.box,'y');
   if(dx>.065||dy>.026)continue;
   if(reading.rotation===0&&dx>.02)continue;
   const lineTokens=relevant(line.text);if(!lineTokens.length)continue;
   for(const rule of rules){
    const checks=dimensionChecks(rule,margin).filter(check=>check.unit==='мм');if(!checks.length)continue;
    const expectedTokens=relevant(variantText(rule,volume)),expected=new Set(expectedTokens);
    const joined=expectedTokens.slice(0,-1).map((token,i)=>token+expectedTokens[i+1]);
    const shared=lineTokens.reduce((n,token)=>n+(expected.has(token)?1:joined.some(pair=>oneSubstitution(token,pair))?2:0),0);
    const ratio=shared/Math.min(6,lineTokens.length);
    if(shared<2||ratio<.34)continue;
    const score=Math.min(shared,4)*1.5+ratio*4-dx*70-dy*180;
    candidates.push({ruleId:rule.id,line:line.text,score,checks});
   }
  }
  candidates.sort((a,b)=>b.score-a.score);const best=candidates[0],other=candidates.find(item=>item.ruleId!==best?.ruleId);
  if(!best||best.score<5||other&&best.score-other.score<1.2)return {...reading,ruleId:null,checkIndex:null,reason:'Не удалось надёжно связать выноску с текстом требования.'};
  let checkIndex=best.checks.length===1?0:null;
  if(best.checks.length>1){
   const lower=best.line.toLowerCase().replace(/ё/g,'е');
   if(/\bдат[а-я]*\b/u.test(lower)){const dateIndex=best.checks.findIndex(check=>check.target==='date_label');if(dateIndex>=0)checkIndex=dateIndex;}
   const matches=best.checks.map((check,index)=>({index,common:relevant(check.label).filter(token=>lower.includes(token)).length})).sort((a,b)=>b.common-a.common);
   if(checkIndex==null&&matches[0].common>0&&matches[0].common>matches[1].common)checkIndex=matches[0].index;
  }
  const check=checkIndex==null?null:best.checks[checkIndex];
  return {...reading,ruleId:best.ruleId,checkIndex,nearText:best.line,minimum:check?.min??null,passes:check?reading.value>=check.min:null,
   reason:check?'Размер указан выноской типографии; фактическая высота печати не измерена.':'К этому разделу относятся несколько размеров; назначение выноски требует проверки.'};
 });
}

export function applyDeclaredDimensions(matches,annotations){
 const groups=new Map();
 for(const item of annotations){
  if(!item.ruleId||item.checkIndex==null||item.confidence<70)continue;
  const key=`${item.ruleId}:${item.checkIndex}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);
 }
 for(const [key,items] of groups){
  const [ruleId,indexText]=key.split(':'),index=Number(indexText),match=matches[ruleId];
  if(!match||Number.isFinite(match.dimensions?.[index]))continue;
  if(items.some(item=>Math.abs(item.value-items[0].value)>.05)){
   match.measurementNotes[index]='На техлисте разные значения для одной надписи; нужна ручная сверка выносок.';continue;
  }
  const best=items.sort((a,b)=>b.confidence-a.confidence)[0];
  match.dimensions[index]=best.value;
  match.measurementMeta[index]={method:'declared',ocrConfidence:best.confidence};
  match.measurementNotes[index]='Число OCR прочитано с цветной выноски технического листа, а не измерено по буквам. Проверьте, что выноска относится к печатной надписи.';
 }
 return matches;
}
