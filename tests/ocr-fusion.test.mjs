import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {matchRequirements} from '../src/automatic.js';
import {paddleWords} from '../src/paddle.js';
import {fuseOcrMatches} from '../src/ocr-fusion.js';
import {evaluate,normalize} from '../src/engine.js';

const fixture=name=>JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/${name}.json.gz`,import.meta.url))));

test('a line separator before a positive amount is not a minus sign',()=>{
 assert.equal(normalize('углеводы — 0,1 г'),normalize('углеводы 0,1 г'));
 assert.notEqual(normalize('от -15 °C'),normalize('от 15 °C'));
 assert.notEqual(normalize('сахар -0,1 г'),normalize('сахар 0,1 г'));
});

test('independent OCR maps polygons into the selected print contour at any position and rotation',()=>{
 const source={image:{width:100,height:200},items:[{text:'Вино',score:.9,poly:[[10,20],[50,20],[50,40],[10,40]]}]};
 const region={x:.6,y:.25,w:.3,h:.5};
 for(const rotation of [0,90,180,270]){
  const word=paddleWords(source,region,100,200,rotation)[0];
  assert.equal(word.text,'Вино');assert.equal(word.confidence,90);
  assert.ok(word.box.x>=region.x&&word.box.y>=region.y&&word.box.x+word.box.w<=region.x+region.w&&word.box.y+word.box.h<=region.y+region.h);
 }
});

test('saved independent OCR resolves only corroborated uncertain sections on the actual sample',()=>{
 const base=fixture('sample-lines-ocr'),second=fixture('sample-paddle');
 const primary=matchRequirements(base.rules,base.words,'0,7',false,base.label,true);
 const words=[...paddleWords(second.horizontal,base.label,second.horizontal.image.width,second.horizontal.image.height),...paddleWords(second.rotated,base.label,second.horizontal.image.width,second.horizontal.image.height,90)];
 const secondary=matchRequirements(base.rules,words,'0,7',false,base.label,true);
 const merged=fuseOcrMatches(primary,secondary),rows=evaluate(base.rules,base.actual,{automatic:merged});
 assert.deepEqual(rows.map(row=>row.comparison.status),['found','found','found','uncertain','manual','found','found','uncertain','found','found','na','found','found','found','manual','found','uncertain']);
 assert.deepEqual(Object.entries(merged).filter(([,match])=>match?.method==='independent-ocr').map(([id])=>id),['r2','r5','r6']);
 // r5: the second engine read the two turned lines of the shelf life, with one word space lost.
 for(const id of ['r2','r5','r6']){
  assert.equal(merged[id].ocrEvidence.primary,primary[id].recognizedText);
  assert.equal(merged[id].ocrEvidence.secondary,secondary[id].recognizedText);
  assert.deepEqual(merged[id].boxes,primary[id].boxes);
 }
 assert.equal(rows.find(row=>row.id==='r8').statusLabel,'Проверить размеры');
 assert.equal(rows.find(row=>row.id==='r11').statusLabel,'Проверить размеры');
 assert.ok(rows.every(row=>row.status!=='pass'));
});

test('a second OCR cannot erase strong contradictory numbers or use an enlarged proof outside the print',()=>{
 const first={exact:false,scope:'label',coverage:95,method:'phrase',recognizedText:'Сахар 75 г',diff:[{expected:'50',actual:'75',confidence:95}],boxes:[{x:.1,y:.1,w:.3,h:.1}]};
 const second={exact:true,scope:'label',recognizedText:'Сахар 50 г',boxes:[{x:.1,y:.1,w:.3,h:.1}]};
 assert.equal(fuseOcrMatches({r:first},{r:second}).r,first);
 const weak={...first,diff:[{expected:'50',actual:'75',confidence:30}]};
 assert.equal(fuseOcrMatches({r:weak},{r:{...second,scope:'proof'}}).r,weak);
 assert.equal(fuseOcrMatches({r:weak},{r:{...second,boxes:[{x:.7,y:.7,w:.2,h:.1}]}}).r,weak);
 assert.equal(fuseOcrMatches({r:weak},{r:{...second,exact:false}}).r,weak);
});

// ---- token by token ------------------------------------------------------------
const tok=(text,x,confidence=95,pass='one')=>({text,confidence,pass,rotation:0,box:{x,y:.2,w:.05,h:.02}});
const read=(words,label)=>matchRequirements([{id:'r',title:'Изготовитель',text:'Изготовитель ООО Компания Сябры Гомельская область',original:'',constraint:''}],words,'0,7',false,label,true);
test('two engines that err in different places confirm a phrase together, token by token',()=>{
 const label={x:0,y:0,w:1,h:1},xs=[.1,.16,.22,.28,.34,.40],texts=['Изготовитель','ООО','Компания','Сябры','Гомельская','область'];
 // The first engine reads the second word as digits (a weak look-alike); the second engine misreads the last word.
 const first=read(texts.map((text,i)=>tok(i===1?'000':text,xs[i],i===1?40:95)),label);
 const second=read(texts.map((text,i)=>tok(i===5?'облость':text,xs[i],92,'paddle:0')),label);
 assert.equal(first.r.exact,false);assert.equal(second.r.exact,false);
 const fused=fuseOcrMatches(first,second).r;
 assert.equal(fused.exact,true);assert.equal(fused.method,'independent-ocr');
 assert.deepEqual(fused.ocrEvidence.settled.map(item=>[item.expected,item.secondary.toLowerCase()]),[['ооо','ооо']],'the one word the first engine did not read, as the second read it');
 // The same reading of the second engine standing elsewhere on the label confirms nothing here.
 const elsewhere=read(texts.map((text,i)=>({...tok(text,xs[i],92,'paddle:0'),box:{x:xs[i],y:.7,w:.05,h:.02}})),label);
 assert.equal(fuseOcrMatches(first,elsewhere).r.exact,false);
 // A weak reading of the second engine confirms nothing either.
 const weak=read(texts.map((text,i)=>tok(text,xs[i],i===1?60:92,'paddle:0')),label);
 assert.equal(fuseOcrMatches(first,weak).r.exact,false);
});
test('engines sure of different readings leave the word uncertain: neither a match nor a difference',()=>{
 const label={x:0,y:0,w:1,h:1},rule=[{id:'r',title:'Сахар',text:'Сахар белый 50 грамм',original:'',constraint:''}];
 const match=words=>matchRequirements(rule,words,'0,7',false,label,true);
 const first=match(['Сахар','белый','75','грамм'].map((text,i)=>tok(text,.1+i*.06,95))),second=match(['Сахар','белый','50','грамм'].map((text,i)=>tok(text,.1+i*.06,95,'paddle:0')));
 const fused=fuseOcrMatches(first,second).r;
 assert.equal(fused.exact,false);assert.deepEqual(fused.diff.map(change=>[change.kind,change.expected,change.actual]),[['uncertain','50','75']]);
 const row=evaluate(rule,'Сахар белый 75 грамм',{automatic:{r:fused}})[0];assert.equal(row.comparison.status,'uncertain');assert.equal(row.statusLabel,'Неуверенное OCR');
 // When the second engine reads the same different number, the difference stands.
 const agreeing=match(['Сахар','белый','75','грамм'].map((text,i)=>tok(text,.1+i*.06,95,'paddle:0')));
 assert.equal(evaluate(rule,'Сахар белый 75 грамм',{automatic:{r:fuseOcrMatches(first,agreeing).r}})[0].statusLabel,'Проверить число');
});

// ---- single lines on sheets for the second engine -----------------------------
import {lineSheets,sheetWords} from '../src/paddle.js';
test('isolated lines are set on sheets with justified gaps closed, and detections return to their place on the page',()=>{
 // A line image 400 x 40: two words and, after a wide justified gap, a lone letter.
 const image={width:400,height:40,data:new Uint8ClampedArray(400*40*4).fill(255)},ink=(x0,x1)=>{for(let y=10;y<30;y++)for(let x=x0;x<x1;x++)image.data.fill(0,(y*400+x)*4,(y*400+x)*4+3);};
 ink(10,110);ink(125,200);ink(370,385);
 const line={image,region:{x:.2,y:.5,w:.4,h:.04},rotation:0,id:'line-7',cut:{}},[sheet]=lineSheets([line,{...line,id:'line-8',region:{x:.2,y:.56,w:.4,h:.04}}]);
 assert.equal(sheet.slots.length,2);
 const slot=sheet.slots[0],last=slot.pieces.at(-1),length=last.at+last.to-last.from;
 assert.equal(slot.pieces.length,2,'one gap wider than a word space');assert.ok(length<300,'most of the wide gap is left out');
 assert.ok(sheet.slots[1].y>=slot.y+slot.h+20,'wide leading between the lines');
 // The engine finds one box around the whole first line and one around the letter after the gap.
 const box=(x0,x1)=>[[x0,slot.y],[x1,slot.y],[x1,slot.y+slot.h],[x0,slot.y+slot.h]];
 const result={image:{width:sheet.width,height:sheet.height},items:[{text:'ДЕТЯМ И',score:.97,poly:box(slot.x,slot.x+slot.w)},{text:'И',score:.9,poly:box(slot.x+(last.at+2)*slot.scale,slot.x+slot.w)}]};
 const [whole,letter]=sheetWords(result,sheet,1);
 assert.equal(whole.line,'line-7');assert.equal(whole.pass,'paddle-line:0');
 assert.ok(Math.abs(whole.box.x-.2)<.002&&Math.abs(whole.box.w-.4)<.004,'the box spans the line as it stands on the page, the gap restored');
 assert.ok(Math.abs(letter.box.x-(.2+372/400*.4))<.004,'the lone letter is placed after the gap, where it is printed');
 // A word at an edge where the line was cut off cannot be trusted as a whole word.
 const [cut]=sheetWords(result,lineSheets([{...line,cut:{left:true}}])[0],1);assert.equal(cut.confidence,50);
});
