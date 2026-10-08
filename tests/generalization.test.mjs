import test from 'node:test';
import assert from 'node:assert/strict';
import {requirementsFromSource,dimensionChecks,evaluate} from '../src/engine.js';
import {inkLineAreas,detectFrames,matchRequirements,wordsFromOcr} from '../src/automatic.js';
import {pageReadingBox,locatePhrase,refinementLines} from '../src/phrase.js';
import {quantityReadAreas} from '../src/quantity.js';

test('permuted and two-column tables use headers, headerless data keeps the first row',()=>{
 const a=requirementsFromSource({tables:[[['Текст этикетки','Условия','Раздел'],['Вино сухое','не менее 2 мм','Название']]]});
 assert.equal(a[0].title,'Название');assert.equal(a[0].text,'Вино сухое');assert.equal(a[0].constraint,'не менее 2 мм');
 const b=requirementsFromSource({tables:[[['Раздел','Текст'],['Состав','Виноград']]]});assert.equal(b[0].text,'Виноград');assert.equal(b[0].constraint,'');
 const source={tables:[[['Состав','не менее 0,8 мм','Вода, спирт']]]};assert.equal(requirementsFromSource(source)[0].text,'Вода, спирт');assert.ok(source.diagnostics.length);
});

test('plain-text sections and DOCX headings keep instructions apart from literal copy',()=>{
 const source={paragraphs:['Маркировка должна быть читаемой.','Раздел: Наименование','Текст: Виски выдержанный','Требования: не менее 2 мм','Раздел: Состав','Текст: Вода, дистиллят.','Высота шрифта: не менее 0,8 мм','*** Дополнительная надпись.']};
 const rules=requirementsFromSource(source);assert.equal(rules.length,3);assert.equal(rules[0].text,'Виски выдержанный');assert.match(rules[1].constraint,/0,8/);assert.equal(source.globalConditions[0],'Маркировка должна быть читаемой.');assert.equal(rules[2].extra,true);
 const heading=requirementsFromSource({blocks:[{type:'paragraph',heading:true,text:'Настойка'},{type:'paragraph',text:'Текст: Настойка горькая'},{type:'paragraph',text:'Требования: Высота не менее 2 мм'}]});assert.equal(heading[0].text,'Настойка горькая');
 const bare=requirementsFromSource({paragraphs:['Наименование:','Вино столовое сухое','Высота шрифта не менее 2 мм']});assert.equal(bare[0].text,'Вино столовое сухое');assert.match(bare[0].constraint,/2 мм/);
});

test('unmarked prose and unsupported tables are preserved without inventing expected copy',()=>{
 const source={paragraphs:['Требуется указать страну и изготовителя; точный текст согласовать.']};const rules=requirementsFromSource(source);assert.equal(rules[0].text,'');assert.equal(rules[0].sourceReview,true);assert.ok(source.diagnostics.length);
 const table=requirementsFromSource({tables:[[['Проверить знаки','Сверить с оригиналом']]]});assert.equal(table[0].text,'');assert.match(table[0].constraint,/Сверить/);
});

test('quantity and date targets follow captions even when threshold order changes',()=>{
 const q=dimensionChecks({title:'Объем',constraint:'Количество товара: не менее 4 мм; буквы термина: не менее 2 мм'});assert.deepEqual(q.map(d=>[d.target,d.min]),[['quantity',4],['quantity_label',2]]);
 const d=dimensionChecks({title:'Окно даты',constraint:'Цифры: не менее 2 мм; буквы: не менее 0,8 мм. Формат: 42 × 11 мм'});assert.deepEqual(d.map(x=>[x.target,x.min]),[['date_digits',2],['date_label',.8]]);
 assert.deepEqual(dimensionChecks({title:'Объем',constraint:'Цифры не более 4 мм'}),[]);
 const parenthetic=dimensionChecks({title:'Окно даты',constraint:'Минимальная высота - не менее 0,8 мм (шрифт букв) и 2,0 мм (шрифт самих цифр). Формат: 42x11 или 49x6 мм'});
 assert.deepEqual(parenthetic.map(x=>[x.target,x.min]),[['date_label',.8],['date_digits',2]]);
});

test('quantity crops follow rotated captions instead of fixed page directions',()=>{
 const label={x:0,y:0,w:1,h:1};for(const rotation of [0,90,180,270]){const box=rotation%180?{x:.4,y:.4,w:.03,h:.1}:{x:.4,y:.4,w:.1,h:.03},areas=quantityReadAreas([{text:'Объем',confidence:95,box,rotation,pageAspect:1}],label,true);assert.equal(areas.length,2);assert.ok(areas.every(a=>a.rotation===rotation));}
});

const phrase='Хранить плотно закрытым';
test('entire blocks can change sides and orientation without changing the verdict',()=>{
 const rule={id:'r',title:'Хранение',text:phrase,original:phrase,constraint:''};
 for(const rotation of [0,90,180,270])for(const side of [.1,.6]){
  const words=phrase.split(' ').map((text,i)=>{const box=rotation%180?{x:side,y:.15+i*.1,w:.025,h:.09}:{x:side+i*.09,y:.2,w:.08,h:.025};return {text,confidence:95,pass:'a',rotation,box,readingBox:pageReadingBox(box,rotation,1),line:'0'};});
  // Reverse the source order for 180/90, as the printed line now reads backwards on screen.
  if(rotation===90||rotation===180)words.forEach((w,i)=>w.text=phrase.split(' ').at(-i-1));
  const match=matchRequirements([rule],words.reverse(),'0,7',false,{x:0,y:0,w:1,h:1},true).r;assert.equal(match.exact,true,`${rotation}, ${side}`);
 }
});

