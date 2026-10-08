// Physical scale of an artwork file. A PDF carries it in its geometry. A JPG or
// PNG states at most a resolution, which may be a default written by any
// editor, so it is trusted only when a second, unrelated fact agrees with it:
// the label size printed in the order table against the measured contour.

const u16=(bytes,at,little)=>little?bytes[at]|bytes[at+1]<<8:bytes[at]<<8|bytes[at+1];
const u32=(bytes,at,little)=>(little?bytes[at]|bytes[at+1]<<8|bytes[at+2]<<16|bytes[at+3]<<24:bytes[at]<<24|bytes[at+1]<<16|bytes[at+2]<<8|bytes[at+3])>>>0;

// Resolution recorded in the file, in pixels per inch, or null.
export function imageDensity(bytes){
 if(!bytes||bytes.length<24)return null;
 const valid=(x,y)=>x>=30&&x<=4800&&y>=30&&y<=4800?{x,y}:null;
 if(bytes[0]===0x89&&bytes[1]===0x50){ // PNG: pHYs holds pixels per metre
  for(let at=8;at+12<=bytes.length;){
   const length=u32(bytes,at,false),type=String.fromCharCode(bytes[at+4],bytes[at+5],bytes[at+6],bytes[at+7]);
   if(type==='pHYs'&&bytes[at+16]===1)return valid(u32(bytes,at+8,false)*.0254,u32(bytes,at+12,false)*.0254);
   if(type==='IDAT'||type==='IEND')break;at+=12+length;
  }
  return null;
 }
 if(bytes[0]!==0xFF||bytes[1]!==0xD8)return null;
 let found=null;
 for(let at=2;at+4<=bytes.length&&bytes[at]===0xFF;){
  const marker=bytes[at+1],length=u16(bytes,at+2,false);if(marker===0xDA||length<2)break;
  const body=at+4;
  if(marker===0xE0&&bytes[body]===0x4A&&bytes[body+1]===0x46&&bytes[body+2]===0x49&&bytes[body+3]===0x46){ // JFIF
   const unit=bytes[body+7],x=u16(bytes,body+8,false),y=u16(bytes,body+10,false);
   if(unit===1)found??=valid(x,y);if(unit===2)found??=valid(x*2.54,y*2.54);
  }
  if(marker===0xE1&&bytes[body]===0x45&&bytes[body+1]===0x78&&bytes[body+2]===0x69&&bytes[body+3]===0x66){ // Exif
   const tiff=body+6,little=bytes[tiff]===0x49,ifd=tiff+u32(bytes,tiff+4,little),count=u16(bytes,ifd,little);let x=0,y=0,unit=2;
   const rational=offset=>{const a=tiff+offset,d=u32(bytes,a+4,little);return d?u32(bytes,a,little)/d:0;};
   for(let i=0;i<count&&ifd+2+i*12+12<=bytes.length;i++){
    const entry=ifd+2+i*12,tag=u16(bytes,entry,little);
    if(tag===0x011A)x=rational(u32(bytes,entry+8,little));if(tag===0x011B)y=rational(u32(bytes,entry+8,little));if(tag===0x0128)unit=u16(bytes,entry+8,little);
   }
   // Exif is written by the exporting application and overrides a JFIF default.
   if(x&&y)found=valid(unit===3?x*2.54:x,unit===3?y*2.54:y)||found;
  }
  at+=2+length;
 }
 return found;
}

const near=(a,b,tolerance)=>Math.abs(a-b)<=Math.max(a,b)*tolerance;
// contour: {w,h} of the die-cut in source pixels; declared: [a,b] label sides in mm.
export function resolveScale({density=null,contour=null,declared=null}){
 if(!contour||!declared){
  return {source:null,mmPerPixel:null,level:'none',density,declared,
   reason:!contour?'Контур этикетки не найден: масштаб изображения нечем подтвердить.':density?`В файле указано ${Math.round(density.x)} dpi, но размер этикетки на листе не прочитан: масштаб не подтверждён.`:'В файле нет сведений о разрешении, размер этикетки на листе не прочитан.'};
 }
 const long=Math.max(...declared),short=Math.min(...declared),longPx=Math.max(contour.w,contour.h),shortPx=Math.min(contour.w,contour.h);
 const byLong=long/longPx,byShort=short/shortPx,labelMm=f=>({width:contour.w*f,height:contour.h*f});
 if(density&&near(density.x,density.y,.01)){
  const fromFile=25.4/density.x;
  // Two unrelated sources agree: the resolution written in the file and the
  // label size stated on the sheet, measured against the found contour.
  if(near(fromFile,byLong,.02)&&near(fromFile,byShort,.03))return {source:'density+declared',mmPerPixel:fromFile,level:'high',density,declared,label:labelMm(fromFile)};
 }
 // The stated size alone still fixes a scale when both sides give the same one.
 if(near(byLong,byShort,.03)){const f=(byLong+byShort)/2;return {source:'declared',mmPerPixel:f,level:'medium',density,declared,label:labelMm(f)};}
 return {source:null,mmPerPixel:null,level:'none',density,declared,reason:`Найденный контур не соответствует заявленному размеру этикетки ${declared.join(' × ')} мм: масштаб не определён.`};
}

// "Размер этикетки: 60.00x80.00" or "РАЗМЕР ГОТОВОЙ ПРОДУКЦИИ (ШИРИНА/ВЫСОТА, ММ): 103x54".
// `lines` are OCR lines of the sheet with normalized boxes, or plain text. The
// value is the W×H written closest to the right of or below its caption.
const sizeToken=/(?<![\d.,])(\d{2,3}(?:[.,]\d{1,2})?)\s*[xх×*]\s*(\d{2,3}(?:[.,]\d{1,2})?)(?![\d.,]*\d)/iu;
export function declaredLabelSize(lines){
 const number=text=>Number(text.replace(',','.')),sides=match=>{const pair=[number(match[1]),number(match[2])];return pair.every(n=>n>=8&&n<=600)?pair:null;};
 if(typeof lines==='string'){const match=lines.replace(/\s+/g,' ').match(new RegExp('размер[^\\d]{0,80}?(?:этикетк|продукци|издели)[^\\d]{0,80}?'+sizeToken.source,'iu'));return match?sides(match):null;}
 const captions=lines.filter(line=>/размер/iu.test(line.text)&&/этикетк|продукци|издели/iu.test(line.text)),values=lines.map(line=>({line,match:line.text.match(sizeToken)})).filter(item=>item.match&&sides(item.match));
 let best=null;
 for(const caption of captions)for(const value of values){
  const c=caption.box,v=value.line.box,sameLine=value.line===caption;
  const right=v.x>=c.x+c.w-.01&&Math.abs(v.y+v.h/2-c.y-c.h/2)<Math.max(c.h,v.h)*1.2,below=v.y>=c.y+c.h-.004&&v.y-c.y-c.h<.06&&v.x<c.x+c.w&&v.x+v.w>c.x-.02;
  if(!sameLine&&!right&&!below)continue;
  const distance=sameLine?0:right?v.x-c.x-c.w:.2+v.y-c.y-c.h;
  if(distance<.35&&(!best||distance<best.distance))best={distance,pair:sides(value.match)};
 }
 return best?.pair||null;
}
