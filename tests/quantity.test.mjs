import test from 'node:test';
import assert from 'node:assert/strict';
import {quantities,quantityComparison,quantityReadAreas,numericInk,recoverNumericReading,dateEvidence} from '../src/quantity.js';
import {variantText,dimensionChecks,evaluate} from '../src/engine.js';
import {matchRequirements,wordsFromOcr} from '../src/automatic.js';

const label={x:0,y:0,w:1,h:1};
const word=(text,x,y=.2,height=4.2,pass='one')=>({text,confidence:95,box:{x,y,w:text.length*.018,h:.02},pass,glyphs:[...text].filter(c=>/[\p{L}\p{N}]/u.test(c)).map(text=>({text,height}))});
const volume={id:'v',title:'Объем',text:'Объем 0,7 л',original:'Объем 0,7 л',constraint:'Термин «объем» не менее 2 мм; количество (например 0,5 л) не менее 4 мм'};

test('quantity parser preserves decimals, normalizes litre notation, and converts supported units',()=>{
 assert.equal(quantities('0.7 L')[0].baseValue,.7);assert.ok(Math.abs(quantities('700 мл')[0].baseValue-.7)<1e-9);assert.ok(Math.abs(quantities('0,0007 м³')[0].baseValue-.7)<1e-9);
 assert.equal(quantities('Масса 0,5 кг')[0].baseValue,500);assert.equal(quantities('40 %; 103 мм; -0,7 л').length,0);
 assert.equal(quantityComparison(quantities('0,7 л')[0],quantities('700 ml')[0]),'equivalent');
 assert.equal(quantityComparison(quantities('0,7 л')[0],quantities('0,7 кг')[0]),'wrong_unit');
 assert.equal(quantityComparison(quantities('0,7 л')[0],quantities('0,5 л')[0]),'wrong_value');
});
test('column 2 quantity example never overrides the expected quantity or column 3 unit',()=>{
 assert.equal(variantText(volume,'0,5'),'Объем 0,7 л');
 assert.equal(variantText({...volume,text:'Объем\n500 мл\n700 мл',original:'Объем\n500 мл\n700 мл'},'0,7'),'Объем 700 мл');
 assert.deepEqual(dimensionChecks(volume).map(d=>d.min),[2,4]);
 assert.deepEqual(dimensionChecks({...volume,constraint:'Буквы 0,2 см; количество 0,4 cm'}).map(d=>d.min),[2,4]);
});
test('mixed-size quantity is matched independently of caption and measured including the unit',()=>{
 const words=[word('ОБЪЕМ',.1,.1,2.1),word('0,7',.4,.3,4.2),word('Л',.46,.3,3)];
 const match=matchRequirements([volume],words,'0,7',false,label,true).v;
 assert.equal(match.exact,true);assert.equal(match.quantity.status,'match');assert.equal(match.quantity.numberHeight,4.2);assert.equal(match.quantity.unitHeight,3);
 assert.deepEqual(match.dimensions,[2.1,3]);const row=evaluate([volume],'ОБЪЕМ 0,7 Л',{automatic:{v:match}})[0];assert.equal(row.status,'issue');assert.equal(row.statusLabel,'Проверить размеры');
});
test('quantity below the right value, missing unit and ambiguous numbers are not accepted',()=>{
 const read=words=>matchRequirements([volume],words,'0,7',false,label,true).v.quantity;
 assert.equal(read([word('0,5',.1),word('л',.17)]).status,'wrong_value');
 assert.equal(read([word('0,7',.1)]).status,'unreadable');
 assert.equal(read([word('0,7л',.1),word('0,5л',.1,.2,4.2,'two')]).status,'ambiguous');
});
test('enlarged proof and nutrition quantities do not replace the nominal quantity on the label',()=>{
 const smallLabel={x:.1,y:.1,w:.4,h:.5};
 const words=[word('на',.12),word('100',.16),word('мл',.22),word('продукта',.27),word('0,7л',.7)];
 const result=matchRequirements([volume],words,'0,7',false,smallLabel,true).v;
 assert.equal(result.quantity.status,'unreadable');assert.equal(result.quantity.actual,null);
});
test('missing physical scale cannot produce an automatic millimetre value',()=>{
 const words=[word('Объем',.1,.1),word('0,7л',.1,.2)];words.forEach(w=>w.glyphs.forEach(g=>g.height=null));
 const result=matchRequirements([volume],words,'0,7',false,label,true).v;
 assert.equal(result.quantity.status,'match');assert.deepEqual(result.dimensions,[null,null]);assert.ok(result.measurementNotes.every(Boolean));
});
const date={id:'d',title:'Окно для даты розлива',text:'Дата розлива / номер партии:',original:'Дата розлива / номер партии:',constraint:'Буквы не менее 0,8 мм и цифры 2,0 мм. Формат 42х11 или 49х6 (мм)'};
const caption=[word('Дата',.1,.5,.84),word('розлива',.18,.5,.84),word('номер',.32,.5,.84),word('партии',.42,.5,.84)];
test('visible date caption is measured while an empty window is explicitly explained',()=>{
 const result=matchRequirements([date],caption,'0,7',false,label,true).d;
 assert.equal(result.dimensions[0],.84);assert.equal(result.dimensions[1],null);assert.match(result.measurementNotes[1],/пустого окна/i);
});
test('printed date digits are measured without using the barcode digits above the caption',()=>{
 const words=[...caption,word('4813852006269',.1,.44,1.7),word('07.10.2026',.56,.5,2.2)];
 const result=matchRequirements([date],words,'0,7',false,label,true).d;
 assert.deepEqual(result.dimensions,[.84,2.2]);assert.equal(result.date.text,'07.10.2026');
});
test('date digit search follows a quarter-turn caption instead of original screen directions',()=>{
 const rotate=w=>({...w,rotation:90,box:{x:w.box.y,y:1-w.box.x-w.box.w,w:w.box.h,h:w.box.w}});
 const letters=caption.map(rotate),digits=rotate(word('07.10.2026',.56,.5,2.2));
 const evidence=dateEvidence({exact:true,words:letters,rotation:90},[...letters,digits],label,true);
 assert.equal(evidence.numberHeight,2.2);assert.equal(evidence.text,'07.10.2026');
});
test('quantity rereads use detected coordinates and keep proof captions outside the label',()=>{
 const areas=quantityReadAreas([word('Объем',.1,.1),word('Объем',.7,.7)],{x:.05,y:.05,w:.4,h:.4},true);
 assert.ok(areas.length);assert.ok(areas.every(a=>a.x<.45&&a.y<.45));
});
test('glyph measurement uses visible dark ink and excludes magenta annotation pixels',()=>{
 const width=20,height=30,data=new Uint8ClampedArray(width*height*4).fill(255);
 for(let y=8;y<18;y++)for(let x=4;x<12;x++){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
 for(let y=1;y<28;y++){const i=(y*width+15)*4;data[i]=245;data[i+1]=50;data[i+2]=140;}
 const bbox={x0:0,y0:0,x1:20,y1:30},ocr={blocks:[{paragraphs:[{lines:[{words:[{text:'7',confidence:95,bbox,symbols:[{text:'7',confidence:95,bbox}]}]}]}]}]};
 assert.equal(wordsFromOcr(ocr,label,width,height,0,.1,'one',{data,width,height})[0].glyphs[0].height,1);
});

test('white letters on a colored label have a measured height, and blank pixels stay unmeasured',()=>{
 const width=20,height=30,data=new Uint8ClampedArray(width*height*4).fill(255);
 for(let i=0;i<data.length;i+=4){data[i]=45;data[i+1]=180;data[i+2]=190;}
 for(let y=8;y<18;y++)for(let x=4;x<12;x++){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=255;}
 const bbox={x0:0,y0:0,x1:20,y1:30},ocr={blocks:[{paragraphs:[{lines:[{words:[{text:'А',confidence:95,bbox,symbols:[{text:'А',confidence:95,bbox}]}]}]}]}]};
 assert.equal(wordsFromOcr(ocr,label,width,height,0,.1,'one',{data,width,height})[0].glyphs[0].height,1);
 assert.equal(wordsFromOcr(ocr,label,width,height,0,.1,'one',{data:new Uint8ClampedArray(width*height*4).fill(255),width,height})[0].glyphs[0].height,null);
});
test('a missing decimal is recovered only from a distinct ink component below the digit baseline',()=>{
 const width=80,height=60,data=new Uint8ClampedArray(width*height*4).fill(255);
 const fill=(x,y,w,h)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){const i=(yy*width+xx)*4;data[i]=data[i+1]=data[i+2]=0;}};
 fill(5,5,18,35);fill(40,5,18,35);fill(27,35,6,10);
 const ink=numericInk({width,height,data}),symbols=[{text:'0',confidence:96},{text:'7',confidence:97}];
 assert.equal(recoverNumericReading('07',symbols,ink),'0,7');
 assert.equal(recoverNumericReading('07',symbols,{...ink,separators:[]}), '07');
 assert.equal(recoverNumericReading('07',[{text:'0',confidence:50},symbols[1]],ink),null);
 assert.equal(recoverNumericReading('07',symbols,{...ink,separators:[1,1]}),null);
 assert.equal(recoverNumericReading('0,7',symbols,{...ink,separators:[]}),null);
});
