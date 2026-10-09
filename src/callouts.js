import {dimensionChecks,variantText,words,fold,alike,scopeIndex} from './engine.js';
import {locatePhrase} from './phrase.js';
import {typicalHeight} from './automatic.js';
import {quantities} from './quantity.js';

// Prepress callouts are assertions written on the proof, never measured ink.
// Everything here locates them, reads what they state and finds the inscription
// they point at. No sheet coordinates, product names or callout colours are fixed.
export const PAPER=0,DARK=1,CHROMA=2;

// Hue is kept per pixel so a callout is isolated by its own colour instead of a
// fixed pink band: magenta, red or blue proof marks are handled alike.
export function classifyInk({data,width,height}){
 const cls=new Uint8Array(width*height),hue=new Uint8Array(width*height);
 for(let i=0,p=0;p<cls.length;i+=4,p++){
  const r=data[i],g=data[i+1],b=data[i+2],max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
  if(d<70||max<110){if(max<140&&d<75)cls[p]=DARK;continue;}
  const h=max===r?((g-b)/d+6)%6:max===g?(b-r)/d+2:(r-g)/d+4;
  cls[p]=CHROMA;hue[p]=Math.round(h*30)%180;
 }
 return {cls,hue,width,height};
}
const hueGap=(a,b)=>{const d=Math.abs(a-b)%180;return Math.min(d,180-d);};
const HUE_TOLERANCE=14; // 28° on the colour wheel

function components({cls,hue,width,height},value,x0=0,y0=0,x1=width,y1=height){
 const w=x1-x0,h=y1-y0,seen=new Uint8Array(w*h),stack=new Int32Array(w*h),out=[];
 for(let sy=0;sy<h;sy++)for(let sx=0;sx<w;sx++){
  const start=sy*w+sx;if(seen[start]||cls[(sy+y0)*width+sx+x0]!==value)continue;
  let top=0,bx0=sx,bx1=sx,by0=sy,by1=sy,area=0,hs=0,hc=0;stack[top++]=start;seen[start]=1;
  while(top){
   const n=stack[--top],x=n%w,y=(n-x)/w;area++;
   if(x<bx0)bx0=x;if(x>bx1)bx1=x;if(y<by0)by0=y;if(y>by1)by1=y;
   if(value===CHROMA){const a=hue[(y+y0)*width+x+x0]*Math.PI/90;hs+=Math.sin(a);hc+=Math.cos(a);}
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;
    const k=yy*w+xx;if(seen[k]||cls[(yy+y0)*width+xx+x0]!==value)continue;seen[k]=1;stack[top++]=k;
   }
  }
  out.push({x0:bx0+x0,y0:by0+y0,x1:bx1+x0+1,y1:by1+y0+1,area,hue:value===CHROMA?(Math.atan2(hs,hc)*90/Math.PI+180)%180:0});
 }
 return out;
}
// A stroke crossing a shape from edge to edge, thinner than any letter stem.
function hairline({cls,width},c,value=CHROMA){
 for(const horizontal of [true,false]){
  const length=horizontal?c.x1-c.x0:c.y1-c.y0,depth=horizontal?c.y1-c.y0:c.x1-c.x0;let thick=0,best=0;
  for(let b=0;b<depth;b++){
   let run=0,longest=0;
   for(let a=0;a<length;a++){const x=horizontal?c.x0+a:c.x0+b,y=horizontal?c.y0+b:c.y0+a;run=cls[y*width+x]===value?run+1:0;if(run>longest)longest=run;}
   if(longest>=length*.8){thick++;if(thick>best)best=thick;}else thick=0;
  }
  if(best&&best<=Math.max(1,length*.07)&&depth>best*2)return true;
 }
 return false;
}
// A straight stroke from corner to corner of a shape: ink all along one of
// its diagonals. A digit drawn with thin strokes has as little ink, but not there.
function slanted({cls,width,height},c,value=CHROMA){
 const w=c.x1-c.x0-1,h=c.y1-c.y0-1,inked=(x,y)=>{for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const xx=Math.round(x)+dx,yy=Math.round(y)+dy;if(xx>=0&&yy>=0&&xx<width&&yy<height&&cls[yy*width+xx]===value)return true;}return false;};
 return [false,true].some(rising=>[.1,.3,.5,.7,.9].every(t=>inked(c.x0+w*t,rising?c.y1-1-h*t:c.y0+h*t)));
}
const span=(a,axis)=>axis==='x'?a.x1-a.x0:a.y1-a.y0;
const gapOn=(a,b,axis)=>axis==='x'?Math.max(0,a.x0-b.x1,b.x0-a.x1):Math.max(0,a.y0-b.y1,b.y0-a.y1);
const overlapOn=(a,b,axis)=>axis==='x'?Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0):Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0);
const boxGap=(a,b)=>Math.hypot(gapOn(a,b,'x'),gapOn(a,b,'y'));
const union=boxes=>({x0:Math.min(...boxes.map(b=>b.x0)),y0:Math.min(...boxes.map(b=>b.y0)),x1:Math.max(...boxes.map(b=>b.x1)),y1:Math.max(...boxes.map(b=>b.y1))});
const median=values=>{const s=[...values].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:0;};

