// Quantities are parsed separately from prose. An example in column 2 is never
// used as the expected product quantity; column 3 is the source of truth.
const units={л:['volume',1,'л'],l:['volume',1,'л'],литр:['volume',1,'л'],литра:['volume',1,'л'],литров:['volume',1,'л'],мл:['volume',.001,'мл'],ml:['volume',.001,'мл'],cl:['volume',.01,'сл'],сл:['volume',.01,'сл'],дм3:['volume',1,'дм³'],dm3:['volume',1,'дм³'],м3:['volume',1000,'м³'],m3:['volume',1000,'м³'],г:['mass',1,'г'],g:['mass',1,'г'],кг:['mass',1000,'кг'],kg:['mass',1000,'кг'],мг:['mass',.001,'мг'],mg:['mass',.001,'мг']};
export const isQuantityRule=rule=>/^(?:об[ъь]?[её]м|масса(?: нетто)?|количество(?: товара)?|номинальный об[ъь]?[её]м)$/i.test(rule.title.trim());
export function quantities(text){
 const result=[],source=String(text).toLowerCase().replace(/³/g,'3');
 for(const m of source.matchAll(/(?<![\p{L}\p{N}.,+-])(\d+(?:[.,]\d+)?)\s*(литров|литра|литр|дм3|dm3|м3|m3|мл|ml|cl|сл|кг|kg|мг|mg|л|l|г|g)(?![\p{L}\p{N}])/gu)){
  const [kind,factor,unit]=units[m[2]],value=Number(m[1].replace(',','.'));result.push({value,unit,kind,baseValue:value*factor,text:m[0],index:m.index});
 }
 return result;
}
export function expectedQuantity(rule,expected){const parsed=quantities(expected);return parsed.length===1?parsed[0]:null;}
export function quantityComparison(expected,actual){
 if(!expected)return 'ambiguous';if(!actual)return 'unreadable';
 if(expected.kind!==actual.kind)return 'wrong_unit';
 if(Math.abs(expected.baseValue-actual.baseValue)>Math.max(1e-9,Math.abs(expected.baseValue)*1e-9))return expected.unit===actual.unit?'wrong_value':'wrong_quantity';
 return expected.unit===actual.unit?'match':'equivalent';
}
const inside=(box,label)=>label&&box.x>=label.x-.002&&box.y>=label.y-.002&&box.x+box.w<=label.x+label.w+.002&&box.y+box.h<=label.y+label.h+.002;
export const insideLabel=inside;
function readingRect(word,rotation=word.rotation||0){
 const {x,y,w,h}=word.box,a=word.pageAspect||1;
 if(rotation===90)return {x:1-y-h,y:x*a,w:h,h:w*a};
 if(rotation===180)return {x:(1-x-w)*a,y:1-y-h,w:w*a,h};
 if(rotation===270)return {x:y,y:(1-x-w)*a,w:h,h:w*a};
 return {x:x*a,y,w:w*a,h};
}
export function glyphHeight(words,pattern){
 const glyphs=words.filter(w=>(w.confidence??0)>=80).flatMap(w=>w.glyphs||[]).filter(g=>pattern.test(g.text)&&Number.isFinite(g.height)&&g.height>0);
 return glyphs.length?Math.min(...glyphs.map(g=>g.height)):null;
}
function quantityHeights(words){
 const number=[],unit=[];let unitStarted=false;
 for(const word of words){if((word.confidence??0)<80)continue;
  for(const glyph of word.glyphs||[]){if(/\p{L}/u.test(glyph.text))unitStarted=true;
   if(!Number.isFinite(glyph.height)||glyph.height<=0)continue;
   if(unitStarted)unit.push(glyph.height);else if(/\d/.test(glyph.text))number.push(glyph.height);
  }
 }
 return {numberHeight:number.length?Math.min(...number):null,unitHeight:unit.length?Math.min(...unit):null};
}
export function quantityEvidence(rule,expected,words,candidates,label,hasContour){
 const wanted=expectedQuantity(rule,expected),found=[];
 for(const c of candidates)for(let i=0;i<c.words.length;i++)for(const size of [1,2,3]){
  const group=c.words.slice(i,i+size);if(group.length!==size||group.some(w=>(w.confidence??0)<75||hasContour&&!inside(w.box,label)))continue;
  // Prevent assembling a quantity from different lines or distant panels.
  const boxes=group.map(w=>w.readingBox||w.box),height=Math.max(...boxes.map(b=>b.h));
  if(boxes.some((b,j)=>j&&Math.abs(b.y+b.h/2-boxes[0].y-boxes[0].h/2)>height*.6)||boxes.some((b,j)=>j&&(b.x-boxes[j-1].x-boxes[j-1].w>height*1.5||b.x<boxes[j-1].x)))continue;
  const text=group.map(w=>w.text).join(' '),values=quantities(text);
  if(values.length!==1||!/^\s*\d+[.,]?\d*\s*[\p{L}³\d]+\s*$/u.test(text))continue;
  const surrounding=c.words.slice(Math.max(0,i-3),i+size+3);
  if(surrounding.some(w=>/^(?:на|продукта|ценность|ценности|углеводы|белки|жиры|калорийность)$/i.test(w.text.replace(/[.,:;()]/g,''))&&boxes.some(b=>{const r=w.readingBox||w.box;return Math.abs(r.y+r.h/2-b.y-b.h/2)<Math.min(r.h,b.h)*.8&&Math.max(r.h,b.h)/Math.min(r.h,b.h)<1.8&&Math.abs(r.x-b.x)<height*10;})))continue;
  const value=values[0];found.push({...value,words:group,score:Math.min(...group.map(w=>w.confidence??0)),uncertain:c.tokens?.some(t=>t.uncertainValues&&t.words.some(w=>group.includes(w)))});
 }
 // Deduplicate repeated OCR of one physical marking. Never prefer a reading
 // just because it matches Word: conflicting numeric readings stay ambiguous.
 found.sort((a,b)=>b.score-a.score);const best=found[0];
 const credible=found.filter(f=>f.score>=85),distinct=new Set(credible.map(f=>`${f.kind}:${f.baseValue}:${f.unit}`));
 const conflict=distinct.size>1||best?.uncertain;
 const status=conflict?'ambiguous':quantityComparison(wanted,best);
 return {expected:wanted,actual:best?{value:best.value,unit:best.unit,kind:best.kind,baseValue:best.baseValue,text:best.text}:null,status,words:best?.words||[],...(!conflict&&best?quantityHeights(best.words):{numberHeight:null,unitHeight:null})};
}

