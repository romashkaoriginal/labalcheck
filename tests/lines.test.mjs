import test from 'node:test';
import assert from 'node:assert/strict';
import {inkTone,isolateLines,lineImage,seedBlocks,foreignRows,blockColumns,blockLines,printOnly,pickLine} from '../src/lines.js';

// ---- drawn print ---------------------------------------------------------------
// Letters are solid blocks. Nothing here is the layout of a real label: the
// same checks run on a paragraph, on its mirror image and turned on its side.
const BLACK=[20,20,20],WHITE=[255,255,255];
function page(width=900,height=600,paper=WHITE){
 const data=new Uint8ClampedArray(width*height*4);for(let p=0;p<width*height;p++){data[p*4]=paper[0];data[p*4+1]=paper[1];data[p*4+2]=paper[2];data[p*4+3]=255;}
 const fill=(x0,y0,x1,y1,[r,g,b]=BLACK)=>{for(let y=Math.max(0,Math.round(y0));y<Math.min(height,Math.round(y1));y++)for(let x=Math.max(0,Math.round(x0));x<Math.min(width,Math.round(x1));x++){const i=(y*width+x)*4;data[i]=r;data[i+1]=g;data[i+2]=b;}};
 // A line of words given as letter counts; returns its box and the boxes of its words.
 const line=(counts,x,y,size=20,color=BLACK)=>{let u=0;const words=[];for(const count of counts){const start=u;for(let i=0;i<count;i++){fill(x+u,y,x+u+size*.5,y+size,color);u+=size*.62;}words.push({x0:x+start,y0:y,x1:x+u-size*.12,y1:y+size});u+=size*.4;}return {x0:x,y0:y,x1:x+u-size*.52,y1:y+size,words};};
 return {pixels:{data,width,height},fill,line,width,height};
}
const inked=(image,x0=0,x1=image.width)=>{let n=0;for(let y=0;y<image.height;y++)for(let x=Math.max(0,x0);x<Math.min(image.width,x1);x++)if(image.data[(y*image.width+x)*4]<128)n++;return n;};
// A grab over drawn pixels: the same contract the browser canvas fulfils.
const grabFrom=s=>(box,rot,scale,erase)=>{
 const w=Math.max(1,Math.round((box.x1-box.x0)*scale)),h=Math.max(1,Math.round((box.y1-box.y0)*scale)),flat=new Uint8ClampedArray(w*h*4).fill(255);
 for(let y=0;y<h;y++){const py=box.y0+(y+.5)/scale;for(let x=0;x<w;x++){const px=box.x0+(x+.5)/scale,sx=Math.floor(px),sy=Math.floor(py);if(sx<0||sy<0||sx>=s.width||sy>=s.height)continue;
  if(erase.some(r=>px>=r.x*s.width-1&&px<(r.x+r.w)*s.width+1&&py>=r.y*s.height-1&&py<(r.y+r.h)*s.height+1))continue;
  const i=(sy*s.width+sx)*4,o=(y*w+x)*4;flat[o]=s.pixels.data[i];flat[o+1]=s.pixels.data[i+1];flat[o+2]=s.pixels.data[i+2];}}
 if(!rot)return {data:flat,width:w,height:h};
 const W=rot%180?h:w,H=rot%180?w:h,turned=new Uint8ClampedArray(W*H*4).fill(255);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const [ux,uy]=rot===90?[h-1-y,x]:rot===270?[y,w-1-x]:[w-1-x,h-1-y],o=(uy*W+ux)*4,i=(y*w+x)*4;turned[o]=flat[i];turned[o+1]=flat[i+1];turned[o+2]=flat[i+2];}
 return {data:turned,width:W,height:H};
};
// Words as an OCR pass would report them: places only.
// Lines of one paragraph differ: their word spaces do not line up into gutters.
const shapes=[[6,5,7,4],[5,7,4,6],[7,4,6,5],[4,6,5,7],[6,7,4,5],[5,4,7,6],[7,6,5,4]];
const wordsOf=(line,s,{rotation=0,confidence=92,pass='ocr-1'}={})=>line.words.map(b=>({text:'слово',confidence,rotation,pass,box:{x:b.x0/s.width,y:b.y0/s.height,w:(b.x1-b.x0)/s.width,h:(b.y1-b.y0)/s.height}}));