// Glyphs of one callout sit on one line. Lines are grown separately for
// horizontal and quarter-turned text, so two callouts written side by side in
// different directions never merge into one reading.
// `dark`: callouts written in the black of the text itself. They cannot be told
// from text by colour, so only short lines that stand alone and have a thin
// stroke of the same ink beside them (ticks, a leader line) are offered; what
// they say decides later whether they are size statements at all.
export function findCalloutClusters(ink,{avoid=[],dark=false}={}){
 const {width,height}=ink,unit=Math.max(width,height)/1000,maxGlyph=22*unit,value=dark?DARK:CHROMA,strokes=[];
 const glyphs=components(ink,value).filter(c=>{
  const w=c.x1-c.x0,h=c.y1-c.y0,long=Math.max(w,h),short=Math.min(w,h);
  if(c.area<2)return false;
  // Leader lines and dashes are thin and long; they are pointers, not digits.
  if(short<=Math.max(2,unit)&&long>=6*short&&long>=4*unit){strokes.push(c);return false;}
  // So is a dimension tick with its arrow: a hairline spanning a mostly empty shape.
  if(long>=6*unit&&c.area<w*h*.22&&hairline(ink,c,value)){strokes.push(c);return false;}
  // Larger than any sign of a callout. A leader drawn at an angle is such a
  // shape: little ink, all of it along the diagonal of its box.
  if(long>maxGlyph){if(c.area<=Math.hypot(w,h)*Math.max(3,unit*1.5)*1.6&&slanted(ink,c,value))strokes.push(c);return false;}
  const cx=(c.x0+c.x1)/2/width,cy=(c.y0+c.y1)/2/height;
  return !avoid.some(b=>cx>=b.x&&cx<=b.x+b.w&&cy>=b.y&&cy<=b.y+b.h);
 });
 const cell=Math.max(8,Math.ceil(maxGlyph)),grid=new Map();
 glyphs.forEach((c,i)=>{for(let gx=Math.floor(c.x0/cell);gx<=Math.floor(c.x1/cell);gx++)for(let gy=Math.floor(c.y0/cell);gy<=Math.floor(c.y1/cell);gy++){const key=gx+':'+gy;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(i);}});
 const near=i=>{const c=glyphs[i],found=new Set();for(let gx=Math.floor(c.x0/cell)-1;gx<=Math.floor(c.x1/cell)+1;gx++)for(let gy=Math.floor(c.y0/cell)-1;gy<=Math.floor(c.y1/cell)+1;gy++)for(const j of grid.get(gx+':'+gy)||[])if(j!==i)found.add(j);return found;};
 const lines=axis=>{
  const across=axis==='x'?'y':'x',parent=glyphs.map((_,i)=>i),find=i=>parent[i]===i?i:parent[i]=find(parent[i]),marks=[];
  glyphs.forEach((a,i)=>{
   let host=null;
   for(const j of near(i)){
    const b=glyphs[j];if(hueGap(a.hue,b.hue)>HUE_TOLERANCE)continue;
    const size=Math.max(span(a,across),span(b,across)),small=Math.min(span(a,across),span(b,across)),shared=overlapOn(a,b,across),gap=gapOn(a,b,axis);
    if(shared<=0||gap>size*.8)continue;
    // Letters of one line overlap across it.
    if(small>size*.5){if(j>i&&shared>=small*.5)parent[find(i)]=find(j);continue;}
    // A decimal comma is small and hangs below the baseline, sometimes into
    // the next line. It joins only the one letter that holds most of it.
    // A mark lying wholly within a letter's extent (a point, an asterisk) is
    // its neighbour; one that only reaches into it must hang from above, as a
    // comma does in upright text, and not rise from the line below.
    if(span(a,across)<span(b,across)&&(shared>=small*.9||shared>=small*.3&&(axis==='y'||a.y0+a.y1>b.y0+b.y1))){const score=shared/small-gap/size*.1;if(!host||score>host.score)host={j,score};}
   }
   if(host)marks.push([i,host.j]);
  });
  for(const [i,j] of marks)parent[find(i)]=find(j);
  const groups=new Map();glyphs.forEach((_,i)=>{const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(i);});
  return [...groups.values()];
 };
 const candidates=[...lines('x').map(items=>({items,vertical:false})),...lines('y').map(items=>({items,vertical:true}))].sort((a,b)=>b.items.length-a.items.length);
 const taken=new Set(),clusters=[],pairs=[];
 for(const candidate of candidates){
  const items=candidate.items.filter(i=>!taken.has(i));if(items.length===2)pairs.push({items,vertical:candidate.vertical});if(items.length<3)continue;
  const parts=items.map(i=>glyphs[i]),box=union(parts),along=candidate.vertical?box.y1-box.y0:box.x1-box.x0,acrossSize=candidate.vertical?box.x1-box.x0:box.y1-box.y0;
  if(along<acrossSize*1.6||acrossSize<5||items.length>110)continue;
  items.forEach(i=>taken.add(i));
  const sizes=parts.map(c=>candidate.vertical?c.x1-c.x0:c.y1-c.y0).sort((a,b)=>a-b);
  let hs=0,hc=0;for(const c of parts){hs+=Math.sin(c.hue*Math.PI/90)*c.area;hc+=Math.cos(c.hue*Math.PI/90)*c.area;}
  clusters.push({...box,vertical:candidate.vertical,glyphs:parts,count:parts.length,size:sizes[Math.floor(sizes.length*.75)],hue:(Math.atan2(hs,hc)*90/Math.PI+180)%180,...(dark?{dark:true}:{})});
 }
 // Two signs alone are no statement, but they may be its second line ("mm"
 // under the number): a pair right under or over a line of the same ink and size.
 for(const pair of pairs){
  if(pair.items.some(i=>taken.has(i)))continue;
  const parts=pair.items.map(i=>glyphs[i]),box=union(parts),across=pair.vertical?'x':'y',along=pair.vertical?'y':'x',size=Math.max(...parts.map(c=>span(c,across)));
  let hs=0,hc=0;for(const c of parts){hs+=Math.sin(c.hue*Math.PI/90)*c.area;hc+=Math.cos(c.hue*Math.PI/90)*c.area;}const tone=(Math.atan2(hs,hc)*90/Math.PI+180)%180;
  if(!clusters.some(c=>c.vertical===pair.vertical&&hueGap(c.hue,tone)<=HUE_TOLERANCE&&Math.max(c.size,size)<=Math.min(c.size,size)*1.6&&gapOn(c,box,across)<=Math.max(c.size,size)*1.1&&overlapOn(c,box,along)>=span(box,along)*.4))continue;
  pair.items.forEach(i=>taken.add(i));
  clusters.push({...box,vertical:pair.vertical,glyphs:parts,count:2,size,hue:tone,...(dark?{dark:true}:{})});
 }
 // Words of one statement stand on one line with ordinary spaces between them.
 for(let merged=true;merged;){
  merged=false;
  outer:for(let i=0;i<clusters.length;i++)for(let j=i+1;j<clusters.length;j++){
   const a=clusters[i],b=clusters[j];if(a.vertical!==b.vertical||hueGap(a.hue,b.hue)>HUE_TOLERANCE)continue;
   const axis=a.vertical?'y':'x',across=a.vertical?'x':'y',size=Math.max(a.size,b.size);
   if(Math.min(a.size,b.size)<size*.75||overlapOn(a,b,across)<Math.min(span(a,across),span(b,across))*.7||gapOn(a,b,axis)>size*1.6)continue;
   const glyphs=[...a.glyphs,...b.glyphs];clusters[i]={...union([a,b]),vertical:a.vertical,glyphs,count:glyphs.length,size,hue:a.count>=b.count?a.hue:b.hue,...(dark?{dark:true}:{})};clusters.splice(j,1);merged=true;break outer;
  }
 }
 if(dark){
  // A size statement is a few signs long. A line of a paragraph has lines of
  // its own size right above or below it; a statement stands by itself, and
  // a pointer of its own ink is drawn beside it.
  const stacked=(a,b)=>a!==b&&a.vertical===b.vertical&&Math.max(a.size,b.size)<=Math.min(a.size,b.size)*1.5&&gapOn(a,b,a.vertical?'x':'y')<=Math.max(a.size,b.size)*1.1&&overlapOn(a,b,a.vertical?'y':'x')>=Math.min(span(a,a.vertical?'y':'x'),span(b,a.vertical?'y':'x'))*.5;
  return clusters.filter(c=>c.count<=16&&!clusters.some(other=>stacked(c,other)&&other.count>16)&&strokes.some(stroke=>stroke.area/Math.hypot(stroke.x1-stroke.x0,stroke.y1-stroke.y0)<=Math.max(3,c.size*.25)&&boxGap(c,stroke)<=c.size*3)).sort((a,b)=>a.y0-b.y0||a.x0-b.x0);
 }
 return clusters.sort((a,b)=>a.y0-b.y0||a.x0-b.x0);
}

// Dark-on-white crop of one ink kind, turned upright and enlarged for OCR.
// `pixels` is the RGBA of exactly the crop area at source resolution; `tone`
// maps a pixel to 0 (ink) … 255 (paper) and keeps soft edges. `only` limits the
// crop to given boxes so neighbouring ticks never become minus signs.
export function inkCrop({data,width,height},{scale=1,stretch=1,rotation=0,tone,pad=0,only=null}){
 const sx=scale*stretch,sw=Math.max(1,Math.round(width*sx)),sh=Math.max(1,Math.round(height*scale)),gray=new Float32Array(width*height).fill(255);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  if(only&&!only.some(b=>x>=b.x0&&x<b.x1&&y>=b.y0&&y<b.y1))continue;
  const i=(y*width+x)*4;gray[y*width+x]=tone(data[i],data[i+1],data[i+2]);
 }
 const scaled=new Uint8ClampedArray(sw*sh);
 for(let y=0;y<sh;y++){const fy=Math.min(height-1,Math.max(0,(y+.5)/scale-.5)),ya=Math.floor(fy),yb=Math.min(height-1,ya+1),ty=fy-ya;
  for(let x=0;x<sw;x++){const fx=Math.min(width-1,Math.max(0,(x+.5)/sx-.5)),xa=Math.floor(fx),xb=Math.min(width-1,xa+1),tx=fx-xa;
   scaled[y*sw+x]=(gray[ya*width+xa]*(1-tx)+gray[ya*width+xb]*tx)*(1-ty)+(gray[yb*width+xa]*(1-tx)+gray[yb*width+xb]*tx)*ty;}}
 const ow=(rotation%180?sh:sw)+pad*2,oh=(rotation%180?sw:sh)+pad*2,out=new Uint8ClampedArray(ow*oh*4).fill(255);
 for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){
  // Same convention as the page OCR: `rotation` is the clockwise turn that makes the text upright.
  const [tx,ty]=rotation===90?[sh-1-y,x]:rotation===270?[y,sw-1-x]:rotation===180?[sw-1-x,sh-1-y]:[x,y],o=((ty+pad)*ow+tx+pad)*4;
  out[o]=out[o+1]=out[o+2]=scaled[y*sw+x];
 }
 return {data:out,width:ow,height:oh};
}
export const hueTone=hue=>(r,g,b)=>{const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;if(d<45||max<110)return 255;const h=max===r?((g-b)/d+6)%6:max===g?(b-r)/d+2:(r-g)/d+4;return hueGap(Math.round(h*30)%180,hue)<=HUE_TOLERANCE+4?Math.max(0,255-(d-40)*2.2):255;};
export const darkTone=(r,g,b)=>{const max=Math.max(r,g,b);return max-Math.min(r,g,b)>=90?255:Math.max(0,Math.min(255,(max-35)*1.7));};