export function dateEvidence(match,words,label,hasContour){
 if(!match?.exact||match.distributed||!hasContour||match.words.some(w=>!inside(w.box,label)))return {words:[],reason:'Подпись даты не найдена уверенно внутри этикетки.'};
 const rotation=match.rotation||0,boxes=match.words.map(w=>readingRect(w,rotation)),x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y)),right=Math.max(...boxes.map(b=>b.x+b.w)),bottom=Math.max(...boxes.map(b=>b.y+b.h)),h=bottom-y;
 const digits=words.filter(w=>{const b=readingRect(w,rotation);return (w.confidence??0)>=80&&inside(w.box,label)&&(w.rotation||0)===rotation&&/\d/.test(w.text)&&!/^\d{13}$/.test(w.text)&&/^[\d.,/: -]+$/.test(w.text)&&b.x>=x-h&&b.x<right+h*8&&((b.x>=right-h*.3&&Math.abs(b.y-y)<h*1.5)||(b.y>=bottom-h*.1&&b.y<bottom+h*3));});
 return {words:digits,numberHeight:glyphHeight(digits,/\d/),text:[...new Set(digits.map(w=>w.text))].join(' '),reason:digits.length?'':'Цифры даты / партии на макете не найдены. Для пустого окна нужен образец с нанесённой датой.'};
}