test('row projection separates lines in a new location and maps a rotated crop back',()=>{
 const width=160,height=70,data=new Uint8ClampedArray(width*height*4).fill(255);
 for(const yy of [8,30,52])for(let y=yy;y<yy+10;y++)for(let x=8;x<150;x++){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
 const region={x:.6,y:.2,w:.3,h:.5};for(const rotation of [0,90,180,270]){const areas=inkLineAreas({data,width,height},region,rotation);assert.equal(areas.length,3);assert.ok(areas.every(a=>a.x>=region.x&&a.y>=region.y&&a.x+a.w<=region.x+region.w+.0001&&a.y+a.h<=region.y+region.h+.0001));}
});

test('die-cut boundaries can use cyan instead of magenta',()=>{
 const width=200,height=300,data=new Uint8ClampedArray(width*height*4).fill(255);
 const cyan=(x,y)=>{const i=(y*width+x)*4;data[i]=20;data[i+1]=220;data[i+2]=240;};
 for(let x=30;x<=160;x++){cyan(x,50);cyan(x,250);}for(let y=50;y<=250;y++){cyan(30,y);cyan(160,y);}
 assert.ok(detectFrames({data,width,height}).some(f=>Math.abs(f.x-.15)<.01&&Math.abs(f.w-.65)<.01));
});

test('short chromatic decorations cannot create zero-height contour candidates',()=>{
 const width=500,height=500,data=new Uint8ClampedArray(width*height*4).fill(255);
 const pink=(x,y)=>{const i=(y*width+x)*4;data[i]=240;data[i+1]=30;data[i+2]=180;};
 for(let x=60;x<=360;x++){pink(x,100);pink(x,120);}for(let y=100;y<=120;y++){pink(60,y);pink(360,y);}
 assert.ok(detectFrames({data,width,height}).every(f=>f.w>0&&f.h>=.04));
});

test('source raster resolution stays honest after upscaling and a near threshold needs review',()=>{
 const rule={id:'r',title:'Имя',text:'Водка',original:'Водка',constraint:'не менее 0,8 мм'};
 const words=[{text:'Водка',confidence:95,box:{x:.1,y:.1,w:.1,h:.02},sourcePixelMm:.06,mmPerPixel:.015,glyphs:[{text:'В',height:.84},{text:'о',height:.84}]}];
 const automatic=matchRequirements([rule],words,'0,7',false,{x:0,y:0,w:1,h:1},true),row=evaluate([rule],'Водка',{automatic})[0];
 assert.equal(row.dimensions[0].meta.pixelStep,.06);assert.equal(row.dimensions[0].borderline,true);assert.equal(row.statusLabel,'Пограничный замер');
});

test('a low-confidence number cannot become exact merely by matching the requirements',()=>{
 const words=['Крепость','40','%'].map((text,i)=>({text,confidence:i===1?30:96,box:{x:.1+i*.1,y:.1,w:.09,h:.025},pass:'raw'}));
 assert.equal(locatePhrase('Крепость 40%',words).exact,false);
});

test('similar letter shapes stay visible as ambiguity instead of being silently replaced',()=>{
 const words=['Срок','голности'].map((text,i)=>({text,confidence:96,box:{x:.1+i*.15,y:.1,w:.14,h:.025},pass:'raw'}));
 const match=locatePhrase('Срок годности',words);assert.equal(match.exact,false);assert.equal(match.diff[0].actual,'голности');assert.equal(match.diff[0].confidence,0);
});

test('baseline crops remain available when a vertical neighbour obstructs ink projection',()=>{
 const words=['Хранить','плотно','закрытым','Упаковка','открыта'].map((text,i)=>({text,confidence:90,rotation:0,box:{x:.2+i%3*.12,y:.2+Math.floor(i/3)*.04,w:.1,h:.025}}));
 const areas=refinementLines({r:{words,exact:false,coverage:90,rotation:0}});assert.equal(areas.length,2);assert.ok(areas.every(a=>a.h<.04));
});

test('known raster heights are converted without using font size or requirement minimum',()=>{
 const width=80,height=90,data=new Uint8ClampedArray(width*height*4).fill(255);
 for(const [x,y,w,h] of [[3,5,10,8],[25,5,12,20],[48,5,12,40]])for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){const i=(yy*width+xx)*4;data[i]=data[i+1]=data[i+2]=0;}
 const bbox={x0:0,y0:0,x1:80,y1:90},symbols=[[0,20],[22,42],[45,70]].map(([x0,x1],i)=>({text:'АБВ'[i],confidence:95,bbox:{x0,x1,y0:0,y1:60}}));
 const input={blocks:[{paragraphs:[{lines:[{words:[{text:'АБВ',confidence:95,bbox,symbols}]}]}]}]};
 const glyphs=wordsFromOcr(input,{x:0,y:0,w:1,h:1},width,height,0,.1,'test',{data,width,height})[0].glyphs;
 assert.deepEqual(glyphs.map(g=>g.height),[.8,2,4]);
});
