import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {matchRequirements} from '../src/automatic.js';
import {evaluate} from '../src/engine.js';
import {insideLabel} from '../src/quantity.js';

const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/sample-ocr.json.gz',import.meta.url))));
const matches=matchRequirements(fixture.rules,fixture.words,'0,7',false,fixture.label,true);
const rows=evaluate(fixture.rules,fixture.words.map(word=>word.text).join(' '),{automatic:matches});
const humanReference=JSON.parse(readFileSync(new URL('./fixtures/sample-human-reference.json',import.meta.url),'utf8'));

test('saved OCR fixture preserves its current observed text evidence states',()=>{
 assert.equal(rows.length,17);
 const expected=['found','found','uncertain','uncertain','manual','uncertain','uncertain','uncertain','found','found','na','found','found','found','manual','found','uncertain'];
 rows.forEach((row,i)=>assert.equal(row.comparison.status,expected[i],row.title));
 for(const match of Object.values(matches))if(match?.scope==='label')assert.ok(match.words.every(word=>insideLabel(word.box,fixture.label)));
 assert.ok(rows.every(row=>row.status!=='pass'));
});

test('independent human reference covers every section and exposes OCR misses',()=>{
 const fresh=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/sample-lines-ocr.json.gz',import.meta.url))));
 const automatic=matchRequirements(fresh.rules,fresh.words,'0,7',false,fresh.label,true);
 const observed=evaluate(fresh.rules,fresh.actual,{automatic});
 assert.equal(humanReference.sections.length,17);
 assert.deepEqual(humanReference.sections.map(section=>section.id),observed.map(row=>row.id));
 assert.ok(humanReference.sections.every(section=>section.evidence&&section.physical));
 assert.equal(humanReference.sections.filter(section=>section.text==='matches').length,13);
 assert.equal(humanReference.sections.find(section=>section.id==='r15').text,'date_sample_missing');
 for(const section of humanReference.sections.filter(section=>section.text==='matches')){
  const status=observed.find(row=>row.id===section.id).comparison.status;
  assert.ok(['found','uncertain'].includes(status),`${section.name}: text exists on the printed sample, got ${status}`);
 }
 assert.equal(observed.find(row=>row.id==='r4').comparison.status,'manual');
 assert.equal(observed.find(row=>row.id==='r10').comparison.status,'na');
 assert.equal(observed.find(row=>row.id==='r14').comparison.status,'manual');
 assert.equal(observed.find(row=>row.id==='r15').comparison.status,'found');
 const unresolved=humanReference.sections.filter(section=>section.text==='matches'&&observed.find(row=>row.id===section.id).comparison.status!=='found');
 assert.ok(unresolved.length<=6,`OCR regressed against the visual reference: ${unresolved.map(section=>section.id).join(', ')}`);
 assert.ok(observed.every(row=>row.status!=='pass'));
 for(const id of ['r8','r11']){
  assert.equal(humanReference.sections.find(section=>section.id===id).physical,'below_minimum_estimate');
  assert.equal(observed.find(row=>row.id===id).statusLabel,'Проверить размеры');
 }
 assert.equal(observed.find(row=>row.id==='r15').dimensions[1].value,null);
 assert.ok(observed.find(row=>row.id==='r14').dimensions.every(item=>item.value===null));
});

test('sample dimensions retain actual risks instead of converting found text to approval',()=>{
 for(const id of ['r0','r2','r3','r5','r6','r7'])assert.ok(rows.find(row=>row.id===id).dimensions[0].pass,id);
 const warning=rows[8];assert.equal(warning.statusLabel,'Проверить размеры');assert.ok(warning.dimensions[0].value>7&&warning.dimensions[0].value<8);assert.equal(warning.dimensions[0].min,10);
 const volume=rows[11];assert.equal(volume.quantity.status,'match');assert.equal(volume.quantity.actual.value,.7);assert.equal(volume.statusLabel,'Проверить размеры');assert.ok(volume.quantity.numberHeight>4);assert.ok(volume.quantity.unitHeight<4);
 assert.equal(matches.r13.method,'barcode');assert.equal(matches.r13.recognizedText,'4813852006269');
 assert.equal(rows[15].dimensions[1].value,null);assert.match(rows[15].dimensions[1].reason,/пустого окна/);
 assert.ok(rows[14].dimensions.every(d=>d.value===null&&d.reason));
});

test('fresh line rereads preserve all sections, real quantities and date targets without claiming approval',()=>{
 const fresh=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/sample-lines-ocr.json.gz',import.meta.url)))),automatic=matchRequirements(fresh.rules,fresh.words,'0,7',false,fresh.label,true),result=evaluate(fresh.rules,fresh.actual,{automatic});
 assert.equal(result.length,17);assert.equal(result.filter(r=>r.comparison.status==='found').length,8);assert.equal(result.filter(r=>r.comparison.status==='uncertain').length,6);
 assert.ok(result.every(r=>r.status!=='pass'));assert.equal(result[11].quantity.status,'match');assert.equal(result[11].quantity.actual.value,.7);assert.ok(result[11].dimensions[1].value<4);
 assert.equal(result[8].dimensions[0].meta.method,'rectangle');assert.ok(result[8].dimensions[0].value>7&&result[8].dimensions[0].value<8);
 assert.equal(result[15].dimensions[0].target,'date_label');assert.ok(result[15].dimensions[0].value>=.8);assert.equal(result[15].dimensions[1].value,null);assert.match(result[15].dimensions[1].reason,/пустого окна/);
 assert.ok(result[2].dimensions[0].meta.pixelStep>.03);assert.ok(result[2].dimensions[0].borderline);
 assert.ok(fresh.words.some(w=>w.pass?.startsWith('baselines')));
});
