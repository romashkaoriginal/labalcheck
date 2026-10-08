import {variantText, dimensionChecks} from './engine.js';
import {locatePhrase,orderedTextCandidates} from './phrase.js';
import {isQuantityRule,quantities,expectedQuantity,quantityComparison,quantityEvidence,dateEvidence,glyphHeight,insideLabel} from './quantity.js';

// Detect closed chromatic die-cut contours, independent of position and hue.
// When no closed contour is supported by pixels, keep the whole page.
export function detectFrames({data,width,height},colorBand=null) {
  if(colorBand===null){
    const all=[];for(const band of ['magenta','cyan','red','blue','green','mixed'])for(const frame of detectFrames({data,width,height},band))if(!all.some(f=>Math.abs(f.x-frame.x)<.005&&Math.abs(f.y-frame.y)<.005&&Math.abs(f.w-frame.w)<.005&&Math.abs(f.h-frame.h)<.005))all.push(frame);
    // A printed contour may change ink colour along an edge. Join boxes with
    // the same left edge and overlapping height before selecting a candidate.
    const merged=[];
    for(const frame of all){const other=merged.find(box=>{const overlap=Math.max(0,Math.min(box.y+box.h,frame.y+frame.h)-Math.max(box.y,frame.y));return Math.abs(box.x-frame.x)<.006&&overlap/Math.min(box.h,frame.h)>.75;});
      if(!other){merged.push({...frame});continue;}
      const widthRatio=Math.max(other.w,frame.w)/Math.min(other.w,frame.w);
      const right=widthRatio>1.25?Math.max(other.x+other.w,frame.x+frame.w):Math.min(other.x+other.w,frame.x+frame.w),bottom=Math.max(other.y+other.h,frame.y+frame.h);other.x=Math.min(other.x,frame.x);other.y=Math.min(other.y,frame.y);other.w=right-other.x;other.h=bottom-other.y;
    }
    return merged.slice(0,8);
  }
  const pink=(x,y)=>{const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2];return colorBand==='mixed'?Math.max(r,g,b)-Math.min(r,g,b)>55&&Math.min(r,g,b)<215:colorBand==='magenta'?r>140&&r>g*1.2&&b>g*1.12:colorBand==='cyan'?g>140&&g>r*1.2&&b>r*1.12:colorBand==='red'?r>140&&r>g*1.5&&r>b*1.5:colorBand==='blue'?b>140&&b>r*1.5&&b>g*1.5:g>140&&g>r*1.5&&g>b*1.5;};
  const lines=[];
  for(let x=0;x<width;x++){
    let start=-1,last=-1,count=0;
    const save=()=>{if(last-start>Math.max(12,height*.035)&&count/(last-start+1)>.24)lines.push({x,y:start,end:last});};
    for(let y=0;y<height;y++)if(pink(x,y)&&!(x>3&&x<width-4&&pink(x-3,y)&&pink(x+3,y))){
      if(start<0||y-last>Math.max(8,height*.012)){if(start>=0)save();start=y;count=0;}
      last=y;count++;
    }
    if(start>=0)save();
  }
  const frames=[];
  for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
    const a=lines[i],b=lines[j],w=b.x-a.x,h=Math.min(a.end,b.end)-Math.max(a.y,b.y);
    if(h<Math.max(12,height*.04)||w<Math.max(12,width*.02)||w>width*.995||Math.abs(a.y-b.y)>height*.025||Math.abs(a.end-b.end)>height*.035)continue;
    const y=Math.max(a.y,b.y);
    const edge=yy=>{let best={score:0,y:yy};for(let dy=-Math.ceil(height*.025);dy<=Math.ceil(height*.025);dy++){const row=Math.round(yy+dy);if(row<0||row>=height)continue;let n=0,gap=0,maxGap=0;for(let x=a.x;x<=b.x;x++){if(pink(x,row)){n++;gap=0;}else if(x>a.x+w*.08&&x<b.x-w*.08){gap++;maxGap=Math.max(maxGap,gap);}}if(maxGap>Math.max(12,width*.012))continue;if(n/(w+1)>best.score)best={score:n/(w+1),y:row};}return best;};
    const top=edge(y),bottom=edge(y+h);
    if(top.score<.35||bottom.score<.35||bottom.y-top.y<Math.max(12,height*.04))continue;
    const r={x:a.x/width,y:top.y/height,w:w/width,h:(bottom.y-top.y)/height};
    if(!frames.some(f=>Math.abs(f.x-r.x)<.02&&Math.abs(f.y-r.y)<.02&&Math.abs(f.w-r.w)<.02&&Math.abs(f.h-r.h)<.02))frames.push(r);
  }
  // Inner fold lines must not turn one label into several partial candidates.
  return frames.filter(a=>!frames.some(b=>b!==a&&a.x>=b.x-.003&&a.y>=b.y-.003&&a.x+a.w<=b.x+b.w+.003&&a.y+a.h<=b.y+b.h+.003&&b.w*b.h>a.w*a.h*1.12)).slice(0,8);
}

