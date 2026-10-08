import test from 'node:test';
import assert from 'node:assert/strict';
import {annotationMask,sizesFromOcr,dedupeSizes,linkDeclaredSizes,applyDeclaredDimensions} from '../src/annotations.js';
import {dimensionChecks} from '../src/engine.js';

const line=(text,bbox,confidence=95)=>({bbox,words:text.split(' ').map(word=>({text:word,confidence}))});
const ocr=lines=>({blocks:[{paragraphs:[{lines}]}]});
test('the coloured callout is read as an assertion; window formats are not text heights',()=>{
 const pixels={width:2,height:1,data:new Uint8ClampedArray([245,50,150,255,0,0,0,255])};
 const mask=annotationMask(pixels);assert.equal(mask.count,1);assert.equal(mask.data[0],0);assert.equal(mask.data[4],255);
 const readings=sizesFromOcr(ocr([line('2.52 гот',{x0:10,y0:10,x1:80,y1:30}),line('2.23 пт',{x0:10,y0:70,x1:80,y1:90}),line('49x6 mm',{x0:100,y0:10,x1:180,y1:30}),line('5.1 mm*5.1 mm',{x0:10,y0:40,x1:200,y1:60})]),0,200,100);
 assert.deepEqual(readings.map(reading=>reading.value),[2.52,2.23]);
 assert.equal(dedupeSizes([...readings,...readings]).length,2);
});
test('a nearby named inscription links its declared height to the matching Word rule',()=>{
 const rules=[{id:'name',title:'Наименование',text:'Напиток слабоалкогольный Сан Ремино Розе',original:'Напиток слабоалкогольный Сан Ремино Розе',constraint:'Высота шрифта не менее 2 мм'},
  {id:'warning',title:'Обязательная надпись',text:'Чрезмерное употребление алкоголя вредит здоровью',original:'Чрезмерное употребление алкоголя вредит здоровью',constraint:'Высота шрифта не менее 4 мм'}];
 const reading={value:2.52,box:{x:.5,y:.5,w:.02,h:.03},confidence:94};
 const lines=[{text:'НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ САН РЕМИНО РОЗЕ',box:{x:.53,y:.5,w:.35,h:.02}},
  {text:'ЧРЕЗМЕРНОЕ УПОТРЕБЛЕНИЕ АЛКОГОЛЯ',box:{x:.53,y:.8,w:.35,h:.02}}];
 const [linked]=linkDeclaredSizes([reading],lines,rules,'0,75');
 assert.equal(linked.ruleId,'name');assert.equal(linked.minimum,2);assert.equal(linked.passes,true);
 const [unlinked]=linkDeclaredSizes([reading],[],rules,'0,75');assert.equal(unlinked.ruleId,null);
});
test('two font minima from one prose requirement stay distinct',()=>{
 const rule={title:'Срок годности, условия хранения',constraint:'Минимальная высота шрифта для срока годности - не менее 2,0 мм; для остального текста - не менее 0,8 мм'};
 assert.deepEqual(dimensionChecks(rule).map(check=>[check.label,check.min]),[['Срок годности',2],['Остальной текст',.8]]);
});
test('a confidently linked callout fills a missing estimate but conflicts stay unmeasured',()=>{
 const matches={name:{dimensions:[null],measurementNotes:[''],measurementMeta:[null]}};
 const a={ruleId:'name',checkIndex:0,value:2.52,confidence:95};
 applyDeclaredDimensions(matches,[a]);
 assert.equal(matches.name.dimensions[0],2.52);
 assert.equal(matches.name.measurementMeta[0].method,'declared');
 const conflict={name:{dimensions:[null],measurementNotes:[''],measurementMeta:[null]}};
 applyDeclaredDimensions(conflict,[a,{...a,value:1.8}]);
 assert.equal(conflict.name.dimensions[0],null);
 assert.match(conflict.name.measurementNotes[0],/разные значения/);
});
