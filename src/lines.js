// Text lines of one block of print, each with only the ink that belongs to it.
// Dense small print is set with tight leading beside other inscriptions: a
// rectangular crop of a line also holds commas of the line above, accents of
// the line below and pieces of a neighbouring vertical inscription, and OCR
// reads those as extra signs. Lines are therefore separated by connected ink,
// not by rectangles. Nothing here knows a layout, a product or expected words.

// Ink is the minority tone of the block: dark print on paper, or light print
// on a coloured panel. Saturated proof colours count as paper for dark print.
export function inkTone({data,width,height}){
 const size=width*height,hist=new Uint32Array(256);let dark=0,light=0;
 for(let p=0,i=0;p<size;p++,i+=4){const max=Math.max(data[i],data[i+1],data[i+2]),min=Math.min(data[i],data[i+1],data[i+2]);if(max<140)dark++;if(min>205)light++;}
 // Light print needs a panel around it: most of the block is neither white nor black.
 const reversed=dark<size*.02&&light>size*.03&&light<size*.45;
 const tone=new Uint8Array(size);
 for(let p=0,i=0;p<size;p++,i+=4){const value=reversed?255-Math.min(data[i],data[i+1],data[i+2]):Math.max(data[i],data[i+1],data[i+2]);tone[p]=value;hist[value]++;}
 // Otsu's threshold between ink and its ground.
 let sum=0;for(let v=0;v<256;v++)sum+=v*hist[v];
 let below=0,sumBelow=0,best=-1,threshold=128,inkLevel=0,paperLevel=255;
 for(let v=0;v<255;v++){
  below+=hist[v];if(!below)continue;const above=size-below;if(!above)break;sumBelow+=v*hist[v];
  const a=sumBelow/below,b=(sum-sumBelow)/above,between=below*above*(a-b)**2;
  if(between>best){best=between;threshold=v;inkLevel=a;paperLevel=b;}
 }
 if(paperLevel-inkLevel<45)return null;
 return {tone,threshold:Math.min(200,Math.max(70,threshold)),inkLevel,paperLevel,reversed,width,height};
}

function label(mask,width,height){
 const labels=new Int32Array(width*height),stack=new Int32Array(width*height),boxes=[null];let count=0;
 for(let start=0;start<mask.length;start++){
  if(!mask[start]||labels[start])continue;
  let top=0,x0=width,x1=0,y0=height,y1=0,area=0;stack[top++]=start;labels[start]=++count;
  while(top){
   const p=stack[--top],x=p%width,y=(p-x)/width;area++;
   if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;
   for(let dy=-1;dy<=1;dy++){const yy=y+dy;if(yy<0||yy>=height)continue;
    for(let dx=-1;dx<=1;dx++){const xx=x+dx;if(xx<0||xx>=width)continue;const q=yy*width+xx;if(mask[q]&&!labels[q]){labels[q]=count;stack[top++]=q;}}}
  }
  boxes.push({x0,y0,x1:x1+1,y1:y1+1,area});
 }
 return {labels,boxes};
}