export function detectArtworkRegion({data,width,height}) {
  // Printing protocols usually sit below a long horizontal divider. Scan
  // everything above it, including detached artwork and barcode panels.
  const widthOfLine=y=>{let run=0,longest=0;for(let x=0;x<width;x++){const i=(y*width+x)*4,ink=Math.max(data[i],data[i+1],data[i+2])<145;run=ink?run+1:0;longest=Math.max(longest,run);}return longest;};
  for(let y=Math.floor(height*.55);y<height*.92;y++){
    if(widthOfLine(y)<=width*.43)continue;
    let more=0,last=-4;for(let yy=y+4;yy<Math.min(height,y+height*.16);yy++)if(yy-last>3&&widthOfLine(yy)>width*.23){more++;last=yy;if(more>=2)return {x:0,y:0,w:1,h:Math.max(.5,(y-3)/height)};}
  }
  return {x:0,y:0,w:1,h:1};
}

export function mapBox(box,region,width,height,rotation=0) {
  let {x0,y0,x1,y1}=box;
  if(rotation===90)[x0,y0,x1,y1]=[y0,height-x1,y1,height-x0];
  if(rotation===180)[x0,y0,x1,y1]=[width-x1,height-y1,width-x0,height-y0];
  if(rotation===270)[x0,y0,x1,y1]=[width-y1,x0,width-y0,x1];
  return {x:region.x+x0/width*region.w,y:region.y+y0/height*region.h,w:(x1-x0)/width*region.w,h:(y1-y0)/height*region.h};
}

// Horizontal ink projection after orienting a crop. No expected words enter
// segmentation. Each isolated line can be read without its adjacent paragraphs.
export function inkLineAreas({data,width,height},region,rotation=0){
 const rows=new Uint32Array(height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;if(Math.max(data[i],data[i+1],data[i+2])<170)rows[y]++;}
 const threshold=Math.max(2,width*.008),bands=[];let start=-1,last=-1;
 for(let y=0;y<=height;y++){
  if(y<height&&rows[y]>=threshold){if(start<0)start=y;last=y;}
  else if(start>=0&&y-last>2){bands.push({start,end:last+1});start=-1;}
 }
 const sizes=bands.map(b=>b.end-b.start).filter(h=>h>=4).sort((a,b)=>a-b),typical=sizes[Math.floor(sizes.length/2)];
 if(!typical||bands.length<2)return [];
 return bands.filter(b=>b.end-b.start>=typical*.55&&b.end-b.start<typical*2.2).slice(0,60).map(b=>{
  const pad=Math.max(2,Math.floor(typical*.16)),top=Math.max(0,b.start-pad),bottom=Math.min(height,b.end+pad);
  const box=mapBox({x0:0,y0:top,x1:width,y1:bottom},region,rotation%180?height:width,rotation%180?width:height,rotation);
  return {...box,rotation};
 });
}