// ---- reading the statement -------------------------------------------------
const NUMBER='(\\d{1,3}(?:[.,]\\d{1,3})?)';
const MM='(?:mm|мм|тт|rnm|mrn|rnrn|мт|тм)',LETTER=String.raw`\p{L}\p{N}`,SPACE=String.raw`\s*`;
const boxPattern=new RegExp('^[^'+LETTER+']*'+NUMBER+SPACE+MM+'?'+SPACE+'[xх×*]'+SPACE+NUMBER+SPACE+MM+'[^'+LETTER+'²]*$','iu');
// A size callout is nothing but one number and its unit; a number inside a
// sentence ("… 359,9 мм² …") is not a letter height.
const heightPattern=new RegExp('^[^'+LETTER+']*'+NUMBER+SPACE+MM+'[^'+LETTER+'²]*$','iu');
const percentPattern=/([>≥<≤]|не\s+менее|более)?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*%/iu;
const number=text=>Number(String(text).replace(',','.'));
// A decimal mark that OCR dropped turns 0.96 into 096 and 2.56 into 256. Such a
// reading is reported as unreadable instead of becoming a wrong millimetre value.
const plausible=(text,max)=>!/^0\d/.test(text)&&number(text)>0&&number(text)<=max;
const comparator=text=>!text?'=':/[<≤]/.test(text)?'<':/не\s+менее|≥/iu.test(text)?'≥':'>';
export function parseClaim(text){
 const clean=String(text||'').replace(/\s+/g,' ').replace(/(\d)\s*([.,])\s*(?=\d)/g,'$1$2').trim();if(!clean)return null;
 const percent=clean.match(percentPattern);
 if(percent&&/площад|этикетк|(?:^|\s)S(?:\s|$)/iu.test(clean)){
  // The raised 2 of "мм²" comes out of OCR as ?, ", ” or 2.
  const stated=[...clean.matchAll(/(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:мм|mm)\s*[²2*?°"”“'’`]/giu)].map(m=>({value:number(m[1]),bracketed:/\(\s*$/.test(clean.slice(0,m.index))}));
  // "S надписи = A мм² > P % от S этикетки, исключая X (B мм²)": the area of
  // the inscription, the part of the label left out of the base, and in
  // brackets the area that P % of that base amounts to.
  const inscription=stated.find(area=>!area.bracketed),threshold=stated.find(area=>area.bracketed&&area!==inscription);
  const exclusion=clean.match(/исключа\p{L}*\s+([^()\d]{3,60}?)\s*(?:\(|$)/iu)?.[1].trim()||'';
  const formula=inscription||threshold||exclusion?{inscription:inscription?.value??null,threshold:threshold?.value??null,exclusion}:null;
  return {kind:'percent',value:number(percent[2]),comparator:comparator(percent[1]),areas:stated.map(area=>area.value),...(formula?{formula}:{}),raw:clean};
 }
 const box=clean.match(boxPattern);
 if(box)return plausible(box[1],400)&&plausible(box[2],400)?{kind:'box',values:[number(box[1]),number(box[2])],raw:clean}:{kind:'unreadable',raw:clean};
 if(/\d\s*[xх×*]\s*\d/iu.test(clean)&&new RegExp(MM,'iu').test(clean))return {kind:'unreadable',raw:clean};
 const size=clean.match(heightPattern);
 if(size)return plausible(size[1],60)?{kind:'height',value:number(size[1]),raw:clean}:{kind:'unreadable',raw:clean};
 if(percent)return {kind:'percent',value:number(percent[2]),comparator:comparator(percent[1]),areas:[],raw:clean};
 // Digits beside a unit that still do not form a size: the callout exists, its
 // value does not. A sentence that merely contains a digit is no callout at all.
 const wordy=clean.replace(new RegExp(MM,'giu'),'').replace(/[^\p{L}]/gu,'').length>4;
 return !wordy&&/\d/.test(clean)&&new RegExp(MM+'(?!['+LETTER+'])','iu').test(clean)?{kind:'unreadable',raw:clean}:null;
}
// Decimal marks are separate small ink specks on the baseline. Counting them
// checks the OCR number against the pixels without consulting any expected value.
export function separatorCount(cluster){
 const along=cluster.vertical?'y':'x',across=cluster.vertical?'x':'y',big=cluster.size;
 return cluster.glyphs.filter(g=>span(g,across)<=big*.42&&span(g,along)<=big*.42).length;
}
export const claimMarks=claim=>['box','height'].includes(claim?.kind)?(claim.raw.match(/\d[.,]\d/g)||[]).length:0;

// ---- the pointer: dimension ticks or leader lines beside the callout -------
export function strokeSegments(ink,region,hue,blocked,axis,minLength,maxThick,dark=false){
 const {cls,width}=ink,found=[],runs=[],horizontal=axis==='x';
 const a0=horizontal?region.x0:region.y0,a1=horizontal?region.x1:region.y1,b0=horizontal?region.y0:region.x0,b1=horizontal?region.y1:region.x1;
 const on=(a,b)=>{const x=horizontal?a:b,y=horizontal?b:a,p=y*width+x;if(dark?cls[p]!==DARK:cls[p]!==CHROMA||hueGap(ink.hue[p],hue)>HUE_TOLERANCE)return false;return !blocked.some(r=>x>=r.x0&&x<r.x1&&y>=r.y0&&y<r.y1);};
 for(let b=b0;b<b1;b++){let start=-1;for(let a=a0;a<=a1;a++){const inked=a<a1&&on(a,b);if(inked){if(start<0)start=a;}else if(start>=0){if(a-start>=minLength)runs.push({b,a0:start,a1:a});start=-1;}}}
 for(const run of runs){
  const previous=found.find(s=>run.b-s.b1<=1&&Math.min(s.a1,run.a1)-Math.max(s.a0,run.a0)>=Math.min(s.a1-s.a0,run.a1-run.a0)*.6);
  if(previous){previous.b1=run.b+1;previous.a0=Math.min(previous.a0,run.a0);previous.a1=Math.max(previous.a1,run.a1);}
  else found.push({a0:run.a0,a1:run.a1,b0:run.b,b1:run.b+1});
 }
 // A leader line may run far beyond the window it was found in: follow it to
 // its real ends, or the inscription it leads to is never reached.
 const limit=horizontal?width:ink.height,inked=(a,s)=>{for(let b=s.b0;b<s.b1;b++)if(on(a,b))return true;return false;};
 for(const s of found){while(s.a1<limit&&inked(s.a1,s))s.a1++;while(s.a0>0&&inked(s.a0-1,s))s.a0--;}
 const segments=found.filter(s=>s.b1-s.b0<=maxThick).map(s=>horizontal?{x0:s.a0,x1:s.a1,y0:s.b0,y1:s.b1}:{y0:s.a0,y1:s.a1,x0:s.b0,x1:s.b1});
 if(!dark)return segments;
 // In the ink of the text a bar of a letter is a thin run too. A tick or a
 // leader is a shape of its own: thin all over, or a hairline with its arrow.
 const pad=Math.round(maxThick*4),x0=Math.max(0,region.x0-pad),y0=Math.max(0,region.y0-pad),x1=Math.min(width,region.x1+pad),y1=Math.min(ink.height,region.y1+pad),shapes=components(ink,DARK,x0,y0,x1,y1);
 return segments.filter(s=>{const shape=shapes.find(c=>c.x0<=s.x0&&c.x1>=Math.min(s.x1,x1)&&c.y0<=s.y0&&c.y1>=Math.min(s.y1,y1));if(!shape)return false;const w=shape.x1-shape.x0,h=shape.y1-shape.y0;return Math.min(w,h)<=maxThick*1.5||shape.area<w*h*.22&&hairline(ink,shape,DARK);});
}
// Two parallel thin strokes bound the measured glyphs. `type:'height'` strokes
// are horizontal and bound a horizontal line of text; `type:'width'` strokes
// are vertical and bound a symbol or a quarter-turned line.
export function findGauges(ink,clusters){
 const {width,height}=ink,options=[];
 clusters.forEach((cluster,index)=>{
  const s=cluster.size,reach=3*s,region={x0:Math.max(0,Math.floor(cluster.x0-reach)),y0:Math.max(0,Math.floor(cluster.y0-reach)),x1:Math.min(width,Math.ceil(cluster.x1+reach)),y1:Math.min(height,Math.ceil(cluster.y1+reach))};
  const minLength=Math.max(6,Math.round(s*.4)),maxThick=Math.max(3,Math.round(s*.2));
  for(const [type,axis,across] of [['height','x','y'],['width','y','x']]){
   const lines=strokeSegments(ink,region,cluster.hue,clusters,axis,minLength,maxThick,!!cluster.dark);
   for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
    const [first,second]=lines[i][across+'0']<=lines[j][across+'0']?[lines[i],lines[j]]:[lines[j],lines[i]];
    const distance=second[across+'0']-first[across+'1'],shared=overlapOn(first,second,axis);
    // Both ticks of a gauge have the same length and position; an arrow shaft
    // crossing a neighbouring tick does not.
    if(distance<2||distance>7*s||shared<Math.max(span(first,axis),span(second,axis))*.6)continue;
    const box=union([first,second]),gap=boxGap(cluster,box);
    const from=first[across+'1'],to=second[across+'0'],centre=(from+to)/2,middle=(cluster[across+'0']+cluster[across+'1'])/2;
    // Leader lines run out from the callout, which then sits between them: the
    // tightest such pair is its own. Arrowed ticks stand beside rotated text
    // instead: there the nearest pair along the callout is its own.
    const between=middle>=from&&middle<=to,beside=centre>=cluster[across+'0']&&centre<=cluster[across+'1'];
    if(gap>(between||beside?2.5:1.2)*s)continue;
    options.push({index,score:between?distance+gap*.2:beside?7*s+gap:10*s+gap,gauge:{type,from,to,x0:box.x0,y0:box.y0,x1:box.x1,y1:box.y1}});
   }
  }
 });
 // One pair of ticks serves one callout. Segments are clipped by each
 // callout's own search window, so pairs are compared by position, not identity.
 const same=(a,b)=>a.type===b.type&&Math.abs(a.from-b.from)<=3&&Math.abs(a.to-b.to)<=3&&overlapOn(a,b,a.type==='height'?'x':'y')>0;
 const gauges=new Array(clusters.length).fill(null);
 for(const option of options.sort((a,b)=>a.score-b.score)){
  if(gauges[option.index]||gauges.some(taken=>taken&&same(taken,option.gauge)))continue;
  gauges[option.index]=option.gauge;
 }
 return gauges;
}

// ---- the inscription the pointer indicates ---------------------------------
function inkProbe(ink,vertical){
 // `along` runs with the text line, `across` crosses it.
 const {cls,hue,width,height}=ink,limitAlong=vertical?height:width,limitAcross=vertical?width:height;
 const index=(a,c)=>vertical?a*width+c:c*width+a;
 return {limitAlong,limitAcross,
  dark:(a,c0,c1)=>{if(a<0||a>=limitAlong)return 0;let n=0;for(let c=Math.max(0,c0);c<Math.min(limitAcross,c1);c++)if(cls[index(a,c)]===DARK)n++;return n;},
  darkRow:(c,a0,a1)=>{if(c<0||c>=limitAcross)return 0;let n=0;for(let a=Math.max(0,a0);a<Math.min(limitAlong,a1);a++)if(cls[index(a,c)]===DARK)n++;return n;},
  // Unbroken ink leaving the band at one end: how far a taller shape continues.
  reach:(a,c,step,limit)=>{if(a<0||a>=limitAlong||c<0||c>=limitAcross||cls[index(a,c)]!==DARK)return 0;let n=0;for(let at=c+step;at>=0&&at<limitAcross&&n<limit&&cls[index(a,at)]===DARK;at+=step)n++;return n;},
  barrier:(a,c0,c1,tone)=>{if(a<0||a>=limitAlong)return false;for(let c=Math.max(0,c0);c<Math.min(limitAcross,c1);c++){const p=index(a,c);if(cls[p]===CHROMA&&hueGap(hue[p],tone)<=HUE_TOLERANCE)return true;}return false;}};
}
function followLine(probe,start,direction,c0,c1,gapLimit,tone){
 // Walk along the line until whitespace exceeds the limit or another callout
 // (its text or ticks) stands in the way: that ink belongs to a different mark.
 // After a gap wider than a word space the next ink must look like more of the
 // same line: about as tall as the band and not running far beyond it.
 const band=c1-c0,wordGap=Math.max(3,Math.round(band*.6));
 let last=start,empty=0;
 for(let a=start;a>=0&&a<probe.limitAlong;a+=direction){
  if(!probe.dark(a,c0,c1)){if(probe.barrier(a,c0,c1,tone)||++empty>gapLimit)break;continue;}
  if(empty>wordGap){
   let low=c1,high=c0,beyond=0;
   for(let step=0;step<Math.max(3,band*.5);step++){
    const at=a+step*direction;
    for(let c=c0;c<c1;c++)if(probe.dark(at,c,c+1)){if(c<low)low=c;if(c>high)high=c;}
    beyond=Math.max(beyond,probe.reach(at,c0,-1,band),probe.reach(at,c1-1,1,band));
   }
   if(high-low<band*.5||beyond>band*.6)break;
  }
  last=a;empty=0;
 }
 return last;
}
function firstInk(probe,from,direction,c0,c1,reach){
 for(let step=0;step<=reach;step++){const a=from+step*direction;if(a<0||a>=probe.limitAlong)return null;
  if(probe.dark(a,c0,c1)&&(probe.dark(a+direction,c0,c1)||probe.dark(a+2*direction,c0,c1)))return {at:a,gap:step};}
 return null;
}
function lineBox(probe,vertical,hit,direction,c0,c1,gapLimit,tone,limit){
 // A first glyph may begin under the ticks themselves: step back over it too.
 const far=followLine(probe,hit,direction,c0,c1,gapLimit,tone),near=followLine(probe,hit,-direction,c0,c1,Math.max(2,Math.round(gapLimit*.35)),tone),a0=Math.min(near,far),a1=Math.max(near,far)+1;
 let top=c0,bottom=c1;
 while(c0-top<limit&&probe.darkRow(top-1,a0,a1))top--;
 while(bottom-c1<limit&&probe.darkRow(bottom,a0,a1))bottom++;
 return vertical?{x0:top,x1:bottom,y0:a0,y1:a1}:{x0:a0,x1:a1,y0:top,y1:bottom};
}
// How far a line continues cannot be told from spacing alone: justified small
// print has gaps wider than the space between a large "40 %" and the sign next
// to it. Both extents are returned: up to an ordinary word space (`tight`) and
// up to a wide one. Each is read; the caller keeps the reading that makes sense.
function lineBoxes(probe,vertical,hit,direction,c0,c1,wide,tone,limit){
 const band=c1-c0,box=lineBox(probe,vertical,hit,direction,c0,c1,wide,tone,limit),tight=lineBox(probe,vertical,hit,direction,c0,c1,Math.max(3,Math.round(band*.6)),tone,limit);
 const same=['x0','x1','y0','y1'].every(k=>Math.abs(box[k]-tight[k])<=2);
 return {...box,tight:same?null:tight};
}
// A leader line: one thin stroke that starts beside the callout and ends at
// what the callout is about, drawn at any angle. Returns the far end.
export function findLeader(ink,cluster,clusters=[]){
 const {cls,hue,width,height}=ink,s=cluster.size,value=cluster.dark?DARK:CHROMA,reach=Math.round(s*2);
 const x0=Math.max(0,Math.floor(cluster.x0-reach)),y0=Math.max(0,Math.floor(cluster.y0-reach)),x1=Math.min(width,Math.ceil(cluster.x1+reach)),y1=Math.min(height,Math.ceil(cluster.y1+reach));
 const own=(x,y)=>{const p=y*width+x;return cls[p]===value&&(cluster.dark||hueGap(hue[p],cluster.hue)<=HUE_TOLERANCE);};
 // Shapes that begin within reach of the callout are followed to their real
 // extent: a leader runs far beyond the neighbourhood it starts in.
 const seen=new Set();let best=null;
 for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
  if(!own(x,y)||seen.has(y*width+x)||clusters.some(c=>x>=c.x0&&x<c.x1&&y>=c.y0&&y<c.y1))continue;
  const stack=[y*width+x],points=[];seen.add(y*width+x);let bx0=x,bx1=x,by0=y,by1=y;
  while(stack.length&&points.length<200000){
   const p=stack.pop(),px=p%width,py=(p-px)/width;points.push(p);if(px<bx0)bx0=px;if(px>bx1)bx1=px;if(py<by0)by0=py;if(py>by1)by1=py;
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const qx=px+dx,qy=py+dy;if(qx<0||qy<0||qx>=width||qy>=height)continue;const q=qy*width+qx;if(seen.has(q)||!own(qx,qy)||clusters.some(c=>qx>=c.x0&&qx<c.x1&&qy>=c.y0&&qy<c.y1))continue;seen.add(q);stack.push(q);}
  }
  const w=bx1-bx0+1,h=by1-by0+1,length=Math.hypot(w,h);
  // A line: long, and no more ink than a thin stroke along its diagonal.
  if(length<s*2||points.length>length*Math.max(3,s*.3)*1.6)continue;
  // Its two ends are the points furthest apart along its longer side.
  const wide=w>=h,key=p=>wide?p%width:(p-p%width)/width,low=Math.min(...points.map(key)),high=Math.max(...points.map(key));
  const end=at=>{const group=points.filter(p=>Math.abs(key(p)-at)<=1);return {x:group.reduce((n,p)=>n+p%width,0)/group.length,y:group.reduce((n,p)=>n+(p-p%width)/width,0)/group.length};};
  const ends=[end(low),end(high)],away=point=>Math.hypot(Math.max(0,cluster.x0-point.x,point.x-cluster.x1),Math.max(0,cluster.y0-point.y,point.y-cluster.y1));
  ends.sort((a,b)=>away(a)-away(b));
  if(away(ends[0])>s*1.5||away(ends[1])<s*1.5)continue;
  // Drawn from end to end, straight or with one bend: the outline of a panel
  // or of the label has its ends close together and nothing between them.
  const inked=new Set(points),near=(x,y)=>{for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)if(inked.has(Math.round(y+dy)*width+Math.round(x+dx)))return true;return false;};
  if([.25,.5,.75].filter(t=>near(ends[0].x+(ends[1].x-ends[0].x)*t,ends[0].y+(ends[1].y-ends[0].y)*t)).length<2)continue;
  if(!best||away(ends[0])<best.near)best={near:away(ends[0]),tip:ends[1],from:ends[0],length};
 }
 return best;
}
// The line of print a point on the sheet lies at: the nearest letter, and the
// run of letters it stands in.
function lineAt(ink,point,cluster,clusters){
 const s=cluster.size,r=Math.round(s*1.6),x0=Math.max(0,Math.round(point.x-r)),y0=Math.max(0,Math.round(point.y-r)),x1=Math.min(ink.width,Math.round(point.x+r)),y1=Math.min(ink.height,Math.round(point.y+r));
 // In the black of the text the leader itself is dark ink at its own end: a thin stroke is not a letter.
 const thin=c=>{const w=c.x1-c.x0,h=c.y1-c.y0;return Math.max(w,h)>=s&&c.area<=Math.hypot(w,h)*Math.max(3,s*.3)*1.6;};
 const letters=components(ink,DARK,x0,y0,x1,y1).filter(c=>c.area>=4&&!thin(c)&&!clusters.some(other=>c.x0<other.x1&&c.x1>other.x0&&c.y0<other.y1&&c.y1>other.y0));
 if(!letters.length)return null;
 const far=c=>Math.hypot(Math.max(0,c.x0-point.x,point.x-c.x1),Math.max(0,c.y0-point.y,point.y-c.y1)),letter=letters.sort((a,b)=>far(a)-far(b))[0];
 // Upright unless the letters around stand one above another.
 let best=null;
 for(const vertical of [false,true]){
  const probe=inkProbe(ink,vertical),c0=vertical?letter.x0:letter.y0,c1=vertical?letter.x1:letter.y1,band=c1-c0,hit=vertical?letter.y0:letter.x0,wide=Math.max(4,Math.round(band*1.6)),limit=Math.round(band*.25);
  const ahead=lineBox(probe,vertical,hit,1,c0,c1,wide,cluster.hue,limit),back=lineBox(probe,vertical,hit,-1,c0,c1,wide,cluster.hue,limit),box=union([ahead,back]),along=vertical?box.y1-box.y0:box.x1-box.x0;
  if(!best||along>best.along)best={...box,vertical,via:'leader',gap:far(letter),band,along};
 }
 const {along,...target}=best;return target;
}
export function findTarget(ink,cluster,gauge,{mark=false,clusters=[]}={}){
 const s=cluster.size;
 if(gauge){
  // The ticks give the exact band of the measured line; text is beside them.
  const vertical=gauge.type==='width',probe=inkProbe(ink,vertical),band=gauge.to-gauge.from,inset=Math.max(1,Math.round(band*.15)),c0=gauge.from+inset,c1=gauge.to-inset;
  const lo=vertical?gauge.y0:gauge.x0,hi=vertical?gauge.y1:gauge.x1,reach=Math.round(2*band+2*s);
  const centre=vertical?(cluster.y0+cluster.y1)/2:(cluster.x0+cluster.x1)/2,calloutSide=centre>hi?1:centre<lo?-1:0;
  // With ink on both sides the callout itself stands opposite its inscription.
  const pick=[firstInk(probe,hi,1,c0,c1,reach),firstInk(probe,lo-1,-1,c0,c1,reach)].map((hit,i)=>hit&&{...hit,direction:i?-1:1}).filter(Boolean).sort((a,b)=>a.gap+(a.direction===calloutSide?band:0)-b.gap-(b.direction===calloutSide?band:0))[0];
  // Ticks may bound only the shortest glyph of a group (the unit letter of
  // "0,7 л"); taller neighbours are taken whole, up to half the band.
  if(pick)return {...lineBoxes(probe,vertical,pick.at,pick.direction,c0,c1,Math.max(4,Math.round(band*1.6)),cluster.hue,Math.round(band*.5)+inset),vertical,via:'gauge',gap:pick.gap,band};
 }
 // A leader line says more than nearness: what it ends at is the inscription.
 const leader=findLeader(ink,cluster,clusters);
 if(leader){const target=lineAt(ink,leader.tip,cluster,clusters);if(target)return target;}
 // The black of the text cannot tell a callout from the print beside it by
 // colour; without a pointer such a callout is left unlinked.
 if(cluster.dark)return null;
 // No ticks: the callout is written right beside the inscription it sizes.
 // A W×H statement sizes a mark and is often centred above or below it, so
 // that direction is tried before the text that may stand beside the callout.
 for(const vertical of cluster.vertical!==mark?[true,false]:[false,true]){
  const sameAxis=vertical===cluster.vertical,probe=inkProbe(ink,vertical);
  const lo=vertical?cluster.y0:cluster.x0,hi=vertical?cluster.y1:cluster.x1,a=vertical?cluster.x0:cluster.y0,b=vertical?cluster.x1:cluster.y1,mid=(a+b)/2,core=Math.max(1,(b-a)*(sameAxis?.3:.25));
  const c0=Math.round(mid-core),c1=Math.round(mid+core)+1,reach=Math.round(4*s);
  const pick=[firstInk(probe,hi,1,c0,c1,reach),firstInk(probe,lo-1,-1,c0,c1,reach)].map((hit,i)=>hit&&{...hit,direction:i?-1:1}).filter(Boolean).sort((x,y)=>x.gap-y.gap)[0];
  if(!pick)continue;
  // Size the line from the glyphs actually touching the callout's row, so a
  // large inscription beside a small callout is taken whole.
  const reachBack=Math.round(8*s),w0=pick.direction>0?pick.at:pick.at-reachBack,w1=pick.direction>0?pick.at+reachBack:pick.at+1;
  const region=vertical?{x0:Math.max(0,c0-reachBack),x1:Math.min(ink.width,c1+reachBack),y0:Math.max(0,w0),y1:Math.min(ink.height,w1)}:{x0:Math.max(0,w0),x1:Math.min(ink.width,w1),y0:Math.max(0,c0-reachBack),y1:Math.min(ink.height,c1+reachBack)};
  const touching=components(ink,DARK,region.x0,region.y0,region.x1,region.y1).filter(c=>vertical?c.x0<c1&&c.x1>c0:c.y0<c1&&c.y1>c0);
  if(!touching.length)continue;
  const nearest=[...touching].sort((p,q)=>Math.abs((vertical?p.y0:p.x0)-pick.at)-Math.abs((vertical?q.y0:q.x0)-pick.at)).slice(0,Math.max(1,Math.ceil(touching.length/2)));
  if(!sameAxis){
   // Written above or below a mark: take the nearest shape with its equals,
   // not the smaller text that happens to stand in the same columns. A shape
   // partly covered by a callout arrives in pieces and is put together again.
   const all=components(ink,DARK,region.x0,region.y0,region.x1,region.y1),run=vertical?'y':'x',side=vertical?'x':'y',group=[nearest[0]];
   for(let grown=true;grown;){
    grown=false;const longest=Math.max(...group.map(c=>span(c,run))),box=union(group);
    for(const c of all){
     if(group.includes(c)||span(c,run)<longest*.35||span(c,run)>longest*2.5)continue;
     if(overlapOn(c,box,run)>=Math.min(span(c,run),span(box,run))*.5&&gapOn(c,box,side)<=longest*.4){group.push(c);grown=true;}
    }
   }
   const box=union(group);
   return {...box,vertical:true,via:'adjacent',gap:pick.gap,band:Math.min(box.x1-box.x0,box.y1-box.y0)};
  }
  const tall=median(nearest.map(c=>vertical?c.x1-c.x0:c.y1-c.y0)),peers=touching.filter(c=>{const size=vertical?c.x1-c.x0:c.y1-c.y0;return size>=tall*.5&&size<=tall*1.8;});
  const band0=Math.min(...peers.map(c=>vertical?c.x0:c.y0)),band1=Math.max(...peers.map(c=>vertical?c.x1:c.y1)),band=band1-band0;
  return {...lineBoxes(probe,vertical,pick.at,pick.direction,band0,band1,Math.max(4,Math.round(band*1.8)),cluster.hue,Math.round(band*.25)),vertical,via:'adjacent',gap:pick.gap,band};
 }
 return null;
}