// `pixels` is an upright RGBA block. Returns its lines top to bottom:
//   {top,bottom,left,right}  extent of the line's own ink, in block pixels
//   band:[y0,y1]             rows of the letter bodies
// and `owner`, a map of block pixels to line number + 1 (0: paper, 255: ink of
// no line). `framed` tells that the block was cut with a margin around it, so
// ink touching its border is a clipped piece of something else.
export function isolateLines(pixels,{framed=true}={}){
 const ink=inkTone(pixels);if(!ink)return {lines:[],owner:null,ink:null};
 const {tone,threshold,width,height}=ink,mask=new Uint8Array(width*height),rows=new Uint32Array(height);
 for(let p=0;p<mask.length;p++)if(tone[p]<=threshold)mask[p]=1;
 // Solid strokes lying along the lines (rules, underlines, the bars of a
 // barcode seen from text turned beside it) are no letters. They are taken
 // out first: their ink would fill the leading and hide the lines.
 const {labels,boxes}=label(mask,width,height),ruled=new Uint8Array(boxes.length);
 for(let c=1;c<boxes.length;c++){const b=boxes[c],w=b.x1-b.x0,h=b.y1-b.y0;if(w>=h*8&&b.area>=w*h*.8)ruled[c]=1;}
 // So is a shape several times taller than the letters around it: a letter of
 // a large inscription standing beside the lines. Letters and words are about
 // one letter high; lines joined through a descender are two.
 const tall=[];for(let c=1;c<boxes.length;c++)if(!ruled[c]&&boxes[c].area>=6)tall.push(boxes[c].y1-boxes[c].y0);
 tall.sort((a,b)=>a-b);const letter=tall[Math.floor(tall.length*.75)]||0,profiled=new Uint8Array(boxes.length);
 for(let c=1;c<boxes.length;c++)profiled[c]=!ruled[c]&&boxes[c].y1-boxes[c].y0<=letter*2.6?1:0;
 for(let p=0;p<mask.length;p++)if(mask[p]&&profiled[labels[p]])rows[(p/width)|0]++;
 const inked=[...rows].filter(n=>n>0).sort((a,b)=>a-b);if(!inked.length)return {lines:[],owner:null,ink};
 // A row of letter bodies carries far more ink than the leading between lines,
 // where only commas, descenders and accents reach.
 const peak=inked[Math.floor(inked.length*.9)],floor=Math.max(1,peak*.12),bands=[];let start=-1;
 for(let y=0;y<=height;y++){
  if(y<height&&rows[y]>=floor){if(start<0)start=y;}
  else if(start>=0){bands.push({y0:start,y1:y});start=-1;}
 }
 const sizes=bands.map(b=>b.y1-b.y0).filter(h=>h>=4).sort((a,b)=>a-b),typical=sizes[Math.floor(sizes.length/2)];
 if(!typical)return {lines:[],owner:null,ink};
 // Slivers between lines (a row of commas) are marks, not lines.
 const bodies=bands.filter(b=>b.y1-b.y0>=typical*.45);
 // Where two lines touch they are parted in the middle of the emptiest rows of the leading.
 const cuts=[0];
 for(let i=1;i<bodies.length;i++){let from=bodies[i-1].y1,to=from,least=Infinity;for(let y=bodies[i-1].y1;y<=Math.min(height-1,bodies[i].y0);y++){if(rows[y]<least){least=rows[y];from=to=y;}else if(rows[y]===least&&to===y-1)to=y;}cuts.push(Math.round((from+to)/2));}
 cuts.push(height);
 const zone=y=>{let i=0;while(i<bodies.length-1&&y>=cuts[i+1])i++;return i;};
 const owner=new Uint8Array(width*height),limit=Math.min(bodies.length,250);
 // Decide for every connected shape which line it belongs to.
 const verdict=new Int16Array(boxes.length); // >=0 line, -1 dropped, -2 split by rows
 for(let c=1;c<boxes.length;c++){
  const b=boxes[c],h=b.y1-b.y0,w=b.x1-b.x0,cut=framed&&(b.y0===0||b.y1===height),touched=[];let nearest=-1,gap=Infinity;
  // A long thin stroke is a rule, an underline or a bar of a barcode, never a letter.
  if(ruled[c]||Math.max(w,h)>=typical*3&&Math.min(w,h)<=typical*.3){verdict[c]=-1;continue;}
  bodies.forEach((body,i)=>{const distance=Math.max(0,body.y0-b.y1,b.y0-body.y1);if(Math.min(b.y1,body.y1)-Math.max(b.y0,body.y0)>0)touched.push(i);if(distance<gap){gap=distance;nearest=i;}});
  if(!touched.length){
   // A comma hangs from its own baseline and an accent sits on its own letter:
   // a mark in the leading belongs to the line it is nearer to; far from all
   // lines, or cut by the edge of the block, to none.
   verdict[c]=cut||framed&&(b.x0===0||b.x1===width)||gap>typical*.7?-1:nearest;continue;
  }
  if(touched.length===1&&!cut){
   // A shape reaching well beyond the letters above and below them is a
   // piece of another, larger inscription that happens to stand on this row.
   const body=bodies[touched[0]],tall=body.y1-body.y0;
   verdict[c]=h>tall*1.7||b.y0<body.y0-tall*.35&&b.y1>body.y1+tall*.35?-1:touched[0];continue;
  }
  // Letters of adjacent lines touch through a descender: a thin bridge in the
  // leading. A shape crossing the leading broadly is a rule or a large glyph
  // of another inscription.
  let broad=h>typical*6;
  for(let i=1;i<cuts.length-1&&!broad;i++){const y=cuts[i];if(y<=b.y0||y>=b.y1-1)continue;let n=0;for(let x=b.x0;x<b.x1;x++)if(labels[y*width+x]===c)n++;if(n>typical*.5)broad=true;}
  // Cut by the edge of the block with no leading in between to judge it by:
  // only as much of it as a letter of the line could occupy is kept.
  verdict[c]=broad?-1:-2;
 }
 for(let p=0;p<mask.length;p++){
  const c=labels[p];if(!c)continue;const v=verdict[c],y=(p/width)|0;let line=v;
  if(v===-2){line=zone(y);const body=bodies[line],tall=body.y1-body.y0;if(y<body.y0-tall*.4||y>=body.y1+tall*.4)line=-1;}
  owner[p]=line<0||line>=limit?255:line+1;
 }
 const lines=bodies.slice(0,limit).map(body=>({band:[body.y0,body.y1],top:height,bottom:0,left:width,right:0,ink:0}));
 for(let y=0,p=0;y<height;y++)for(let x=0;x<width;x++,p++){const o=owner[p];if(!o||o===255)continue;const l=lines[o-1];l.ink++;if(y<l.top)l.top=y;if(y>=l.bottom)l.bottom=y+1;if(x<l.left)l.left=x;if(x>=l.right)l.right=x+1;}
 lines.forEach((line,index)=>{line.index=index;});
 // A line whose letters are cut by the top or bottom edge of the block is not
 // read here; it tells that another line stands there (`clipped`).
 const whole=line=>!framed||line.band[0]>1&&line.band[1]<height-1;
 // A band much taller than its neighbours is several lines the leading did not
 // separate, or a different inscription: it is not read as one line.
 return {lines:lines.filter(line=>whole(line)&&line.ink>0&&line.band[1]-line.band[0]<typical*2.2&&line.right-line.left>=typical),owner,ink,typical,
  clipped:lines.filter(line=>!whole(line)&&line.ink>0).map(line=>({above:line.band[0]<=1,x0:line.left,x1:line.right}))};
}

