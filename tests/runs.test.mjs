import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {assess} from '../src/automatic.js';
import {evaluate} from '../src/engine.js';
import {linkClaims,verifyOnLabel,applyDeclaredDimensions,statedAreaShare} from '../src/callouts.js';

// Whole readings of three production sheets, saved from real browser runs by
// scripts/build-callout-fixture.mjs --runs: the words of both engines, the
// places that were looked at again and the callouts; no artwork pixels. They
// are judged here exactly as the page judges them. What a sheet really shows
// was checked by eye (AUDIT_SAMPLE.md, AUDIT_SAN_REMINO.md); these tests keep
// the program's answer from drifting away from it. They test the comparison,
// not the OCR: a fresh reading is checked by npm run test:browser.
const judged=name=>{
 const run=JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/run-${name}.json.gz`,import.meta.url)))),matches=assess({...run,page:run.image});
 applyDeclaredDimensions(matches,verifyOnLabel(linkClaims(run.calloutReadings,run.rules,run.volume),matches,run.image));
 return {run,matches,rows:evaluate(run.rules,run.actual,{volume:run.volume,automatic:matches})};
};
const states=rows=>Object.fromEntries(rows.map(row=>[row.id,row.comparison.status]));
const changes=match=>(match.diff||[]).map(change=>`${change.kind}${change.anchored?'!':''}:${change.expected}→${change.actual}`);

test('dense small print of the vodka sample: every section whose text is on the label is found, one is left unsure',()=>{
 const {matches,rows}=judged('sjabry'),reference=JSON.parse(readFileSync(new URL('./fixtures/sample-human-reference.json',import.meta.url),'utf8'));
 const state=states(rows),printed=reference.sections.filter(section=>section.text==='matches').map(section=>section.id);
 assert.equal(printed.length,13);
 // Before lines were read one by one, six of these thirteen were unsure.
 assert.deepEqual(printed.filter(id=>state[id]!=='found'),['r16'],'only the paragraph with the regulation codes stays unsure');
 assert.equal(state.r16,'uncertain','unsure is not a difference');
 assert.ok(!rows.some(row=>row.comparison.status==='partial'),'the label repeats Word: no difference may be reported');
 // Both turned lines of the shelf life, set tight beside the large warning; one word space is lost in the reading.
 assert.equal(state.r5,'found');assert.match(matches.r5.recognizedText.replace(/\s+/g,''),/СРОКГОДНОСТИНЕОГРАНИЧЕНПРИСОБЛЮДЕНИИУСЛОВИЙХРАНЕНИЯ/i);
 // "40 %" in large digits: read whole by the second engine where the first lost a digit.
 assert.equal(state.r9,'found');
 assert.deepEqual([state.r4,state.r10,state.r14],['manual','na','manual']);
 assert.ok(rows.every(row=>row.status!=='pass'),'finding text approves nothing');
 // Sizes keep their warnings: the unit letter of the volume and the share of the warning.
 assert.equal(rows.find(row=>row.id==='r11').statusLabel,'Проверить размеры');assert.equal(rows.find(row=>row.id==='r8').statusLabel,'Проверить размеры');
});

test('the vodka PDF wraps one 300 dpi picture: the raster step told is that of the picture',()=>{
 const {run,rows}=judged('sjabry');
 assert.ok(Math.abs(run.pdfRaster.dpi-300)<1);assert.ok(run.pdfRaster.coarser>1.4);
 const height=rows.find(row=>row.id==='r2').dimensions[0];
 assert.ok(Math.abs(height.meta.pixelStep-25.4/300)<.002,'not the 0.059 mm of the 432 dpi rendering');
 assert.ok(height.value>.8&&height.value<1&&height.borderline,'0.88 mm against a minimum of 0.8 mm stays borderline');
});

test('share of the warning on the vodka sample: the rectangle figure and the formula of the printer side by side',()=>{
 const {run,matches,rows}=judged('sjabry'),warning=rows.find(row=>row.id==='r8'),share=statedAreaShare(matches.r8,0,run.pageMm);
 assert.ok(warning.dimensions[0].value>6&&warning.dimensions[0].value<7.5,'rectangle over the whole contour');assert.equal(warning.dimensions[0].pass,false);
 assert.deepEqual([share.stated.inscription,share.stated.threshold,Math.round(share.stated.base)],[359.9,318.1,3181]);
 assert.ok(Math.abs(share.stated.share-11.3)<.05,'as the printer states it');
 assert.equal(share.inscriptionAgrees,true,'the measured rectangle agrees with the stated area of the inscription');
 assert.ok(share.mixed.share>10.5&&share.mixed.share<12.5,'measured inscription over the stated base');
 assert.ok(Math.abs(share.excluded.part-42.8)<1,'what the stated base leaves out of the contour');
});

test('Dolce: the clause inserted in the first line of the composition is shown and nothing printed is called missing',()=>{
 const {matches,rows}=judged('dolce'),state=states(rows),composition=changes(matches.r2);
 // The label adds "из сортов винограда европейско-азиатской группы" after "белый"; one word of it is misread, the clause is shown.
 assert.ok(composition.some(change=>/^extra:→из сортов .*европейскоазиатской группы$/.test(change)),composition.join(' | '));
 assert.ok(!composition.some(change=>change.startsWith('missing')),'"натуральный белый" and "углеводы" are printed and found');
 assert.ok(composition.includes('extra:→белый')&&composition.includes('replace:е 330→лимонная кислота'));
 assert.equal(rows.find(row=>row.id==='r2').statusLabel,'Отличие текста');
 // The address of the manufacturer is printed as in Word: unsure about ООО / 000 at most, never a difference.
 assert.ok(['found','uncertain'].includes(state.r3));assert.deepEqual(changes(matches.r3).filter(change=>!change.startsWith('uncertain')),[]);
 assert.ok(changes(matches.r5).includes('replace:24 месяца→12 месяцев'));
});

test('date caption of both wines: "номер партии" is not on the label, and the second look tells what stands there',()=>{
 for(const name of ['dolce','rose']){
  const {matches,rows}=judged(name),caption=matches.r14.diff.find(change=>change.expected==='номер партии');
  assert.equal(caption.anchored,true,`${name}: after the second look the words are known to be absent`);
  assert.equal(caption.edge.beside,'розлива');assert.ok(caption.edge.blank||caption.edge.seen.length>0);
  assert.equal(rows.find(row=>row.id==='r14').statusLabel,'Отличие текста',name);
 }
});

test('Rose: real differences stay, and words the second look read are reported, not called absent',()=>{
 const {matches,rows}=judged('rose'),state=states(rows);
 assert.deepEqual(changes(matches.r0),['extra:→ароматизированный']);
 assert.equal(state.r3,'found','the manufacturer is printed as in Word');
 const composition=matches.r2.diff;
 assert.equal(composition.filter(change=>change.kind==='extra'&&/из сортов винограда/.test(change.actual)).length,2,'the clause is inserted twice');
 assert.ok(composition.some(change=>change.kind==='replace'&&change.expected==='240'&&change.actual==='250'));
 const kcal=composition.find(change=>change.expected==='ккал');
 assert.ok(!kcal||!kcal.anchored,'"ккал" is printed: it may be unread, never absent');
 if(kcal)assert.match(kcal.edge.reread.join(' '),/ккал/,'and the second look read it');
});