// ---- which requirement the inscription belongs to --------------------------
const stop=/^(?:для|при|это|или|его|она|также|только|всех|согласно|менее|более|шрифта|высота|минимальная|указания|должна|надпись)$/u;
const tokens=text=>words(text).filter(token=>/\d/.test(token)||token.length>2&&!stop.test(token));
const bare=text=>fold(String(text||'').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}%]/gu,''));
function checkFor(rule,checks,texts,claim,gauge,sign){
 const pick=test=>{const i=checks.findIndex(test);return i<0?[]:[i];};
 if(claim.kind==='percent')return pick(check=>check.unit==='%');
 const sized=checks.map((check,index)=>({check,index})).filter(item=>item.check.unit==='мм');
 if(!sized.length)return [];
 if(sized.some(item=>/ЕАС/.test(item.check.label))){
  // The sign's minimum applies to the sign, not to captions of the same section.
  if(!sign)return [];
  if(claim.kind==='box')return sized.map(item=>item.index);
  const wanted=gauge?.type==='width'?/Ширина/:/Высота/;return sized.filter(item=>wanted.test(item.check.label)).map(item=>item.index);
 }
 if(claim.kind!=='height')return [];
 if(sized.length===1)return [sized[0].index];
 if(sized.some(item=>item.check.target==='quantity')){
  const caption=texts.some(text=>tokens(rule.title).some(word=>tokens(text).some(token=>alike(token,word)))),amount=texts.some(text=>quantities(text).length>0);
  return sized.filter(item=>item.check.target==='quantity_label'?caption:amount).map(item=>item.index);
 }
 if(sized.some(item=>item.check.target==='date_label')){
  const letters=texts.some(text=>/\p{L}{3,}/u.test(text));return sized.filter(item=>item.check.target===(letters?'date_label':'date_digits')).map(item=>item.index);
 }
 // Several minima for different sentences of one rule.
 const index=texts.map(text=>scopeIndex(checks,text)).find(i=>i>=0)??-1;
 return index>=0&&checks[index].unit==='мм'?[index]:[];
}