// Split printed ink at whitespace gutters. This isolates vertical warnings from
// adjacent paragraphs without requiring the operator to draw a rectangle.
export function segmentInk({data,width,height},region) {
  const dark=(x,y)=>{const i=(y*width+x)*4;return Math.max(data[i],data[i+1],data[i+2])<160;};
  const parts=[];
  function split(rect,depth){
    const {x,y,w,h}=rect,cols=new Uint32Array(w),rows=new Uint32Array(h);
    for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++)if(dark(x+xx,y+yy)){cols[xx]++;rows[yy]++;}
    const xs=[...cols.keys()].filter(i=>cols[i]),ys=[...rows.keys()].filter(i=>rows[i]);if(!xs.length||!ys.length)return;
    const x0=xs[0],y0=ys[0],x1=xs.at(-1)+1,y1=ys.at(-1)+1;
    const tight={x:x+x0,y:y+y0,w:x1-x0,h:y1-y0};
    if(tight.w<8||tight.h<8)return;
    let cut=null;
    if(depth<4)for(const [axis,values,start,end,other] of [['x',cols,x0,x1,tight.h],['y',rows,y0,y1,tight.w]]){
      let run=-1;
      for(let i=start;i<=end;i++){
        if(i<end&&values[i]<=Math.floor(other*.002)){if(run<0)run=i;}
        else if(run>=0){const gap=i-run,relative=gap/(end-start);if(run-start>10&&end-i>10&&gap>=3&&relative>.015&&(!cut||relative>cut.score))cut={axis,at:Math.round((run+i)/2),score:relative};run=-1;}
      }
    }
    if(cut){if(cut.axis==='x'){const at=x+cut.at;split({...tight,w:at-tight.x},depth+1);split({...tight,x:at,w:tight.x+tight.w-at},depth+1);}else{const at=y+cut.at;split({...tight,h:at-tight.y},depth+1);split({...tight,y:at,h:tight.y+tight.h-at},depth+1);}return;}
    const pad=3,xx=Math.max(0,tight.x-pad),yy=Math.max(0,tight.y-pad),right=Math.min(width,tight.x+tight.w+pad),bottom=Math.min(height,tight.y+tight.h+pad);
    parts.push({x:region.x+xx/width*region.w,y:region.y+yy/height*region.h,w:(right-xx)/width*region.w,h:(bottom-yy)/height*region.h});
  }
  split({x:0,y:0,w:width,h:height},0);return parts.length>1?parts:[];
}

function visibleHeight(bbox,pixels){
 const {data,width,height}=pixels,x0=Math.max(0,Math.floor(bbox.x0)),x1=Math.min(width,Math.ceil(bbox.x1)),y0=Math.max(0,Math.floor(bbox.y0)),y1=Math.min(height,Math.ceil(bbox.y1));
 let colored=0,total=0;
 for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2];total++;if(Math.max(r,g,b)-Math.min(r,g,b)>75&&Math.min(r,g,b)<190)colored++;}
 const reversed=total>0&&colored/total>.2;
 let start=-1,last=-1,longest=0;
 for(let y=y0;y<y1;y++){let count=0;for(let x=x0;x<x1;x++){const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2];if(reversed?Math.min(r,g,b)>210&&Math.max(r,g,b)-Math.min(r,g,b)<40:Math.max(r,g,b)<150&&Math.max(r,g,b)-Math.min(r,g,b)<75)count++;}
  if(count>=Math.max(1,(x1-x0)*.025)){if(start<0||y-last>2){if(start>=0)longest=Math.max(longest,last-start+1);start=y;}last=y;}
 }
 if(start>=0)longest=Math.max(longest,last-start+1);return longest||null;
}
export function wordsFromOcr(data,region,width,height,rotation,mmPerPixel,pass='ocr',pixels=null) {
  return (data.blocks||[]).flatMap((b,bi)=>(b.paragraphs||[]).flatMap((p,pi)=>(p.lines||[]).flatMap((l,li)=>(l.words||[]).filter(w=>w.text?.trim()).map(w=>({
    text:w.text,confidence:w.confidence,box:mapBox(w.bbox,region,width,height,rotation),rotation,pass,mmPerPixel,
    readingBox:{x:w.bbox.x0,y:w.bbox.y0,w:w.bbox.x1-w.bbox.x0,h:w.bbox.y1-w.bbox.y0},
    line:`${bi}:${pi}:${li}`,pageAspect:width*region.h/(height*region.w),
    glyphs:(w.symbols||[]).filter(s=>/[\p{L}\p{N}]/u.test(s.text)&&s.confidence>=80).map(s=>{const height=pixels?visibleHeight(s.bbox,pixels):s.bbox.y1-s.bbox.y0;return {text:s.text,height:mmPerPixel&&height?height*mmPerPixel:null};}),
  })))));
}

export function locateText(expected,words){return locatePhrase(expected,words);}

