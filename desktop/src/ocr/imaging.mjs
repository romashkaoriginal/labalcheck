// Pixel work of the local OCR process. Plain typed arrays: the process has no
// Canvas and no DOM, so nothing here depends on a browser.

// Planar float image in the channel order and normalisation PaddleOCR models
// were trained with (BGR; the mean and std are applied in that same order).
export function toTensor({data,width,height},outWidth,outHeight,mean,std){
 const plane=outWidth*outHeight,out=new Float32Array(plane*3),sx=width/outWidth,sy=height/outHeight;
 for(let y=0;y<outHeight;y++){
  const fy=Math.min(height-1,Math.max(0,(y+.5)*sy-.5)),y0=Math.floor(fy),y1=Math.min(height-1,y0+1),wy=fy-y0;
  for(let x=0;x<outWidth;x++){
   const fx=Math.min(width-1,Math.max(0,(x+.5)*sx-.5)),x0=Math.floor(fx),x1=Math.min(width-1,x0+1),wx=fx-x0;
   const a=(y0*width+x0)*4,b=(y0*width+x1)*4,c=(y1*width+x0)*4,d=(y1*width+x1)*4,at=y*outWidth+x;
   for(let channel=0;channel<3;channel++){
    const k=2-channel; // B, G, R
    const value=(data[a+k]*(1-wx)+data[b+k]*wx)*(1-wy)+(data[c+k]*(1-wx)+data[d+k]*wx)*wy;
    out[channel*plane+at]=(value/255-mean[channel])/std[channel];
   }
  }
 }
 return out;
}

// The image turned a quarter clockwise: pixel (x,y) goes to (height-1-y, x),
// so print running up the sheet lies left to right.
export function quarterTurn({data,width,height}){
 const out=new Uint8ClampedArray(data.length),from=new Uint32Array(data.buffer,data.byteOffset,width*height),to=new Uint32Array(out.buffer);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)to[x*height+(height-1-y)]=from[y*width+x];
 return {data:out,width:height,height:width};
}

// Size of a line once it is turned `rotation` degrees clockwise to be read
// (the convention of the web version: 90 reads bottom-to-top print, 270
// top-to-bottom).
export function uprightSize(box,rotation){
 const w=box.x1-box.x0,h=box.y1-box.y0;return rotation%180?{width:h,height:w}:{width:w,height:h};
}
// Where pixel (u,v) of the upright line image lies on the page.
function source(box,rotation,u,v){
 if(rotation===90)return [box.x0+v,box.y1-1-u];
 if(rotation===180)return [box.x1-1-u,box.y1-1-v];
 if(rotation===270)return [box.x1-1-v,box.y0+u];
 return [box.x0+u,box.y0+v];
}

// One text line cut from the page, turned upright and brought to the height
// the recognition model reads, written into a batch tensor as normalised BGR.
// Reducing a large line averages the pixels it covers; enlarging a small one
// interpolates and adds no detail. `columnAt` says which column of the line
// stands at a column of the output, when the line is not simply scaled
// (widened for narrow type, wide gaps closed up).
export function lineTensor(image,box,rotation,targetHeight,targetWidth,out,offset,rowWidth,columnAt=null){
 const {data,width,height}=image,size=uprightSize(box,rotation),scale=size.height/targetHeight,plane=targetHeight*rowWidth;
 const taps=Math.max(1,Math.min(4,Math.round(scale)));
 for(let y=0;y<targetHeight;y++)for(let x=0;x<targetWidth;x++){
  let b=0,g=0,r=0;
  for(let j=0;j<taps;j++)for(let i=0;i<taps;i++){
   const across=x+(i+.5)/taps,[px,py]=source(box,rotation,(columnAt?columnAt(across):across*scale)-.5,(y+(j+.5)/taps)*scale-.5);
   const fx=Math.min(width-1,Math.max(0,px)),fy=Math.min(height-1,Math.max(0,py)),x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),wx=fx-x0,wy=fy-y0;
   const p=(y0*width+x0)*4,q=(y0*width+x1)*4,s=(y1*width+x0)*4,t=(y1*width+x1)*4;
   r+=(data[p]*(1-wx)+data[q]*wx)*(1-wy)+(data[s]*(1-wx)+data[t]*wx)*wy;
   g+=(data[p+1]*(1-wx)+data[q+1]*wx)*(1-wy)+(data[s+1]*(1-wx)+data[t+1]*wx)*wy;
   b+=(data[p+2]*(1-wx)+data[q+2]*wx)*(1-wy)+(data[s+2]*(1-wx)+data[t+2]*wx)*wy;
  }
  const n=taps*taps*255,at=offset+y*rowWidth+x;
  out[at]=(b/n-.5)/.5;out[at+plane]=(g/n-.5)/.5;out[at+plane*2]=(r/n-.5)/.5;
 }
}