// Approximate substring search: how much of `needle` is found, in order,
// somewhere inside `haystack`. Tolerates OCR slips, lost spaces and a changed
// number without relying on whole words.
export function insideSimilarity(needle,haystack){
 const n=needle.length,m=haystack.length;if(!n||!m)return 0;
 let previous=new Uint16Array(m+1),current=new Uint16Array(m+1);
 for(let i=1;i<=n;i++){
  current[0]=i;
  for(let j=1;j<=m;j++)current[j]=Math.min(previous[j-1]+(needle[i-1]===haystack[j-1]?0:1),previous[j]+1,current[j-1]+1);
  [previous,current]=[current,previous];
 }
 let best=n;for(let j=0;j<=m;j++)if(previous[j]<best)best=previous[j];
 return 1-best/n;
}
const needed=length=>length<=5?1:length<=10?.8:.7;

export function linkClaims(readings,rules,volume,margin=false){
 const texts=rules.map(rule=>{const expected=variantText(rule,volume),key=bare(expected);return {rule,expected:tokens(expected),key,letters:key.replace(/\d/g,''),checks:dimensionChecks(rule,margin)};});
 const frequency=new Map();for(const item of texts)for(const token of new Set(item.expected.map(fold)))frequency.set(token,(frequency.get(token)||0)+1);
 const weight=token=>1/(frequency.get(fold(token))||1);
 const signs=texts.filter(item=>item.checks.some(check=>/ЕАС/.test(check.label)));
 // Rules that one reading of the inscription belongs to.
 const rulesFor=candidate=>{
  const line=tokens(candidate),key=bare(candidate),letters=key.replace(/\d/g,''),lineWeight=line.reduce((n,token)=>n+weight(token),0),inside=[],links=[];
  // Two or three bare digits occur in any long text; they identify nothing.
  if(key.length<3||/^\d{1,4}$/.test(key))return {links,tied:false};
  for(const item of texts){
   if(!item.key)continue;
   // The inscription is a piece of this rule's text; a changed number in an
   // otherwise identical caption still identifies the rule ...
   const part=Math.max(insideSimilarity(key,item.key),letters.length>=5?insideSimilarity(letters,item.letters)*.95:0),hit=line.filter(token=>item.expected.some(word=>alike(token,word)));
   const share=lineWeight?hit.reduce((n,token)=>n+weight(token),0)/lineWeight:0,worded=share>=.5&&hit.length>=2;
   if(part>=needed(key.length)||worded){inside.push({ruleId:item.rule.id,item,share:Math.max(part,worded?share*.9:0),whole:0,cover:Math.min(1,key.length/item.key.length)});continue;}
   // ... or the rule's whole short text stands inside a longer line shared with other rules.
   const whole=item.key.length>=4&&item.key.length<key.length?insideSimilarity(item.key,key):0;
   if(whole>=needed(item.key.length)+.05)links.push({ruleId:item.rule.id,item,share:0,whole,cover:1});
  }
  inside.sort((a,b)=>b.share-a.share);
  // One line belongs to one rule; a near tie is left to the specialist.
  if(inside.length&&(inside.length===1||inside[0].share-inside[1].share>=.08))links.unshift(inside[0]);
  return {links,tied:inside.length>1&&!links.length};
 };
 return readings.map(reading=>{
  const claim=reading.claim,base={...reading,links:[],level:'none'};
  if(!claim||claim.kind==='unreadable')return {...base,reason:'Выноска найдена, но число в ней не прочитано уверенно.'};
  // OCR of a short or condensed sample varies with its settings. Every reading
  // is tried; this only identifies the sample, it never confirms label text.
  const variants=(reading.targetReadings?.length?reading.targetReadings:[{text:reading.targetText||'',confidence:reading.targetConfidence||0}]).filter(variant=>bare(variant.text).length>=2).sort((a,b)=>b.confidence-a.confidence);
  let shown=variants[0]?.text||'',links=[],tied=false;
  if(claim.kind!=='percent')for(const variant of variants){
   const found=rulesFor(variant.text);tied||=found.tied;
   const better=found.links.length&&(!links.length||found.links[0].share+found.links[0].whole>links[0].share+links[0].whole+.02);
   // Equally good readings: the longer one shows more of the inscription.
   const fuller=found.links.length&&links.length&&found.links[0].ruleId===links[0].ruleId&&Math.abs(found.links[0].share+found.links[0].whole-links[0].share-links[0].whole)<=.02&&found.links.length>=links.length&&bare(variant.text).length>bare(shown).length;
   if(better||fuller){links=found.links;shown=variant.text;}
  }
  // A statement about label area names its own subject; it needs no neighbour.
  if(claim.kind==='percent'){const area=texts.filter(item=>item.checks.some(check=>check.unit==='%'));if(area.length===1)links=[{ruleId:area[0].rule.id,share:0,whole:0,item:area[0],semantic:true}];}
  if(claim.kind==='box'&&!links.length){
   // A stated W×H equal to a format allowed in Word identifies the print window.
   const same=(a,b)=>Math.abs(a[0]-b[0])<.051&&Math.abs(a[1]-b[1])<.051||Math.abs(a[0]-b[1])<.051&&Math.abs(a[1]-b[0])<.051;
   const formats=texts.filter(item=>[...item.rule.constraint.matchAll(/(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)/giu)].some(m=>same([number(m[1]),number(m[2])],claim.values)));
   if(formats.length===1)links=[{ruleId:formats[0].rule.id,share:0,whole:0,item:formats[0],semantic:true,format:true}];
  }
  // The conformity sign is a square mark of three heavy letters that OCR reads
  // as ЕАС, EAL or ЕНГ. A size pointing at a short square shape is taken for
  // it when Word sets a minimum for exactly one such sign.
  const keys=variants.map(variant=>bare(variant.text)),named=keys.some(key=>key.length===3&&[...key].filter((char,i)=>char==='еас'[i]).length>=2);
  const squareMark=reading.target&&reading.target.aspect>=.7&&reading.target.aspect<=1.45&&keys.filter(key=>key.length<=4).length*2>=keys.length;
  if(!links.length&&['height','box'].includes(claim.kind)&&reading.target&&signs.length===1&&(named||squareMark))links=[{ruleId:signs[0].rule.id,share:named?.67:.5,whole:0,item:signs[0],sign:true}];
  if(links.length&&!links[0].semantic){
   const fuller=variants.filter(variant=>rulesFor(variant.text).links[0]?.ruleId===links[0].ruleId).sort((a,b)=>bare(b.text).length-bare(a.text).length)[0];if(fuller)shown=fuller.text;
   // How much of the rule the inscription covers is judged by its fullest reading.
   for(const entry of links)if(!entry.whole)entry.cover=Math.min(1,bare(shown).length/entry.item.key.length);
  }
  if(!links.length)return {...base,targetText:shown,reason:!reading.target?'Рядом с выноской нет надписи или указателя: к чему она относится, не определено.':tied?'Надпись рядом с выноской встречается в нескольких разделах Word; раздел не выбран.':bare(shown).length>=3?'Надпись рядом с выноской не входит в тексты столбца 3 Word.':'Надпись рядом с выноской не прочитана.'};
  const resolved=links.map(link=>({ruleId:link.ruleId,share:link.share,whole:link.whole,cover:link.cover??1,semantic:!!link.semantic,format:!!link.format,sign:!!link.sign,sized:link.item.checks.filter(check=>check.unit==='мм'&&(link.sign||!/ЕАС/.test(check.label))).length,
   checks:link.format?[]:checkFor(link.item.rule,link.item.checks,[shown,...variants.map(variant=>variant.text).filter(text=>rulesFor(text).links.some(entry=>entry.ruleId===link.ruleId))],claim,reading.gauge,!!link.sign).map(index=>{
    const check=link.item.checks[index],value=claim.kind==='box'?Math.min(...claim.values):claim.value;
    return {index,label:check.label,target:check.target,minimum:check.min,unit:check.unit,value,passes:claim.comparator==='<'?null:value>=check.min};
   })}));
  // Confidence of the association, kept apart from confidence of the number.
  const geometry=['gauge','leader'].includes(reading.target?.via)?2:reading.target?1:0,textual=Math.max(...links.map(link=>link.semantic?.5:Math.max(link.share,link.whole)));
  const numberSure=reading.marksAgree===false?false:reading.confidence>=(reading.marksAgree?70:80)||reading.marksAgree===true&&reading.reads>=2&&reading.confidence>=30;
  const level=!numberSure?'low':links.some(link=>link.semantic||link.sign)?'medium':geometry===2&&textual>=.75?'high':geometry===2&&textual>=.5||geometry===1&&textual>=.6?'medium':'low';
  return {...base,targetText:shown,links:resolved,level,shared:resolved.length>1,
   reason:claim.kind==='percent'?'Доля площади заявлена типографией на техническом листе; способ её расчёта не раскрыт.':resolved.some(link=>link.format)?'Заявленный формат совпадает с одним из допустимых в Word. Сам размер окна на макете не измерен.':resolved.some(link=>link.checks.length)?'Размер указан выноской типографии; фактическая высота печати ею не измерена.':resolved.some(link=>link.sized>1)?'К этому разделу относятся несколько минимумов; к какому из них относится выноска, не определено.':'Раздел найден, но минимальной высоты для этой надписи в Word нет.'};
 });
}