// The line alone on clean paper: dark print, its soft edges kept, everything
// that belongs to other lines painted out. `box` is the area taken, in block
// pixels; the image is that area as RGBA.
export function lineImage({owner,ink},line,{pad=4,binary=false}={}){
 const {tone,width,height,inkLevel,paperLevel,threshold}=ink;
 const x0=Math.max(0,line.left-pad),x1=Math.min(width,line.right+pad),y0=Math.max(0,line.top-pad),y1=Math.min(height,line.bottom+pad),w=x1-x0,h=y1-y0,data=new Uint8ClampedArray(w*h*4),mine=line.index+1,range=Math.max(1,paperLevel-inkLevel);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const sx=x+x0,sy=y+y0,p=sy*width+sx;
  // Only this line's ink and the soft pixels right beside it are kept; other
  // ink and stray tone elsewhere become paper.
  let near=owner[p]===mine;
  for(let dy=-1;dy<=1&&!near;dy++){const yy=sy+dy;if(yy<0||yy>=height)continue;for(let dx=-1;dx<=1;dx++){const xx=sx+dx;if(xx>=0&&xx<width&&owner[yy*width+xx]===mine){near=true;break;}}}
  let value=255;
  if(near&&(!owner[p]||owner[p]===mine))value=binary?(tone[p]<=threshold?0:255):Math.max(0,Math.min(255,(tone[p]-inkLevel)/range*255));
  const o=(y*w+x)*4;data[o]=data[o+1]=data[o+2]=value;data[o+3]=255;
 }
 return {data,width:w,height:h,box:{x0,y0,x1,y1}};
}