function codeConflict(expected,candidates){
 const codes=[...expected.matchAll(/\d{6,}(?:[.-]\d+)*/g)];
 if(codes.length!==1)return null;
 const wanted=codes[0][0],anchors=(expected.slice(0,codes[0].index).match(/\p{L}{2,}/gu)||[]).slice(-2).map(s=>s.toLocaleLowerCase('ru'));
 if(!anchors.length)return null;
 const evidence=[];
 for(const candidate of candidates){
  const found=candidate.words.map(word=>word.text).join(' ');
  for(const code of found.matchAll(/\d{6,}(?:\s*[.-]\s*\d+)*/g)){
   const actual=code[0].replace(/\s+/g,'');if(actual===wanted)continue;
   const before=found.slice(Math.max(0,code.index-80),code.index).toLocaleLowerCase('ru');
   const anchorsSeen=anchors.filter(anchor=>before.includes(anchor));
   if(!anchorsSeen.length)continue;
   const lastAnchor=Math.max(...anchorsSeen.map(anchor=>before.lastIndexOf(anchor)+anchor.length));
   const between=before.slice(lastAnchor);
   // The first long number following a standard/code caption is its value.
   // A later barcode on the same OCR line must not replace that value.
   if(/\d{6,}/.test(between))continue;
   const firstDigits=code[0].match(/^\d{6,}/)[0];
   const word=candidate.words.find(item=>item.text.includes(firstDigits));
   if(!word)continue;
   evidence.push({candidate,word,found,wanted,actual,confidence:word.confidence??0,score:anchorsSeen.length*100+(word.confidence??0)+actual.length*2-between.length});
  }
 }
 return evidence.sort((a,b)=>b.score-a.score)[0]||null;
}