// Finds the callout's inscription among the words of the same rule on the
// printed label. This tells whether the callout speaks for the whole section
// or for one line of it and, where the sheet has a physical scale, whether its
// number agrees with the printed letters. The stated value is never altered.
export function verifyOnLabel(annotations,matches,page={width:1,height:1}){
 // The letter height of a word is its smaller side, whatever turn the pass that read it was made at.
 const extent=word=>Math.min(word.box.w*page.width,word.box.h*page.height);
 for(const item of annotations)for(const link of item.links||[]){
  // A minimum naming its own part of the rule (certain sentences, the amount,
  // the date caption) was matched to that part; the rest has its own minimum.
  const own=link.semantic||link.sign||link.checks.length>0&&link.checks.every(check=>['partitioned_letters','quantity','quantity_label','date_label','date_digits'].includes(check.target));
  link.scope=own?'section':null;link.raster=null;
  const match=matches[link.ruleId];
  if(link.semantic||link.sign||!match?.words?.length||!item.targetText||item.claim.kind!=='height')continue;
  const line=locatePhrase(item.targetText,match.words);
  if(!line||line.coverage<70||line.method==='words')continue;
  const rest=match.words.filter(word=>!line.words.includes(word)&&word.box),size=median(line.words.map(extent)),other=rest.length?median(rest.map(extent)):size;
  if(!own)link.scope=other>=size*.7&&other<=size*1.4?'section':'line';
  const raster=typicalHeight(line.words);
  if(Number.isFinite(raster)){
   const step=Math.max(0,...line.words.map(word=>Math.max(word.sourcePixelMm||0,word.mmPerPixel||0))),value=item.claim.value;
   // Letter shapes, OCR boxes and the raster step all blur the estimate, so
   // only a gross mismatch (a lost decimal mark, a wrong inscription) counts.
   link.raster={value:raster,step,agrees:Math.abs(raster-value)<=Math.max(.25,value*.2,step*3)};
  }
 }
 return annotations;
}