test('lines set with tight leading are parted by their own ink: marks go to their line, a neighbour and a rule to none',()=>{
 const s=page(700,220),first=s.line([6,5,7],40,40),second=s.line([7,6,4],40,66);s.line([5,8,3],40,92);
 s.fill(100,60,104,65);                 // a comma hanging under the first line, in the leading
 s.fill(180,62,190,65);                 // an accent over a letter of the second line
 s.fill(560,10,600,210);                // a tall letter of an inscription standing beside the paragraph
 s.fill(30,118,520,120);                // a rule under the paragraph
 const found=isolateLines(s.pixels);
 assert.deepEqual(found.lines.map(line=>line.band),[[40,60],[66,86],[92,112]]);
 assert.equal(found.owner[62*700+101],1,'the comma belongs to the line it hangs from');
 assert.equal(found.owner[63*700+185],2,'the accent belongs to the letter under it');
 assert.equal(found.owner[100*700+580],255,'the neighbouring inscription belongs to no line');
 assert.equal(found.owner[119*700+200],255,'neither does the rule');
 // The picture of the second line holds its 17 letters and its accent, nothing else.
 assert.equal(inked(lineImage(found,found.lines[1],{pad:4,binary:true})),17*10*20+10*3);
 assert.ok(found.lines.every(line=>line.left>=39&&line.right<=Math.max(first.x1,second.x1)+25),'the neighbour does not stretch the lines');
});

test('light print on a coloured panel is found the same way and comes out dark on paper',()=>{
 const s=page(500,120,[40,170,180]);s.line([5,6],30,30,24,WHITE);s.line([4,7],30,64,24,WHITE);
 assert.equal(inkTone(s.pixels).reversed,true);
 const found=isolateLines(s.pixels);assert.equal(found.lines.length,2);
 assert.equal(inked(lineImage(found,found.lines[0],{binary:true})),11*12*24);
 assert.equal(isolateLines(page(200,100).pixels).lines.length,0,'blank paper has no lines');
});

test('a block ends with its read lines; unread lines lie inside it; an inscription turned beside it is another block',()=>{
 const s=page(900,600),lines=[0,1,2,3,4,5,6].map(i=>s.line(shapes[i],60,80+i*30));
 const turned=[0,1,2].map(i=>({x0:640,y0:100+i*130,x1:700,y1:210+i*130}));
 for(const b of turned)s.fill(b.x0,b.y0,b.x1,b.y1);
 // Lines 2 and 5 were read by no pass.
 const words=[...lines.filter((_,i)=>i!==2&&i!==5).flatMap(line=>wordsOf(line,s)),...turned.map(b=>({text:'КРУ',confidence:95,rotation:90,pass:'ocr-2',box:{x:b.x0/900,y:b.y0/600,w:60/900,h:110/600}}))];
 const blocks=seedBlocks(words,{width:900,height:600});
 assert.equal(blocks.length,2);
 const text=blocks.find(block=>block.rotation===0),vertical=blocks.find(block=>block.rotation===90);
 assert.equal(text.lines,5);assert.ok(Math.abs(text.y*600-80)<2&&Math.abs((text.y+text.h)*600-280)<2,'from the first read line to the last');
 assert.equal(vertical.lines,1);
 // The paragraph leaves out the larger turned inscription; a smaller line never claims ink of a larger one.
 assert.equal(foreignRows(text,blocks).length,1);assert.equal(foreignRows(vertical,blocks).length,0);
});