// A justified line has gaps a recogniser takes for the end of the line, and a
// lone letter after such a gap is then lost (the web version closes them up
// for its second engine for the same reason). Columns of the upright line
// that hold print are found against the line's own background, and every
// blank run longer than a word space is cut down to a word space. No print is
// moved or changed: `pieces` says which columns of the line stand where.
export function lineLayout(image,box,rotation){
 const {data,width:pageWidth,height:pageHeight}=image,size=uprightSize(box,rotation),width=Math.max(1,Math.round(size.width)),height=Math.max(1,Math.round(size.height));
 const light=new Uint8Array(width*height),histogram=new Uint32Array(16);
 for(let v=0;v<height;v++)for(let u=0;u<width;u++){
  const [px,py]=source(box,rotation,u,v),x=Math.min(pageWidth-1,Math.max(0,Math.round(px))),y=Math.min(pageHeight-1,Math.max(0,Math.round(py))),p=(y*pageWidth+x)*4,value=(data[p]*77+data[p+1]*150+data[p+2]*29)>>8;
  light[v*width+u]=value;histogram[value>>4]++;
 }
 let ground=0;for(let i=1;i<16;i++)if(histogram[i]>histogram[ground])ground=i;
 const paper=ground*16+8,inked=new Uint8Array(width);
 for(let u=0;u<width;u++)for(let v=0;v<height;v++)if(Math.abs(light[v*width+u]-paper)>56){inked[u]=1;break;}
 const space=Math.max(4,Math.round(height*.45)),pieces=[];let from=0,at=0,blank=0;
 for(let u=0;u<=width;u++){
  if(u<width&&!inked[u]){blank++;continue;}
  if(blank>space){const end=u-blank+space;pieces.push({from,to:end,at});at+=end-from;from=u;}
  blank=0;
 }
 if(from<width)pieces.push({from,to:width,at});
 const last=pieces.at(-1),length=last?last.at+last.to-last.from:width;
 // Column of the line that stands at `position` of the closed-up line.
 const columnAt=position=>{let piece=pieces[0];for(const item of pieces){if(item.at>position)break;piece=item;}return piece?Math.min(piece.to,piece.from+position-piece.at):position;};
 return {length,width,columnAt};
}

// A lone letter at the end of a justified line ("… ДЕТЯМ          И") stands so
// far from the rest that the detector leaves it out. Each wide box is looked
// at along its own row: print of a letter's width and of the line's own ink
// colour (not a hairline or a coloured frame, not a large neighbouring
// inscription), standing within three letter heights of the box on paper no
// other box covers, is taken into the box.
export function extendLines(image,boxes){
 const {data,width,height}=image,light=(x,y)=>{const p=(y*width+x)*4;return (data[p]*77+data[p+1]*150+data[p+2]*29)>>8;};
 return boxes.map(box=>{
  const w=box.x1-box.x0,h=box.y1-box.y0;if(w<h*1.5||h<6)return box;
  const top=Math.round(box.y0+h*.2),bottom=Math.max(top+1,Math.round(box.y1-h*.2)),histogram=new Uint32Array(16);
  for(let y=top;y<bottom;y+=2)for(let x=box.x0;x<box.x1;x+=2)histogram[light(x,y)>>4]++;
  let ground=0;for(let i=1;i<16;i++)if(histogram[i]>histogram[ground])ground=i;
  const paper=ground*16+8,inked=x=>{for(let y=top;y<bottom;y++)if(Math.abs(light(x,y)-paper)>56)return true;return false;};
  // Mean colour of the print between two columns.
  const ink=(from,to)=>{let r=0,g=0,b=0,n=0;for(let x=from;x<to;x++)for(let y=top;y<bottom;y++)if(Math.abs(light(x,y)-paper)>56){const p=(y*width+x)*4;r+=data[p];g+=data[p+1];b+=data[p+2];n++;}return n?[r/n,g/n,b/n]:null;};
  const own=ink(box.x0,box.x1);
  const taken=x=>boxes.some(other=>other!==box&&x>=other.x0&&x<other.x1&&Math.min(other.y1,bottom)-Math.max(other.y0,top)>(bottom-top)*.5);
  const reach=step=>{
   let x=step>0?box.x1:box.x0-1,blank=0,from=-1,to=-1;
   for(;x>=0&&x<width&&blank<=h*3&&!taken(x);x+=step){
    if(inked(x)){if(from<0)from=x;to=x;blank=0;}
    else if(from>=0)break; // the first run of print ends here
    else blank++;
   }
   const run=from<0?0:Math.abs(to-from)+1;
   if(run<h*.25||run>h*1.2||!own)return null;
   const other=ink(Math.min(from,to),Math.max(from,to)+1);
   return other&&Math.hypot(other[0]-own[0],other[1]-own[1],other[2]-own[2])<60?to:null;
  };
  const right=reach(1),left=reach(-1);
  return right==null&&left==null?box:{...box,x0:left==null?box.x0:Math.max(0,left-2),x1:right==null?box.x1:Math.min(width,right+3)};
 });
}

// Connected regions of a thresholded probability map as upright boxes with
// the mean probability inside each: the "DB" post-processing of PaddleOCR,
// with the minimum-area rectangle replaced by the upright one, since label
// print runs along the sides of the sheet.
export function regions(map,width,height,threshold){
 const seen=new Uint8Array(width*height),stack=new Int32Array(width*height),found=[];
 for(let start=0;start<width*height;start++){
  if(seen[start]||!(map[start]>threshold))continue;
  let top=0,x0=width,y0=height,x1=0,y1=0,sum=0,count=0;stack[top++]=start;seen[start]=1;
  while(top){
   const at=stack[--top],x=at%width,y=(at-x)/width;sum+=map[at];count++;
   if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height)continue;
    const next=ny*width+nx;if(seen[next]||!(map[next]>threshold))continue;seen[next]=1;stack[top++]=next;
   }
  }
  found.push({x0,y0,x1:x1+1,y1:y1+1,score:sum/count,pixels:count});
 }
 return found;
}
