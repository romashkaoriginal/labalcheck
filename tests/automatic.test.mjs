import test from 'node:test';
import assert from 'node:assert/strict';
import {detectFrames,detectArtworkRegion,segmentInk,mapBox,locateText,matchRequirements} from '../src/automatic.js';
import {evaluate} from '../src/engine.js';

test('separate die-cut frames are not merged across the gutter',()=>{
 const width=500,height=600,data=new Uint8ClampedArray(width*height*4).fill(255);
 const pink=(x,y)=>{const i=(y*width+x)*4;data[i]=240;data[i+1]=50;data[i+2]=140;};
 for(const left of [60,270]){for(let x=left;x<=left+150;x++){pink(x,150);pink(x,470);}for(let y=150;y<=470;y++){pink(left,y);pink(left+150,y);}}
 const found=detectFrames({data,width,height});assert.equal(found.length,2);assert.ok(found.every(r=>r.w<.32));
});
test('blank and unframed pages do not claim a die-cut boundary',()=>{
 assert.deepEqual(detectFrames({data:new Uint8ClampedArray(100*100*4).fill(255),width:100,height:100}),[]);
});
test('artwork scan includes detached panels and skips a printing protocol',()=>{
 const width=400,height=400,data=new Uint8ClampedArray(width*height*4).fill(255);
 for(const y of [290,320,350])for(let x=30;x<360;x++){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
 const region=detectArtworkRegion({data,width,height});assert.ok(region.h>.7&&region.h<.75);
});
test('ink segmentation isolates adjacent text columns without user coordinates',()=>{
 const width=200,height=300,data=new Uint8ClampedArray(width*height*4).fill(255);
 for(const [left,right] of [[20,100],[130,155]])for(let y=20;y<280;y++)for(let x=left;x<right;x++){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
 const blocks=segmentInk({data,width,height},{x:0,y:0,w:1,h:1});assert.equal(blocks.length,2);assert.ok(blocks[0].x+blocks[0].w<blocks[1].x);
});
test('quarter-turn OCR boxes map back to original page coordinates',()=>{
 const region={x:.2,y:.3,w:.4,h:.5};
 const original=mapBox({x0:10,y0:20,x1:30,y1:50},region,100,200);
 for(const [rotation,box] of [[90,{x0:150,y0:10,x1:180,y1:30}],[180,{x0:70,y0:150,x1:90,y1:180}],[270,{x0:20,y0:70,x1:50,y1:90}]])assert.deepEqual(mapBox(box,region,100,200,rotation),original);
});
const words=['Крепость','40','%'].map((text,i)=>({text,confidence:95,box:{x:.1+i*.1,y:.2,w:.1,h:.1},glyphs:[...text].map(text=>({text,height:2.1}))}));
test('locate text returns word coordinates and rejects changed numeric values',()=>{
 assert.equal(locateText('Крепость 40%',words).exact,true);assert.equal(locateText('Крепость 45%',words).exact,false);assert.ok(locateText('Крепость 45%',words).diff.some(d=>d.expected==='45'&&d.actual==='40'));
});
test('finds words spread across different areas without inventing an exact phrase',()=>{
 const mixed=[{text:'40',box:{x:.8,y:.6,w:.04,h:.04}},{text:'Состав',box:{x:.1,y:.1,w:.1,h:.02}},{text:'%',box:{x:.9,y:.6,w:.02,h:.04}},{text:'крепость',box:{x:.7,y:.6,w:.1,h:.04}}];
 const match=locateText('Состав крепость 40%',mixed);assert.equal(match.exact,false);assert.ok(match.coverage<100);assert.ok(match.diff.some(d=>d.expected==='состав'));
});
test('automatic measurements carry uncertainty and cannot approve a requirement alone',()=>{
 const rules=[{id:'r0',title:'Крепость',text:'Крепость 40%',original:'Крепость 40%',constraint:'не менее 2 мм'}];
 const automatic=matchRequirements(rules,words,'0,7',false,{x:0,y:0,w:1,h:1},true);
 const row=evaluate(rules,'Крепость 40%',{automatic})[0];assert.equal(row.status,'detected');assert.equal(row.dimensions[0].value,2.1);assert.equal(row.dimensions[0].estimated,true);
 const noScale=words.map(w=>({...w,glyphs:w.glyphs.map(g=>({...g,height:null}))}));assert.equal(matchRequirements(rules,noScale,'0,7',false,null,false).r0.dimensions[0],null);
});
test('percentage requires a detected label boundary',()=>{
 const rules=[{id:'r0',title:'Предупреждение',text:'Крепость 40%',original:'Крепость 40%',constraint:'не менее 10%'}];
 assert.equal(matchRequirements(rules,words,'0,7',false,{x:0,y:0,w:1,h:1},false).r0.dimensions[0],null);
});

test('an exact enlarged proof cannot override changed or absent text on the printed label',()=>{
 const rule={id:'r0',title:'Крепость',text:'Крепость 40%',original:'Крепость 40%',constraint:''};
 const proof=words.map(w=>({...w,pass:'proof'})),printed=words.map(w=>({...w,text:w.text==='40'?'45':w.text,box:{...w.box,x:w.box.x+.5},pass:'printed'}));
 const contour={x:.55,y:.1,w:.4,h:.3};
 const automatic=matchRequirements([rule],[...proof,...printed],'0,7',false,contour,true);
 assert.equal(automatic.r0.exact,false);assert.ok(automatic.r0.words.every(w=>w.box.x>=contour.x));
 assert.equal(evaluate([rule],'Крепость 40% Крепость 45%',{automatic})[0].comparison.status,'partial');
 const absent=matchRequirements([rule],proof,'0,7',false,contour,true);
 assert.equal(evaluate([rule],'Крепость 40%',{automatic:absent})[0].comparison.status,'unreadable');
 assert.equal(matchRequirements([rule],proof,'0,7',false,null,false).r0.exact,true);
});

test('uncertain text does not discard reliable glyph heights in its physical section',()=>{
 const rule={id:'r0',title:'Надпись',text:'Хранить плотно закрытым',original:'Хранить плотно закрытым',constraint:'не менее 0,8 мм'};
 const printed=['Хранить','плотно','е','закрытым'].map((text,i)=>({text,confidence:i===2?20:95,pass:'print',box:{x:.1+i*.12,y:.1,w:.1,h:.02},glyphs:[{text:'А',height:.9},{text:'Б',height:.9},{text:'В',height:i===3?.1:.9}]}));
 const automatic=matchRequirements([rule],printed,'0,7',false,{x:0,y:0,w:1,h:1},true);
 assert.equal(automatic.r0.dimensions[0],.9);
 assert.equal(evaluate([rule],printed.map(w=>w.text).join(' '),{automatic})[0].comparison.status,'uncertain');
});