test('every line of a block is cut out whole, in a layout, in its mirror image and turned on its side',()=>{
 for(const mirrored of [false,true]){
  const s=page(900,600),x=mirrored?330:60,lines=[0,1,2,3,4,5,6].map(i=>s.line(shapes[i],x,80+i*30));
  // A large inscription turned on its side, a third of a letter away from the paragraph.
  const edge=mirrored?x-6:lines[0].x1+6,letters=[0,1,2,3].map(i=>mirrored?[edge-60,90+i*52,edge,130+i*52]:[edge,90+i*52,edge+60,130+i*52]);
  for(const b of letters)s.fill(...b);
  const words=[...lines.filter((_,i)=>i!==3).flatMap(line=>wordsOf(line,s)),{text:'КРУПНО',confidence:95,rotation:90,pass:'ocr-2',box:{x:Math.min(...letters.map(b=>b[0]))/900,y:90/600,w:60/900,h:(letters.at(-1)[3]-90)/600}}];
  const blocks=seedBlocks(words,s),text=blocks.find(block=>block.rotation===0),cut=blockLines(text,blocks,s,grabFrom(s),{maxScale:1.5});
  assert.equal(cut.length,7,`all seven lines, the unread one too, mirrored=${mirrored}`);
  for(const [i,line] of cut.entries()){
   // 22 letters of 10 × 20 page pixels and nothing of the large inscription beside them.
   const own=22*10*20*line.scale*line.scale;assert.ok(Math.abs(inked(line.binary)-own)<own*.15,`only its own ink in line ${i}, mirrored=${mirrored}`);
   assert.ok(Math.abs(line.letter-20)<=1.5,'letter height in page pixels');
   assert.ok(Math.abs(line.region.y*600-(80+i*30))<8&&Math.abs(line.region.x*900-x)<8,'the picture is placed where the line stands');
  }
 }
 // The same kind of paragraph turned a quarter: it reads after turning the page 90° clockwise.
 const s=page(600,900),words=[];
 for(let i=0;i<5;i++){let v=0;for(const count of [6,5,7]){const start=v;for(let k=0;k<count;k++){s.fill(100+i*30,800-v-10,120+i*30,800-v);v+=12.4;}words.push({text:'слово',confidence:92,rotation:90,pass:'ocr-3',box:{x:(100+i*30)/600,y:(800-v+2.4)/900,w:20/600,h:(v-2.4-start)/900}});v+=8;}}
 const blocks=seedBlocks(words,s),cut=blockLines(blocks[0],blocks,s,grabFrom(s),{maxScale:1.5});
 assert.equal(blocks[0].rotation,90);assert.equal(cut.length,5);
 assert.ok(cut.every(line=>line.rotation===90&&line.gray.width>line.gray.height*4),'each line comes out upright');
});

test('two columns of one size are divided at the gutter; a lone line is not divided at a word space',()=>{
 const s=page(900,400),left=[0,1,2,3,4,5,6].map(i=>s.line(shapes[i].slice(0,3),40,60+i*30)),right=[0,1,2,3,4,5,6].map(i=>s.line(shapes[6-i].slice(1),480,60+i*30));
 const columns=blockColumns(grabFrom(s)({x0:0,y0:60,x1:900,y1:260},0,1,[]),20,7);
 assert.equal(columns.length,2);assert.ok(columns[0][1]<=left[0].x1+1&&columns[1][0]>=479);
 assert.equal(blockColumns(grabFrom(s)({x0:0,y0:60,x1:900,y1:80},0,1,[]),20,1).length,1,'a lone line is one piece whatever its gaps');
 // Words of both columns may have been joined into one block: their lines are still read apart.
 const blocks=seedBlocks([...left,...right].flatMap(line=>wordsOf(line,s)),s),taken=[],cut=blocks.flatMap(block=>blockLines(block,blocks,s,grabFrom(s),{maxScale:1.5,taken}));
 assert.equal(cut.length,14);
 assert.ok(cut.every(line=>line.region.w*900<250),'no line runs across the gutter');
});

test('an empty place, a panel and the lines of a frame are no print; letters are',()=>{
 assert.equal(printOnly(page(300,80).pixels,24),null);
 const framed=page(300,80);framed.fill(10,10,290,12);framed.fill(10,68,290,70);framed.fill(10,10,12,70);assert.equal(printOnly(framed.pixels,24),null,'thin lines of a field');
 const panel=page(300,80,[235,200,205]);panel.fill(60,20,300,60,WHITE);assert.equal(printOnly(panel.pixels,24),null,'a white window on a tinted label');
 const neighbour=page(300,80);neighbour.fill(250,0,290,30);assert.equal(printOnly(neighbour.pixels,24),null,'a letter of another line cut by the edge');
 const printed=page(300,80);printed.line([5,4],20,28,24);
 const picture=printOnly(printed.pixels,24);assert.ok(picture);assert.equal(inked(picture),9*12*24);
});

test('a short line is followed from where it was read to its real ends and no further',()=>{
 const s=page(900,120),line=s.line([6,5,7,4],200,50),far=s.line([5,5],720,50);
 const found=isolateLines(s.pixels,{framed:false}),picked=pickLine(found,60,300,360);
 assert.ok(Math.abs(picked.left-200)<=1&&Math.abs(picked.right-line.x1)<=1,'the whole line, not only the read stretch');
 assert.ok(picked.right<far.x0,'not the line of another column on the same row');
});