// Where paragraphs stand: the places of words OCR has already read, joined
// into lines, and lines of one size stacked in one column. Only places are
// used, never what the words say. A block ends with its first and last read
// line, so nothing printed above or below is inside it; a line or two that no
// pass has read may lie between them. `page` is the page size in pixels, which
// makes distances equal along both axes. Each block is a box in page fractions
// with the quarter-turn that makes its text upright, the height of its letters
// in page pixels and the number of read lines.
export const foreignRows=(block,blocks)=>{
 // Lines of other blocks that run in another direction, are about as large or
 // larger and were read about as well as this block's own lines: their ink is
 // not this text. A smaller line never claims ink of a larger inscription: the
 // box of a small word that caught the edge of a large letter is a slip of the
 // box, not a letter of the small line. Box heights are too rough to tell
 // inscriptions of one direction apart, so those are left to the leading.
 const own=[...block.rows.map(row=>row.weight)].sort((a,b)=>a-b)[Math.floor(block.rows.length/2)];
 return blocks.filter(other=>other!==block&&other.rotation!==block.rotation&&other.size>=block.size*.75).flatMap(other=>other.rows.filter(row=>row.weight>=own*.3));
};
export function seedBlocks(words,page,{limit=60}={}){
 const items=[];
 for(const word of words){
  const b=word.box,turn=word.rotation||0,letters=(String(word.text).match(/[\p{L}\p{N}]/gu)||[]).length;
  if(!b||(word.confidence??0)<70||letters<2)continue;
  const x0=b.x*page.width,y0=b.y*page.height,x1=(b.x+b.w)*page.width,y1=(b.y+b.h)*page.height,flat=turn%180===0;
  // a: along the line, c: across it
  const item={turn,a0:flat?x0:y0,a1:flat?x1:y1,c0:flat?y0:x0,c1:flat?y1:x1,weight:word.confidence*letters};
  // A box far too tall or too long for its letters is two lines or a misreading.
  const size=item.c1-item.c0,along=item.a1-item.a0;if(along<letters*size*.2||along>letters*size*1.6)continue;
  items.push(item);
 }
 const size=item=>item.c1-item.c0,gap=(p,q,k)=>Math.max(0,p[k+'0']-q[k+'1'],q[k+'0']-p[k+'1']),lap=(p,q,k)=>Math.min(p[k+'1'],q[k+'1'])-Math.max(p[k+'0'],q[k+'0']);
 const middle=values=>[...values].sort((x,y)=>x-y)[Math.floor(values.length/2)];
 // Words of one line share most of their height and stand a word space apart.
 const linesOf=list=>{
  const parent=list.map((_,i)=>i),find=i=>parent[i]===i?i:parent[i]=find(parent[i]),order=list.map((_,i)=>i).sort((p,q)=>list[p].c0-list[q].c0);
  for(let p=0;p<order.length;p++){const a=list[order[p]];
   for(let q=p+1;q<order.length;q++){const b=list[order[q]];if(b.c0>a.c1)break;
    if(a.turn===b.turn&&lap(a,b,'c')>=Math.min(size(a),size(b))*.5&&Math.max(size(a),size(b))<=Math.min(size(a),size(b))*1.8&&gap(a,b,'a')<=Math.max(size(a),size(b))*2.5)parent[find(order[p])]=find(order[q]);}}
  const groups=new Map();list.forEach((item,i)=>{const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(item);});
  return [...groups.values()].map(members=>({turn:members[0].turn,a0:Math.min(...members.map(i=>i.a0)),a1:Math.max(...members.map(i=>i.a1)),c0:middle(members.map(i=>i.c0)),c1:middle(members.map(i=>i.c1)),weight:members.reduce((n,i)=>n+i.weight,0),members,size:middle(members.map(size))}));
 };
 // One place read in two directions or as letters of two sizes: the reading
 // with far more confident letters is the print, the other a misreading of it.
 const xy=l=>l.turn%180===0?{x0:l.a0,x1:l.a1,y0:l.c0,y1:l.c1}:{x0:l.c0,x1:l.c1,y0:l.a0,y1:l.a1};
 const common=(p,q)=>{const a=xy(p),b=xy(q);return Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));};
 const first=linesOf(items),home=new Map();first.forEach(line=>line.members.forEach(item=>home.set(item,line)));
 const sound=items.filter(item=>{const own=home.get(item),area=(item.a1-item.a0)*(item.c1-item.c0);
  return !first.some(line=>line!==own&&(line.turn!==item.turn||Math.max(line.size,size(item))>Math.min(line.size,size(item))*1.5)&&line.weight>item.weight*8&&common(line,item)>area*.5);});
 const lines=linesOf(sound),parent=lines.map((_,i)=>i),find=i=>parent[i]===i?i:parent[i]=find(parent[i]),order=lines.map((_,i)=>i).sort((p,q)=>lines[p].c0-lines[q].c0);
 for(let p=0;p<order.length;p++){const a=lines[order[p]];
  for(let q=p+1;q<order.length;q++){const b=lines[order[q]];if(b.c0>a.c1+a.size*2.5)break;
   if(a.turn===b.turn&&Math.max(a.size,b.size)<=Math.min(a.size,b.size)*1.35&&gap(a,b,'c')<=Math.max(a.size,b.size)*2.2&&lap(a,b,'a')>=Math.min(a.a1-a.a0,b.a1-b.a0)*.3)parent[find(order[p])]=find(order[q]);}}
 const stacks=new Map();lines.forEach((line,i)=>{const root=find(i);if(!stacks.has(root))stacks.set(root,[]);stacks.get(root).push(line);});
 return [...stacks.values()].map(members=>({members,weight:members.reduce((n,l)=>n+l.weight,0)})).sort((p,q)=>q.weight-p.weight).slice(0,limit).map(({members})=>{
  const b=xy({turn:members[0].turn,a0:Math.min(...members.map(l=>l.a0)),a1:Math.max(...members.map(l=>l.a1)),c0:Math.min(...members.map(l=>l.c0)),c1:Math.max(...members.map(l=>l.c1))});
  // `rows`: its read lines, each with how well it was read, so that a block
  // can leave out what belongs to an inscription of another direction or size.
  return {x:b.x0/page.width,y:b.y0/page.height,w:(b.x1-b.x0)/page.width,h:(b.y1-b.y0)/page.height,rotation:members[0].turn,size:middle(members.map(l=>l.size)),lines:members.length,
   rows:members.map(line=>{const r=xy(line);return {x:r.x0/page.width,y:r.y0/page.height,w:(r.x1-r.x0)/page.width,h:(r.y1-r.y0)/page.height,weight:line.weight};})};
 }).sort((p,q)=>p.y-q.y||p.x-q.x);
}

