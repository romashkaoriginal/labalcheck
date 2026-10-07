import test from 'node:test';
import assert from 'node:assert/strict';
import {detectFrames,segmentInk,mapBox,locateText,matchRequirements} from '../src/automatic.js';
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
 assert.equal(locateText('Крепость 40%',words).exact,true);assert.equal(locateText('Крепость 45%',words),null);
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
