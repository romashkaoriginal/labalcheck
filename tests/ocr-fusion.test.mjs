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
 assert.deepEqual(rows.map(row=>row.comparison.status),['found','found','found','uncertain','manual','uncertain','found','uncertain','found','found','na','found','found','found','manual','found','uncertain']);
 assert.deepEqual(Object.entries(merged).filter(([,match])=>match?.method==='independent-ocr').map(([id])=>id),['r2','r6']);
 for(const id of ['r2','r6']){
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