// Declared values enter a requirement only where nothing was measured, and
// only when the callout speaks for the whole section. Several callouts for one
// check are all kept; the smallest decides, as every part of the inscription
// has to satisfy the minimum.
export function applyDeclaredDimensions(matches,annotations){
 const groups=new Map();
 for(const item of annotations)for(const link of item.links||[])for(const check of link.checks){
  const key=`${link.ruleId}:${check.index}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({item,link,check,scope:link.scope||(link.cover>=.5?'section':'line')});
 }
 for(const [key,entries] of groups){
  const [ruleId,indexText]=key.split(':'),index=Number(indexText),match=matches[ruleId];if(!match)continue;
  match.declared??=[];match.dimensions??=[];match.measurementMeta??=[];match.measurementNotes??=[];
  match.declared[index]=entries.map(entry=>({value:entry.check.value,passes:entry.check.passes,level:entry.item.level,nearText:entry.item.targetText,comparator:entry.item.claim.comparator,areas:entry.item.claim.areas,formula:entry.item.claim.formula,scope:entry.scope,shared:entry.item.shared,raster:entry.link.raster,confidence:entry.item.confidence}));
  const usable=entries.filter(entry=>entry.item.level!=='low'&&entry.scope==='section');
  if(Number.isFinite(match.dimensions?.[index])||!usable.length)continue;
  const lowest=usable.sort((a,b)=>a.check.value-b.check.value)[0],values=[...new Set(usable.map(entry=>entry.check.value))];
  match.dimensions[index]=lowest.check.value;
  match.measurementMeta[index]={method:'declared',ocrConfidence:lowest.item.confidence,level:usable.every(entry=>entry.item.level==='high')?'high':'medium',count:usable.length,values,nearText:lowest.item.targetText,comparator:lowest.item.claim.comparator};
  match.measurementNotes[index]=(values.length>1?`На техлисте для этой проверки несколько разных значений (${values.join('; ')} мм); показано наименьшее. `:'')+'Число прочитано с выноски технического листа, а не измерено по буквам.';
 }
 return matches;
}

// Finds and reads every callout of a sheet. OCR and pixel access are supplied
// by the caller, so the same sequence runs in the browser and in tests:
//  crop(box,pad)  → {pixels,x,y}: source-resolution RGBA around an analysis box
//  readLatin(img) → {text,confidence}: digits and units of a size statement
//  readWords(img,mode) → {text,confidence}: the inscription ('line' or 'word')
export async function readCallouts({sheet,scale=1,crop,readLatin,readWords,avoid=[],limit=48,progress=()=>{}}){
 // Coloured callouts first; then short lines in the black of the text that have a pointer beside them.
 const ink=classifyInk(sheet),clusters=[...findCalloutClusters(ink,{avoid}),...findCalloutClusters(ink,{avoid,dark:true}).slice(0,40)],found=[],loose=[];
 const local=(box,source)=>({x0:Math.floor(box.x0/scale)-source.x-2,y0:Math.floor(box.y0/scale)-source.y-2,x1:Math.ceil(box.x1/scale)-source.x+2,y1:Math.ceil(box.y1/scale)-source.y+2});
 for(const [i,cluster] of clusters.entries()){
  if(found.length>=limit)break;progress('callout',i,clusters.length);
  const glyph=cluster.size/scale,source=crop(cluster,Math.ceil(glyph*.3)),only=cluster.glyphs.map(g=>local(g,source)),base=Math.min(6,Math.max(1,46/glyph));
  let best=null;const attempts=[];
  const attempt=async(zoom,rotation,reader,bonus=0)=>{
   const {text,confidence}=await reader(inkCrop(source.pixels,{scale:zoom,rotation,tone:cluster.dark?darkTone:hueTone(cluster.hue),pad:14,only})),claim=parseClaim(text);
   const marksAgree=['box','height'].includes(claim?.kind)?separatorCount(cluster)===claimMarks(claim):undefined;
   // A reading whose decimal marks agree with the ink outranks any other.
   const rank=(!claim?0:claim.kind==='unreadable'?1:marksAgree===false?2:3)*1000+confidence+(claim?.kind==='percent'?bonus:0);
   const entry={text:String(text||'').trim(),claim,confidence,rotation,rank,marksAgree};attempts.push(entry);
   if(!best||rank>best.rank)best=entry;
  };
  for(const rotation of cluster.vertical?[90,270]:[0])await attempt(base,rotation,readLatin);
  // Every size statement contains a digit; plain captions are left alone,
  // unless they turn out to be a line of a statement written on several lines.
  if(!/\d/.test(best.text)){if(/[\p{L}%]/u.test(best.text))loose.push({cluster,...best});continue;}
  // In the black of the text only a plain size statement is a callout.
  if(cluster.dark&&!['height','box'].includes(best.claim?.kind)){loose.push({cluster,...best});continue;}
  const doubtful=()=>!best.claim||best.claim.kind==='unreadable'||best.marksAgree===false||best.confidence<75;
  for(const factor of [.7,1.4])if(doubtful())await attempt(base*factor,best.rotation,readLatin);
  // A statement with words (share of the label area) needs the text model.
  if(doubtful()||cluster.count>10||/[%>]/.test(best.text))await attempt(base,best.rotation,image=>readWords(image,'line'),500);
  if(!best.claim){loose.push({cluster,...best});continue;}
  // Readings at different magnifications that state the same value support each other.
  const stated=claim=>JSON.stringify([claim?.kind,claim?.value,claim?.values]),agreeing=attempts.filter(entry=>entry.claim&&entry.claim.kind!=='unreadable'&&stated(entry.claim)===stated(best.claim));
  const entry={cluster,...best,reads:agreeing.length,confidence:agreeing.length?Math.max(...agreeing.map(attempt=>attempt.confidence)):best.confidence};found.push(entry);
  // A number that did not come out may be one line of a statement written on several.
  if(best.claim.kind==='unreadable')loose.push({cluster,...best,entry});
 }
 // A statement written on two or three lines: lines of one ink, one size and
 // one direction, one under another, that say nothing each by itself and state
 // a size or a share when read together. Lines that are statements by
 // themselves, like two sizes one under another, are never joined.
 {
  const across=c=>c.vertical?'x':'y',along=c=>c.vertical?'y':'x',used=new Set();
  const stacked=(a,b)=>a.vertical===b.vertical&&!!a.dark===!!b.dark&&(a.dark||hueGap(a.hue,b.hue)<=HUE_TOLERANCE)&&Math.max(a.size,b.size)<=Math.min(a.size,b.size)*1.6&&gapOn(a,b,across(a))<=Math.max(a.size,b.size)*1.1&&(overlapOn(a,b,along(a))>=Math.min(span(a,along(a)),span(b,along(a)))*.4);
  for(const first of loose){
   if(used.has(first))continue;const group=[first];
   for(let grown=true;grown&&group.length<4;){grown=false;for(const other of loose)if(!used.has(other)&&!group.includes(other)&&group.some(member=>stacked(member.cluster,other.cluster))){group.push(other);grown=true;break;}}
   if(group.length<2)continue;
   // Reading order: down the page, or across it for quarter-turned lines.
   const turn=first.rotation||0;group.sort((a,b)=>turn===90?a.cluster.x0-b.cluster.x0:turn===270?b.cluster.x0-a.cluster.x0:a.cluster.y0-b.cluster.y0);
   const text=group.map(item=>item.text).join(' '),claim=parseClaim(text);
   if(!claim||claim.kind==='unreadable'||group[0].cluster.dark&&!['height','box'].includes(claim.kind))continue;
   group.forEach(item=>{used.add(item);const at=item.entry?found.indexOf(item.entry):-1;if(at>=0)found.splice(at,1);});
   const glyphs=group.flatMap(item=>item.cluster.glyphs),cluster={...union(group.map(item=>item.cluster)),vertical:first.cluster.vertical,glyphs,count:glyphs.length,size:Math.max(...group.map(item=>item.cluster.size)),hue:first.cluster.hue,lines:group.length,...(first.cluster.dark?{dark:true}:{})};
   const marksAgree=['box','height'].includes(claim.kind)?separatorCount(cluster)===claimMarks(claim):undefined;
   found.push({cluster,text,claim,confidence:Math.min(...group.map(item=>item.confidence)),rotation:turn,marksAgree,reads:1});
  }
 }
 const gauges=findGauges(ink,found.map(item=>item.cluster)),readings=[];
 const share=box=>({x:box.x0/ink.width,y:box.y0/ink.height,w:(box.x1-box.x0)/ink.width,h:(box.y1-box.y0)/ink.height});
 for(const [i,item] of found.entries()){
  progress('target',i,found.length);
  const {cluster,claim}=item,gauge=gauges[i],target=['height','box'].includes(claim.kind)?findTarget(ink,cluster,gauge,{mark:claim.kind==='box',clusters:found.map(entry=>entry.cluster)}):null,targetReadings=[];
  if(target){
   const band=target.band/scale,zoom=Math.min(5,Math.max(1,44/band));
   for(const box of [target.tight,target].filter(Boolean)){
    const source=crop(box,1),along=target.vertical?box.y1-box.y0:box.x1-box.x0,word=along<target.band*4.5;
    // Quarter-turned samples and upright marks both occur beside vertical ticks.
    for(const rotation of target.vertical?[0,90,270]:[0])for(const stretch of rotation?[1]:[1,1.7])for(const mode of word?['line','word']:['line']){
     const {text,confidence}=await readWords(inkCrop(source.pixels,{scale:zoom,stretch,rotation,tone:darkTone,pad:16}),mode);
     if(/[\p{L}\p{N}]/u.test(text||''))targetReadings.push({text:String(text).replace(/\s+/g,' ').trim(),confidence,rotation});
    }
   }
  }
  const shape=target?.tight||target;
  // A callout in the ink of the text is one only if something points from it to an inscription.
  if(cluster.dark&&!target)continue;
  readings.push({box:share(cluster),vertical:cluster.vertical,rotation:item.rotation,...(cluster.dark?{dark:true}:{}),...(cluster.lines?{lines:cluster.lines}:{}),raw:item.text,claim,confidence:item.confidence,marksAgree:item.marksAgree,reads:item.reads,
   gauge:gauge&&{type:gauge.type,span:(gauge.to-gauge.from)/scale},target:target&&{...share(shape),vertical:target.vertical,via:target.via,aspect:(shape.x1-shape.x0)/(shape.y1-shape.y0)},targetReadings});
 }
 return readings;
}

// The share of the warning by the printer's own formula, kept apart from the
// share of rectangles the program measures. What the printer states (areas in
// mm², the excluded part of the label) is one thing; what the raster shows
// (the rectangle around the inscription, the area of the contour) is another.
// Both are returned side by side with what follows from each, and nothing is
// chosen: which method applies is for the specialist to decide.
//   stated    numbers written on the sheet and the share they give
//   measured  the same quantities taken from the raster, where there are any
//   mixed     the measured inscription over the stated base, named as such
export function statedAreaShare(match,index,pageMm){
 const claim=(match?.declared?.[index]||[]).find(item=>item.formula&&item.level!=='low');if(!claim)return null;
 const {inscription,threshold,exclusion}=claim.formula,percent=claim.value,base=threshold&&percent?threshold/(percent/100):null;
 const result={percent,comparator:claim.comparator,exclusion,stated:{inscription,threshold,base,share:inscription&&base?inscription/base*100:null}};
 const meta=match.measurementMeta?.[index];
 if(meta?.method==='rectangle'&&pageMm){
  const area=box=>box.w*pageMm.width*box.h*pageMm.height,text=area(meta.textBox),label=area(meta.labelBox);
  result.measured={inscription:text,label,share:text/label*100};
  if(inscription)result.inscriptionAgrees=Math.abs(text-inscription)<=inscription*.1;
  if(base){result.mixed={share:text/base*100};result.excluded={area:label-base,part:(label-base)/label*100};}
 }
 return result;
}
