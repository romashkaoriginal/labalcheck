import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {detectFrames,matchRequirements} from '../src/automatic.js';
import {requirementsFromSource,dimensionChecks} from '../src/engine.js';
import {suggestedHeightMargin} from '../src/requirements.js';

test('real colour contours locate print and detached proof without fixed left/right placement',()=>{
 for(const [name,printX,proofX] of [['rose',.077,.077],['dolce',.079,.459]]){
  // Only chromatic pixels from the supplied production sheets are retained.
  // Text and the underlying artwork are excluded from this committed fixture.
  const data=gunzipSync(readFileSync(new URL(`./fixtures/san-rem-${name}-contours.rgba.gz`,import.meta.url)));
  const frames=detectFrames({data,width:849,height:1200});
  assert.ok(frames.some(frame=>Math.abs(frame.x-printX)<.01&&frame.w>.35&&frame.h>.18),`${name}: printed label`);
  assert.ok(frames.some(frame=>Math.abs(frame.x-proofX)<.01&&frame.w>.35&&frame.h>.14),`${name}: second panel`);
 }
});

test('mixed-colour die cut of the original sample is found beside the decorative panels',()=>{
 const data=gunzipSync(readFileSync(new URL('./fixtures/sample-contours.rgba.gz',import.meta.url)));
 const frames=detectFrames({data,width:1131,height:1200});
 assert.ok(frames.some(frame=>frame.x>.36&&frame.x<.38&&frame.y>.32&&frame.y<.35&&frame.w>.19&&frame.w<.20&&frame.h>.33));
});

test('wine-style table marks blank market sections and keeps the document-specific 0.1 mm advisory separate',()=>{
 const source={tables:[[
  ['Наименование элемента','Требования','Текст для нанесения на этикетку'],
  ['Наименование','Минимальная высота шрифта не менее 2 мм','Напиток «САН РЕМИНО. РОЗЕ»'],
  ['Маркетинговая информация','',''],
  ['Срок годности','Минимальная высота шрифта не менее 2 мм','Срок годности 24 месяца с даты розлива'],
  ['Объем','Термин объем: не менее 2 мм\nКоличество товара: не менее 4 мм','Объем 0,75 л']
 ]],paragraphs:['Высоту шрифта увеличивать хотя бы на 0,1 мм от указанного минимального размера.']};
 const rules=requirementsFromSource(source);
 assert.equal(rules.length,4);
 assert.equal(rules[1].text,'');assert.equal(rules[1].sourceReview,true);
 assert.ok(source.diagnostics.some(message=>message.includes('Маркетинговая информация')));
 assert.equal(suggestedHeightMargin(source.globalConditions),.1);
 assert.deepEqual(dimensionChecks(rules[3],.1).map(item=>[item.target,item.min]),[['quantity_label',2.1],['quantity',4.1]]);
});

test('12 months on the print cannot satisfy a 24-month Word rule or borrow 24 from enlarged proof',()=>{
 const rule={id:'r',title:'Срок годности',constraint:'',text:'Срок годности 24 месяца',original:'Срок годности 24 месяца'};
 const label={x:.08,y:.55,w:.38,h:.2};
 const word=(text,x)=>({text,confidence:97,box:{x,y:.62,w:.07,h:.015},rotation:0,pass:'print',line:'0'});
 const printed=['Срок','годности','12','месяцев'].map((text,i)=>word(text,.12+i*.08));
 const proof=['Срок','годности','24','месяца'].map((text,i)=>word(text,.58+i*.08));
 const match=matchRequirements([rule],[...printed,...proof],'0,75',false,label,true).r;
 assert.notEqual(match.exact,true);
 assert.ok(match.words.every(item=>item.box.x<label.x+label.w));
});

test('a changed long production code is shown from the same OCR line, not truncated after its prefix',()=>{
 const rule={id:'r',title:'Технологические стандарты',text:'СТБ 1122 РЦ BY 491315438.112',original:'СТБ 1122 РЦ BY 491315438.112',constraint:''};
 const make=(text,i)=>({text,confidence:96,box:{x:.08+i*.08,y:.4,w:.075,h:.02},pass:'print',line:'0'});
 const printed=['СТБ','1122','РЦ','BY','190239501.9-21.007'].map(make);
 const label={x:0,y:0,w:.6,h:1};
 const match=matchRequirements([rule],printed,'0,75',false,label,true).r;
 assert.equal(match.exact,false);
 assert.match(match.recognizedText,/190239501\.9-21\.007/);
 assert.ok(match.diff.some(change=>change.expected==='491315438.112'&&change.actual==='190239501.9-21.007'));
});

test('a barcode after a split production code cannot replace the code mismatch',()=>{
 const rule={id:'r',title:'Технологические стандарты',text:'СТБ 1122 РЦ BY 491315438.112',original:'СТБ 1122 РЦ BY 491315438.112',constraint:''};
 const printed=['СТБ','1122','РЦ','BY','190239501.9','-21.007','4813852005781'].map((text,i)=>({text,confidence:i===6?99:90,box:{x:.02+i*.1,y:.4,w:.09,h:.02},pass:'print',line:'0'}));
 const match=matchRequirements([rule],printed,'0,75',false,{x:0,y:0,w:.8,h:1},true).r;
 assert.ok(match.diff.some(change=>change.expected==='491315438.112'&&change.actual==='190239501.9-21.007'));
 assert.ok(!match.diff.some(change=>change.actual==='4813852005781'));
});
