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

test('all 17 personally reviewed sample sections keep their expected text evidence states',()=>{
 assert.equal(rows.length,17);
 const expected=['found','found','uncertain','uncertain','manual','uncertain','uncertain','uncertain','found','found','na','found','found','found','manual','found','uncertain'];
 rows.forEach((row,i)=>assert.equal(row.comparison.status,expected[i],row.title));
 for(const match of Object.values(matches))if(match?.scope==='label')assert.ok(match.words.every(word=>insideLabel(word.box,fixture.label)));
 assert.ok(rows.every(row=>row.status!=='pass'));
});

test('sample dimensions retain actual risks instead of converting found text to approval',()=>{
 for(const id of ['r0','r2','r3','r5','r6','r7'])assert.ok(rows.find(row=>row.id===id).dimensions[0].pass,id);
 const warning=rows[8];assert.equal(warning.statusLabel,'Проверить размеры');assert.ok(warning.dimensions[0].value>7&&warning.dimensions[0].value<8);assert.equal(warning.dimensions[0].min,10);
 const volume=rows[11];assert.equal(volume.quantity.status,'match');assert.equal(volume.quantity.actual.value,.7);assert.equal(volume.statusLabel,'Проверить размеры');assert.ok(volume.quantity.numberHeight>4);assert.ok(volume.quantity.unitHeight<4);
 assert.equal(matches.r13.method,'barcode');assert.equal(matches.r13.recognizedText,'4813852006269');
 assert.equal(rows[15].dimensions[1].value,null);assert.match(rows[15].dimensions[1].reason,/пустого окна/);
 assert.ok(rows[14].dimensions.every(d=>d.value===null&&d.reason));
});