// Local readings isolate mixed-size quantities from nearby barcodes and signs.
// Coordinates come from the artwork, not a fixed label template.
export function quantityReadAreas(words,label,hasContour){
 const anchors=words.filter(w=>(w.confidence??0)>=80&&(!hasContour||inside(w.box,label))&&/^(?:об[ъь]?[её]м|масса(?: нетто)?)$/i.test(w.text.trim())),areas=[];
 for(const word of anchors){if(word.rotation)continue;const b=word.box;
  for(const box of [{x:b.x-b.h*.2,y:b.y+b.h,w:b.w+b.h*.4,h:b.h*2.35},{x:b.x+b.w,y:b.y-b.h*.5,w:b.w*1.5,h:b.h*2.1}]){
   const area={x:Math.max(0,box.x),y:Math.max(0,box.y),w:Math.min(box.w,1-Math.max(0,box.x)),h:Math.min(box.h,1-Math.max(0,box.y)),rotation:0,lineCount:1};
   if(hasContour&&!inside(area,label)||areas.some(a=>Math.abs(a.x-area.x)<.003&&Math.abs(a.y-area.y)<.003))continue;areas.push(area);
  }
 }
 return areas.slice(0,6);
}

// A decimal comma can be dropped by OCR in a condensed font. Recover it only
// from a separate ink component below the digit baseline, never from Word.
export function numericInk(pixels){
 const {width,height,data}=pixels,seen=new Uint8Array(width*height),components=[];
 const dark=i=>{const n=i*4;return Math.max(data[n],data[n+1],data[n+2])<150&&Math.max(data[n],data[n+1],data[n+2])-Math.min(data[n],data[n+1],data[n+2])<75;};
 for(let i=0;i<seen.length;i++){
  if(seen[i]||!dark(i))continue;const queue=[i];seen[i]=1;let x0=width,y0=height,x1=0,y1=0;
  for(let q=0;q<queue.length;q++){const n=queue[q],x=n%width,y=Math.floor(n/width);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
   for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){const xx=x+dx,yy=y+dy,k=yy*width+xx;if(xx<0||xx>=width||yy<0||yy>=height||seen[k]||!dark(k))continue;seen[k]=1;queue.push(k);}
  }
  if(queue.length>=Math.max(6,width*height*.00015))components.push({x:x0,y:y0,w:x1-x0+1,h:y1-y0+1});
 }
 const largest=Math.max(0,...components.map(c=>c.h)),digits=components.filter(c=>c.h>=largest*.65).sort((a,b)=>a.x-b.x),separators=[];
 for(const c of components){if(c.h>largest*.35||c.w>largest*.45||c.y+c.h<Math.max(...digits.map(d=>d.y+d.h))-largest*.2)continue;
  const index=digits.findIndex((d,i)=>i>0&&c.x>=digits[i-1].x+digits[i-1].w-largest*.12&&c.x+c.w<=d.x+2);if(index>0)separators.push(index);
 }
 return {digits,separators,components};
}
export function recoverNumericReading(text,symbols,ink){
 const clean=String(text).trim(),digitSymbols=symbols.filter(s=>/^\d$/.test(s.text));
 if(!/^\d+(?:[.,]\d+)?$/.test(clean)||digitSymbols.length!==ink.digits.length||digitSymbols.some(s=>s.confidence<85))return null;
 const digits=clean.replace(/[.,]/g,'');if(digits.length!==ink.digits.length||digitSymbols.map(s=>s.text).join('')!==digits||ink.separators.length>1)return null;
 if(/[.,]/.test(clean)){const index=clean.search(/[.,]/);if(ink.separators.length!==1||ink.separators[0]!==index)return null;return clean.replace('.',',');}
 if(ink.separators.length===1){const at=ink.separators[0];return digits.slice(0,at)+','+digits.slice(at);}
 return digits;
}