export function matchRequirements(rules,words,volume,margin,label,hasContour) {
  // Enlarged proofs on the same sheet cannot establish presence on the label.
  const scoped=hasContour&&label;
  if(scoped)words=words.filter(word=>insideLabel(word.box,label));
  const candidates=orderedTextCandidates(words);
  return Object.fromEntries(rules.map(rule=>{
    const expected=variantText(rule,volume);let match=locatePhrase(expected,words,candidates,label);
    if(match&&!match.exact&&match.coverage>=35){
      const code=codeConflict(expected,candidates);
      if(code){
       const line=code.word.line==null?code.candidate.words:code.candidate.words.filter(word=>word.line===code.word.line);
       const focus=line.length?line:code.candidate.words,other=(match.diff||[]).filter(change=>!(change.kind==='missing'&&change.expected.replace(/\D/g,'')===code.wanted.replace(/\D/g,'')));
       match={...match,method:'code-review',recognizedText:focus.map(word=>word.text).join(' ').replace(/(?<=\d)\s+([.-])\s*(?=\d)/g,'$1'),words:focus,diff:[...other,{kind:'replace',expected:code.wanted,actual:code.actual,confidence:code.confidence}]};
      }
    }
    if(/знаки|мебиус|рюмка/i.test(rule.title)||!expected){const notes=dimensionChecks(rule,margin).map(()=>expected?'Размеры графического знака требуют отдельного измерения по оригиналу.':'В столбце 3 не задан текст. Сначала определите применимость раздела и текст для рынка.');return [rule.id,{words:[],exact:false,coverage:0,method:'manual',dimensions:notes.map(()=>null),measurementNotes:notes}];}
    let quantity=isQuantityRule(rule)?quantityEvidence(rule,expected,words,candidates,label,hasContour):null;
    if(quantity&&match?.exact&&['wrong_unit','unreadable'].includes(quantity.status)&&match.words.every(w=>!hasContour||insideLabel(w.box,label))){
      // A complete caption + value read at one location outranks an unrelated
      // sugar/nutrition amount. Do not manufacture glyph heights from it.
      const seen=quantities(match.recognizedText),wanted=expectedQuantity(rule,expected);
      if(seen.length===1&&quantityComparison(wanted,seen[0])==='match')quantity={...quantity,actual:seen[0],status:'match',words:match.words,numberHeight:null,unitHeight:null,source:'exact-phrase'};
    }
    const caption=quantity?locatePhrase(rule.title,words,candidates,label):null;
    if(quantity&&caption?.exact&&quantity.status==='match'){
      const found=[...new Set([...caption.words,...quantity.words])];
      match={words:found,exact:true,distributed:false,coverage:100,method:'quantity',recognizedText:caption.recognizedText+' · '+quantity.actual.text,diff:[]};
    }
    if(!match&&!quantity){if(!scoped||!expected||expected==='-')return [rule.id,null];match={words:[],exact:false,distributed:true,coverage:0,method:'words',recognizedText:'',diff:[]};}
    match??={words:quantity.words,exact:false,distributed:true,coverage:0};
    const date=/окно.*дат/i.test(rule.title)?dateEvidence(match,words,label,hasContour):null;
    const boxes=match.words.map(w=>w.box);
    const measurementNotes=[];
    const dimensions=dimensionChecks(rule,margin).map(d=>{
      const note=text=>{measurementNotes.push(text);return null;};
      if(d.target==='partitioned_letters')return note('Разные минимумы относятся к разным строкам. По общей OCR-фразе их нельзя измерять одним числом; проверьте выноску и оригинал отдельно.');
      if(['quantity','quantity_label','date_label','date_digits'].includes(d.target)){
        if(!hasContour||!label)return note('Контур этикетки не определён: печатный участок нельзя отделить от технических образцов.');
        let value=null;
        if(d.target==='quantity_label')value=caption?.exact&&caption.words.every(w=>insideLabel(w.box,label))?glyphHeight(caption.words,/\p{L}/u):null;
        if(d.target==='quantity'){
          if(quantity?.status==='ambiguous')return note('Несколько разных чтений количества. Нужна сверка по макету.');
          if(Number.isFinite(quantity?.numberHeight)&&Number.isFinite(quantity?.unitHeight))value=Math.min(quantity.numberHeight,quantity.unitHeight);
          else return note('Для количества нужны надёжные размеры и цифр, и единицы. Перечитайте макет или загрузите PDF в масштабе 1:1.');
        }
        if(d.target==='date_label')value=match.exact&&match.words.every(w=>insideLabel(w.box,label))?glyphHeight(match.words,/\p{L}/u):null;
        if(d.target==='date_digits'){value=date?.numberHeight;if(!Number.isFinite(value))return note(date?.reason||'Цифры не удалось измерить. Нужен образец печати с датой / партией.');}
        if(!Number.isFinite(value))return note('Нет надёжных размеров видимых символов. Для замера нужен PDF с физическим масштабом.');
        measurementNotes.push('');return value;
      }
      if(!label||!hasContour)return note('Контур этикетки не определён: размер нельзя подтвердить по печатному участку.');
      if(boxes.length===0||boxes.some(b=>!insideLabel(b,label)))return note('Нужны распознанные символы внутри печатного контура этикетки.');
      if(d.unit==='%'){
        if(!match.exact||match.distributed)return note('Для площади нужно уверенно найти всю предупреждающую надпись внутри этикетки.');
        const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y)),right=Math.max(...boxes.map(b=>b.x+b.w)),bottom=Math.max(...boxes.map(b=>b.y+b.h));
        measurementNotes.push('');
        return (right-x)*(bottom-y)/(label.w*label.h)*100;
      }
      if(/ЕАС/.test(d.label))return note('Графический знак требует отдельного измерения.');
      if(match.coverage<80)return note('Недостаточно прочитанных символов для оценки высоты этого раздела.');
      const heights=match.words.filter(w=>w.confidence>=80).map(w=>(w.glyphs||[]).filter(g=>Number.isFinite(g.height)&&g.height>0&&/\p{L}/u.test(g.text)).map(g=>g.height).sort((a,b)=>a-b)).filter(h=>h.length>=2).map(h=>h[Math.floor(h.length/2)]);
      if(!heights.length)return note('Нет надёжного замера видимых символов; нужен PDF с физическим масштабом.');
      measurementNotes.push('');
      return Math.min(...heights);
    });
    const measurementMeta=dimensionChecks(rule,margin).map((d,i)=>{
      if(!Number.isFinite(dimensions[i]))return null;
      if(d.unit==='%')return {method:'rectangle',textBox:{x:Math.min(...boxes.map(b=>b.x)),y:Math.min(...boxes.map(b=>b.y)),w:Math.max(...boxes.map(b=>b.x+b.w))-Math.min(...boxes.map(b=>b.x)),h:Math.max(...boxes.map(b=>b.y+b.h))-Math.min(...boxes.map(b=>b.y))},labelBox:label};
      const measured=(['quantity','quantity_label'].includes(d.target)?[...(caption?.words||[]),...(quantity?.words||[])]:match.words).filter(w=>(w.confidence??0)>=80&&w.glyphs?.some(g=>Number.isFinite(g.height)));
      const steps=measured.map(w=>Math.max(w.sourcePixelMm||0,w.mmPerPixel||0)).filter(n=>Number.isFinite(n)&&n>0);
      return {method:'raster-glyphs',pixelStep:steps.length?Math.max(...steps):null,symbols:measured.reduce((n,w)=>n+w.glyphs.filter(g=>Number.isFinite(g.height)).length,0)};
    });
    return [rule.id,{...match,scope:scoped?'label':'page',boxes,dimensions,measurementNotes,measurementMeta,quantity,date}];
  }));
}