// Columns of a block: runs of pixel columns between gutters that stay empty
// over its whole height. Word spaces of justified lines do not line up down a
// paragraph, so a clear gutter beside a block of several lines parts it from a
// second column or from an inscription standing beside it. With fewer lines a
// gap must be wider before it is more than a word space; one or two lines are
// not divided at all. `size` is the letter height in these pixels and `lines`
// the number of lines. Returns [x0,x1) ranges, left to right.
export function blockColumns(pixels,size,lines){
 const ink=inkTone(pixels);if(!ink)return [];
 const {tone,threshold,width,height}=ink,cols=new Uint32Array(width);
 for(let y=0,p=0;y<height;y++)for(let x=0;x<width;x++,p++)if(tone[p]<=threshold)cols[x]++;
 // A stray soft pixel or a speck does not close a gutter.
 const least=lines>=6?size*.45:lines>=3?size:Infinity,speck=Math.max(1,height*.004),ranges=[];let start=-1,last=-1;
 for(let x=0;x<=width;x++){
  if(x<width&&cols[x]>speck){if(start<0)start=x;last=x;}
  else if(start>=0&&(x===width||x-last>=least)){ranges.push([start,last+1]);start=-1;}
 }
 return ranges;
}

// Of the lines found in a window cut around a seed, the one that stands at
// `row`, kept to the stretch that reaches `from`…`to` without a gap wider than
// a few letters: another column on the same row is a different line. Returns
// the line with `left`/`right` narrowed, or null.
export function pickLine(found,row,from,to){
 const line=found.lines.filter(l=>row>=l.band[0]-found.typical*.4&&row<=l.band[1]+found.typical*.4).sort((a,b)=>Math.abs((a.band[0]+a.band[1])/2-row)-Math.abs((b.band[0]+b.band[1])/2-row))[0];
 if(!line)return null;
 const {owner,ink}=found,width=ink.width,mine=line.index+1,cols=new Uint8Array(width);
 for(let y=line.top;y<line.bottom;y++)for(let x=line.left;x<line.right;x++)if(owner[y*width+x]===mine)cols[x]=1;
 const reach=(line.band[1]-line.band[0])*2.2;let left=Math.max(line.left,Math.min(line.right-1,Math.round(from))),right=Math.max(left+1,Math.min(line.right,Math.round(to)));
 // From the seeded stretch outwards while the line goes on.
 for(let x=left,blank=0;x>=line.left;x--){if(cols[x]){left=x;blank=0;}else if(++blank>reach)break;}
 for(let x=right-1,blank=0;x<line.right;x++){if(cols[x]){right=x+1;blank=0;}else if(++blank>reach)break;}
 while(left<right&&!cols[left])left++;while(right>left&&!cols[right-1])right--;
 return right-left<2?null:{...line,left,right};
}

// The lines of one block, each as an image of its own ink. Pixels are fetched
// through `grab(box,rotation,scale,erase)`, which returns the RGBA of a page
// box (page pixels, not turned) made upright and enlarged `scale` times, with
// the `erase` boxes (page fractions) painted as paper; so the same sequence
// runs on a canvas in the browser and on plain arrays in tests.
//   page    {width,height} of the page in pixels
//   bounds  {x0,y0,x1,y1} page pixels the search may not leave (the label)
//   taken   boxes of lines already read, shared between blocks
// Each line: {gray,binary} images, `region` (page fractions) the images cover,
// `rotation`, `letter` (height of the letter bodies in page pixels), `scale`.
export function blockLines(block,blocks,page,grab,{bounds={x0:0,y0:0,x1:page.width,y1:page.height},target=30,maxScale=1,taken=[],limit=80}={}){
 const rot=block.rotation,flat=rot%180===0,S=block.size,scale=Math.min(maxScale,Math.max(.35,target/S)),erase=foreignRows(block,blocks);
 const W=bounds.x1-bounds.x0,H=bounds.y1-bounds.y0,X0=block.x*page.width-bounds.x0,Y0=block.y*page.height-bounds.y0,X1=X0+block.w*page.width,Y1=Y0+block.h*page.height;
 // Upright frame of the block inside the bounds: u runs along its lines, v across them.
 const U=flat?W:H,V=flat?H:W,along=rot===0?[X0,X1]:rot===90?[H-Y1,H-Y0]:rot===180?[W-X1,W-X0]:[Y0,Y1],across=rot===0?[Y0,Y1]:rot===90?[X0,X1]:rot===180?[H-Y1,H-Y0]:[W-X1,W-X0];
 const turned=(u0,v0,u1,v1)=>rot===0?[u0,v0,u1,v1]:rot===90?[v0,H-u1,v1,H-u0]:rot===180?[W-u1,H-v1,W-u0,H-v0]:[W-v1,u0,W-v0,u1];
 const take=(u0,v0,u1,v1)=>{
  [u0,v0,u1,v1]=[Math.max(0,Math.floor(u0)),Math.max(0,Math.floor(v0)),Math.min(U,Math.ceil(u1)),Math.min(V,Math.ceil(v1))];if(u1-u0<4||v1-v0<4)return null;
  const [x0,y0,x1,y1]=turned(u0,v0,u1,v1);return {pixels:grab({x0:x0+bounds.x0,y0:y0+bounds.y0,x1:x1+bounds.x0,y1:y1+bounds.y0},rot,scale,erase),u0,v0};
 };
 // Gutters are looked for over the block's own rows only. One or two lines
 // are taken a few letters beyond their read stretch and followed from there.
 let columns=[[along[0]-S*3,along[1]+S*3]];
 if(block.lines>=3){const strip=take(0,across[0],U,across[1]);if(!strip)return [];columns=blockColumns(strip.pixels,S*scale,block.lines).map(([c0,c1])=>[c0/scale,c1/scale]).filter(([c0,c1])=>Math.min(c1,along[1])-Math.max(c0,along[0])>0);}
 const out=[];
 for(let [c0,c1] of columns){
  const look=(from,to)=>{
   const win=take(from-2,across[0]-S*1.6,to+2,across[1]+S*1.6);if(!win)return null;
   const found=isolateLines(win.pixels);let lines=found.lines;
   if(block.lines<3)lines=lines.map(line=>pickLine(found,(line.band[0]+line.band[1])/2,(along[0]-win.u0)*scale,(along[1]-win.u0)*scale)).filter(Boolean);
   return {win,found,lines,left:lines.some(line=>line.left<=1)&&win.u0>0,right:!!found.ink&&lines.some(line=>line.right>=found.ink.width-1)&&to+2<U};
  };
  let best=look(c0,c1);if(!best)continue;
  // A line that runs out of the window is followed further, a few letters at
  // a time and each way by itself, for as long as the same lines are still
  // found: beyond its end the strip may run into something else.
  if(block.lines<3)for(const side of ['left','right'])for(let step=0;step<6&&best[side];step++){
   const from=side==='left'?c0-S*2.5:c0,to=side==='right'?c1+S*2.5:c1,next=look(from,to);
   if(!next||next.lines.length<best.lines.length)break;
   best=next;c0=from;c1=to;
  }
  const {win,found,lines}=best;
  if(!win||!found)continue;
  for(const line of lines){
   if(out.length>=limit)return out;
   const body=turned(win.u0+line.left/scale,win.v0+line.band[0]/scale,win.u0+line.right/scale,win.v0+line.band[1]/scale).map((value,i)=>value+(i%2?bounds.y0:bounds.x0));
   // The same line reached from another block is read once.
   if(taken.some(t=>t.rotation===rot&&Math.min(t.x1,body[2])-Math.max(t.x0,body[0])>Math.min(t.x1-t.x0,body[2]-body[0])*.5&&Math.min(t.y1,body[3])-Math.max(t.y0,body[1])>Math.min(t.y1-t.y0,body[3]-body[1])*.5))continue;
   taken.push({rotation:rot,x0:body[0],y0:body[1],x1:body[2],y1:body[3]});
   const pad=Math.max(3,Math.round(found.typical*.25)),gray=lineImage(found,line,{pad}),binary=lineImage(found,line,{pad,binary:true}),b=gray.box;
   const [x0,y0,x1,y1]=turned(win.u0+b.x0/scale,win.v0+b.y0/scale,win.u0+b.x1/scale,win.v0+b.y1/scale);
   // `cut`: the line still runs out of the window on that side, so the word there is not whole.
   out.push({gray,binary,rotation:rot,scale,letter:(line.band[1]-line.band[0])/scale,cut:{left:line.left<=1&&win.u0>0,right:line.right>=found.ink.width-1&&win.u0+found.ink.width/scale<U-1},region:{x:(x0+bounds.x0)/page.width,y:(y0+bounds.y0)/page.height,w:(x1-x0)/page.width,h:(y1-y0)/page.height}});
  }
 }
 return out;
}

// The print of about one letter size found in a piece of the page, on clean
// paper: lines whose letters are near `letter` pixels high, without rules,
// frames, panels and pieces of neighbouring lines cut by the edge. Returns the
// picture as RGBA, or null when no such print is there: the place is empty.
export function printOnly(pixels,letter){
 // A line of letters is broken ink; a solid slab of the same height is a panel or a window, not print.
 const found=isolateLines(pixels),lines=found.lines.filter(line=>{const tall=line.band[1]-line.band[0];return tall>=letter*.45&&tall<=letter*2&&line.ink<=(line.right-line.left)*(line.bottom-line.top)*.8;});
 if(!lines.length)return null;
 const {owner,ink}=found,{tone,width,height,inkLevel,paperLevel}=ink,keep=new Uint8Array(256),range=Math.max(1,paperLevel-inkLevel),data=new Uint8ClampedArray(width*height*4);
 for(const line of lines)keep[line.index+1]=1;
 for(let y=0,p=0;y<height;y++)for(let x=0;x<width;x++,p++){
  // Ink of the kept lines and the soft pixels right beside it.
  let near=keep[owner[p]]===1;
  for(let dy=-1;dy<=1&&!near;dy++){const yy=y+dy;if(yy<0||yy>=height)continue;for(let dx=-1;dx<=1;dx++){const xx=x+dx;if(xx>=0&&xx<width&&keep[owner[yy*width+xx]]===1){near=true;break;}}}
  const value=near&&(!owner[p]||keep[owner[p]]===1)?Math.max(0,Math.min(255,(tone[p]-inkLevel)/range*255)):255,o=p*4;
  data[o]=data[o+1]=data[o+2]=value;data[o+3]=255;
 }
 return {data,width,height};
}
