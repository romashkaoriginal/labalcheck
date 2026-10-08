import test from 'node:test';
import assert from 'node:assert/strict';
import {imageDensity,resolveScale,declaredLabelSize} from '../src/scale.js';
import {detectFrames,refineFrame,matchRequirements,typicalHeight} from '../src/automatic.js';
import {locatePhrase} from '../src/phrase.js';
import {quantities,equivalentNotations} from '../src/quantity.js';
import {evaluate,scopeIndex,dimensionChecks,requirementsFromSource} from '../src/engine.js';
import {raisedText} from '../src/requirements.js';

// ---- physical scale of an image ---------------------------------------------
const jpeg=(...segments)=>Uint8Array.from([0xFF,0xD8,...segments.flat(),0xFF,0xDA,0,2,...new Array(24).fill(0)]);
const jfif=(unit,x,y)=>[0xFF,0xE0,0,16,0x4A,0x46,0x49,0x46,0,1,1,unit,x>>8,x&255,y>>8,y&255,0,0];
function exif(x,y,unit){
 const tiff=new Uint8Array(8+2+36+4+16),view=new DataView(tiff.buffer);
 tiff.set([0x49,0x49,0x2A,0],0);view.setUint32(4,8,true);view.setUint16(8,3,true);
 const entry=(i,tag,type,value)=>{const at=10+i*12;view.setUint16(at,tag,true);view.setUint16(at+2,type,true);view.setUint32(at+4,1,true);view.setUint32(at+8,value,true);};
 entry(0,0x011A,5,50);entry(1,0x011B,5,58);entry(2,0x0128,3,unit);
 view.setUint32(50,x,true);view.setUint32(54,1,true);view.setUint32(58,y,true);view.setUint32(62,1,true);
 const length=2+6+tiff.length;return [0xFF,0xE1,length>>8,length&255,0x45,0x78,0x69,0x66,0,0,...tiff];
}
function png(perMetre){
 const bytes=new Uint8Array(8+25+21+12),view=new DataView(bytes.buffer);
 bytes.set([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A],0);view.setUint32(8,13);bytes.set([73,72,68,82],12);
 view.setUint32(33,9);bytes.set([112,72,89,115],37);view.setUint32(41,perMetre);view.setUint32(45,perMetre);bytes[49]=1;
 bytes.set([73,69,78,68],58);return bytes;
}
test('resolution is read from JFIF, Exif and PNG headers, and absent or absurd values are not invented',()=>{
 assert.deepEqual(imageDensity(jpeg(jfif(1,300,300))),{x:300,y:300});
 assert.deepEqual(imageDensity(jpeg(jfif(2,118,118))).x.toFixed(0),'300','dots per centimetre');
 assert.equal(imageDensity(jpeg(jfif(0,1,1))),null,'aspect ratio only');
 assert.deepEqual(imageDensity(jpeg(jfif(1,72,72),exif(300,300,2))),{x:300,y:300},'the exporting application overrides a default');
 assert.equal(Math.round(imageDensity(png(11811)).x),300);
 assert.equal(imageDensity(jpeg(jfif(1,1,1))),null);
 assert.equal(imageDensity(new Uint8Array(40)),null);
});
test('an image is measured only when the stated label size agrees with the found contour',()=>{
 const contour={w:945,h:708};
 const confirmed=resolveScale({density:{x:300,y:300},contour,declared:[60,80]});
 assert.deepEqual([confirmed.source,confirmed.level,confirmed.label.width.toFixed(1),confirmed.label.height.toFixed(1)],['density+declared','high','80.0','59.9']);
 // A default 72 dpi that contradicts the stated size is not believed.
 const derived=resolveScale({density:{x:72,y:72},contour,declared:[60,80]});
 assert.deepEqual([derived.source,derived.level],['declared','medium']);assert.ok(Math.abs(derived.mmPerPixel-.0847)<.001);
 assert.equal(resolveScale({density:null,contour,declared:[80,60]}).source,'declared','the order of the stated sides does not matter');
 // The contour of another panel has other proportions: no scale at all.
 assert.equal(resolveScale({density:{x:300,y:300},contour:{w:1002,h:519},declared:[60,80]}).mmPerPixel,null);
 const unknown=resolveScale({density:{x:300,y:300},contour,declared:null});
 assert.equal(unknown.mmPerPixel,null);assert.match(unknown.reason,/300 dpi.*не подтверждён/);
 assert.match(resolveScale({density:null,contour:null,declared:[60,80]}).reason,/Контур этикетки не найден/);
});
test('the stated label size is the W×H beside or below its caption in the order table',()=>{
 const line=(text,x,y,w=.12)=>({text,box:{x,y,w,h:.012}});
 assert.deepEqual(declaredLabelSize([line('Размер этикетки:',.08,.17),line('60.00x80.00',.24,.17,.07),line('Тираж, шт.:',.08,.2),line('23000',.24,.2,.04),line('Формат: 42х11 или 49х6',.6,.8)]),[60,80]);
 assert.deepEqual(declaredLabelSize([line('РАЗМЕР ГОТОВОЙ ПРОДУКЦИИ',.1,.8),line('(ШИРИНА/ВЫСОТА, ММ):',.1,.812),line('103x54',.11,.83,.06),line('4+0',.22,.83,.03)]),[103,54]);
 assert.deepEqual(declaredLabelSize('Размер этикетки: 54х103 мм'),[54,103]);
 assert.equal(declaredLabelSize([line('Окно даты',.1,.1),line('49x6',.3,.1)]),null,'a size without the label caption is not the label');
 assert.equal(declaredLabelSize('Диаметр рулона 300'),null);
});

// ---- contours in other arrangements -------------------------------------------
function canvas(width,height){
 const data=new Uint8ClampedArray(width*height*4).fill(255);
 const fill=(x0,y0,x1,y1,[r,g,b])=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*width+x)*4;data[i]=r;data[i+1]=g;data[i+2]=b;}};
 const frame=(x0,y0,x1,y1,color,t=3)=>{fill(x0,y0,x1,y0+t,color);fill(x0,y1-t,x1,y1,color);fill(x0,y0,x0+t,y1,color);fill(x1-t,y0,x1,y1,color);};
 return {data,width,height,fill,frame};
}
const MAGENTA=[228,0,120],CYAN=[0,160,230];
const near=(frame,box,width,height)=>Math.abs(frame.x*width-box[0])<8&&Math.abs(frame.y*height-box[1])<10&&Math.abs((frame.x+frame.w)*width-box[2])<8&&Math.abs((frame.y+frame.h)*height-box[3])<10;
test('a label beside a filled panel is found on either side, and their joint outline is not a label',()=>{
 for(const [name,labelBox,panelBox] of [['label left',[70,500,390,740],[401,500,721,740]],['mirrored',[401,500,721,740],[70,500,390,740]],['label above',[200,300,560,540],[200,600,560,840]],['label below',[200,600,560,840],[200,300,560,540]]]){
  const sheet=canvas(850,1200);
  sheet.fill(labelBox[0],labelBox[1],labelBox[2],labelBox[3],[240,222,182]);sheet.frame(...labelBox,MAGENTA);   // printed label on a tinted stock
  sheet.fill(panelBox[0],panelBox[1],panelBox[2],panelBox[3],CYAN);sheet.frame(...panelBox,MAGENTA);          // varnish panel filled edge to edge
  const frames=detectFrames(sheet);
  assert.ok(frames.some(frame=>near(frame,labelBox,850,1200)),`${name}: the label contour`);
  assert.ok(frames.some(frame=>near(frame,panelBox,850,1200)),`${name}: the panel contour`);
  assert.ok(!frames.some(frame=>frame.w*850>500||frame.h*1200>400),`${name}: no frame spans both panels`);
 }
});
test('an edge found on a bleed band is moved onto the die-cut line drawn in its own ink',()=>{
 const sheet=canvas(1000,1400);
 sheet.fill(100,715,700,775,[236,150,190]);            // paler band of the artwork running past the cut
 sheet.frame(100,300,700,750,MAGENTA);
 const refined=refineFrame(sheet,{x:.1,y:300/1400,w:.6,h:(718-300)/1400});
 assert.ok(Math.abs((refined.y+refined.h)*1400-750)<=3,'bottom edge on the die-cut');
 assert.ok(Math.abs(refined.x*1000-100)<=3&&Math.abs((refined.x+refined.w)*1000-700)<=3);
 // Nothing is drawn in a saturated ink: the frame is returned unchanged.
 const plain=canvas(400,400),frame={x:.1,y:.1,w:.5,h:.5};assert.deepEqual(refineFrame(plain,frame),frame);
});

// ---- measuring and comparing text on the label --------------------------------
const label={x:0,y:0,w:1,h:1};
const words=(texts,{y=.2,x=.05,glyph=null,confidence=95,pass='print',rotation=0,step=.07}={})=>texts.map((text,i)=>({text,confidence,rotation,pass,line:`${pass}:${y}`,box:{x:x+i*step,y,w:step*.85,h:.02},sourcePixelMm:.06,glyphs:glyph?[...text.replace(/[^\p{L}\p{N}]/gu,'')].map(char=>({text:char,height:glyph})):[]}));
test('each of several minima of one rule is measured on its own sentences',()=>{
 const rule={id:'r',title:'Срок годности, условия хранения',constraint:'Минимальная высота шрифта для указания срока годности – не менее 2,0 мм\nДля условий хранения – не менее 0,8 мм',text:'Срок годности 12 месяцев с даты розлива.\nХранить при температуре воздуха от нуля градусов.'};rule.original=rule.text;
 const printed=[...words(['Срок','годности','12','месяцев','с','даты','розлива.'],{y:.3,glyph:2.2}),...words(['Хранить','при','температуре','воздуха','от','нуля','градусов.'],{y:.4,glyph:.9})];
 const match=matchRequirements([rule],printed,'0,75',false,label,true).r;
 assert.deepEqual(match.dimensions,[2.2,.9]);
 assert.deepEqual(dimensionChecks(rule).map(check=>check.label),['Срок годности','Для условий хранения']);
 // Without a contour nothing on the sheet can be told from an enlarged sample.
 assert.deepEqual(matchRequirements([rule],printed,'0,75',false,null,false).r.dimensions,[null,null]);
});
test('one broken glyph box does not lower a section, two small words do',()=>{
 const body=words(['вода','питьевая','сахар','белый','экстракт','винограда','консервант','кислота'],{glyph:.95});
 assert.equal(typicalHeight([...body,...words(['ккал'],{glyph:.4})]),.95);
 assert.equal(typicalHeight([...body,...words(['мелкий','шрифт'],{glyph:.4})]),.4);
 assert.equal(typicalHeight(words(['Водка','Сябры'],{glyph:2.2}).concat(words(['л'],{glyph:1}))),2.2,'a single letter has no typical height');
});
test('a reading chosen for its text borrows heights from another reading of the same word at the same place',()=>{
 const rule={id:'r',title:'Наименование',constraint:'не менее 2 мм',text:'Водка Сябры',original:'Водка Сябры'};
 const sure=words(['Водка','Сябры'],{confidence:97,pass:'turned'}),measured=words(['Водка','Сябры'],{confidence:86,pass:'upright',glyph:2.2});
 assert.equal(matchRequirements([rule],[...sure,...measured],'0,7',false,label,true).r.dimensions[0],2.2);
 const elsewhere=words(['Водка','Сябры'],{confidence:86,pass:'proof',glyph:5,y:.7});
 assert.equal(matchRequirements([rule],[...sure,...elsewhere],'0,7',false,{x:0,y:0,w:1,h:.5},true).r.dimensions[0],null,'a larger sample elsewhere is not this word');
});
test('a word of Word is called absent only where the print between its neighbours is empty',()=>{
 const expected='напиток слабоалкогольный допускается хранить плотно закрытым';
 const printed=words(['напиток','слабоалкогольный','хранить','плотно','закрытым'],{step:.12});
 const gap=locatePhrase(expected,printed).diff;
 assert.deepEqual(gap.map(change=>[change.kind,change.expected,change.anchored]),[['missing','допускается',true]]);
 // The same reading, but a second pass saw unread ink between the neighbours.
 const blot=[...printed.map((word,i)=>i>=2?{...word,box:{...word.box,x:word.box.x+.12}}:word),{text:'дoпyc',confidence:41,rotation:0,pass:'second',line:'x',box:{x:.29,y:.2,w:.1,h:.02},glyphs:[]}];
 assert.equal(locatePhrase(expected,blot).diff[0].anchored,undefined);
 // Words missing at the end of a reading may simply be unread.
 assert.equal(locatePhrase('дата розлива номер партии',words(['дата','розлива'])).diff[0].anchored,undefined);
});
test('look-alike characters and a digit lost at the edge are uncertain readings, not differences',()=>{
 const diffOf=(expected,printed)=>locatePhrase(expected,words(printed)).diff.map(change=>[change.kind,change.expected,change.actual]);
 assert.deepEqual(diffOf('регулятор кислотности Е330 консервант Е202',['регулятор','кислотности','ЕЗЗО','консервант','Е202']),[['uncertain','е 330','еззо']]);
 assert.deepEqual(diffOf('регулятор кислотности Е330 консервант Е202',['регулятор','кислотности','ЕЗЗ','0','консервант','Е202']),[['uncertain','е 330','езз 0']],'wherever OCR split it');
 assert.deepEqual(diffOf('Крепость 40 %',['Крепость','0','%']),[['uncertain','40','0']]);
 assert.deepEqual(diffOf('Срок годности 24 месяца',['Срок','годности','12','месяца']),[['replace','24','12']],'another number stays a difference');
 // Latin BY and Cyrillic ВУ are the same print.
 assert.equal(locatePhrase('РЦ ВУ 190239501',words(['РЦ','BY','190239501'])).exact,true);
});
test('a concentration is not an amount of product, and an equivalent unit spelling is flagged, not failed',()=>{
 assert.deepEqual(quantities('САХАР 75 Г/Л'),[]);
 assert.deepEqual(quantities('САХАР 75 Г/Л ОБЪЕМ 0,75 Л').map(q=>q.text),['0,75 л']);
 assert.deepEqual(equivalentNotations('Сахар 75 г/дм3').map(item=>item.text),['Сахар 75 г/л']);
 assert.deepEqual(equivalentNotations('Алкоголь противопоказан детям'),[]);
 const sugar={id:'s',title:'Массовая концентрация сахаров',constraint:'',text:'Сахар 75 г/дм3',original:'Сахар 75 г/дм3'},volume={id:'v',title:'Объем',constraint:'',text:'Объем 0,75 л',original:'Объем 0,75 л'};
 const printed=words(['САХАР','75','Г','/Л','ОБЪЕМ','0,75','Л'],{glyph:4.1}),automatic=matchRequirements([sugar,volume],printed,'0,75',false,label,true);
 assert.equal(automatic.s.exact,true);assert.deepEqual(automatic.s.notation,{expected:'дм³',printed:'л'});
 assert.equal(automatic.v.quantity.status,'match');assert.equal(automatic.v.quantity.actual.text,'0,75 л');
 const rows=evaluate([sugar,volume],printed.map(word=>word.text).join(' '),{volume:'0,75',automatic});
 assert.equal(rows[0].statusLabel,'Другая запись единицы');assert.equal(rows[0].status,'issue');
});
test('statuses tell a confidently read difference, an uncertain reading and a callout below the minimum apart',()=>{
 const rule={id:'r',title:'Наименование',constraint:'Минимальная высота шрифта – не менее 2,0 мм',text:'Напиток слабоалкогольный газированный',original:'Напиток слабоалкогольный газированный'};
 const row=(printed,declared)=>{const automatic=matchRequirements([rule],printed,'0,75',false,label,true);if(declared)automatic.r.declared=[declared];return evaluate([rule],'x',{automatic})[0];};
 const extra=row(words(['Напиток','слабоалкогольный','ароматизированный','газированный'],{step:.15}));
 assert.equal(extra.statusLabel,'Отличие текста');assert.equal(extra.comparison.confident,true);
 const weak=row(words(['Напиток','слабоалкогольный','газир0ванный'],{step:.15,confidence:55}));
 assert.equal(weak.statusLabel,'Неуверенное OCR');
 const exact=words(['Напиток','слабоалкогольный','газированный'],{step:.15});
 assert.equal(row(exact).status,'detected');
 assert.equal(row(exact,[{value:1.8,passes:false,level:'high',scope:'section'}]).statusLabel,'Проверить размеры','stated below the minimum');
 assert.equal(row(exact,[{value:1.8,passes:false,level:'low',scope:'section'}]).statusLabel,null,'an untrusted reading raises nothing');
 const measured=words(['Напиток','слабоалкогольный','газированный'],{step:.15,glyph:2.4});
 assert.equal(row(measured,[{value:24,passes:true,level:'high',scope:'section',raster:{value:2.4,agrees:false}}]).statusLabel,'Выноска ≠ замер');
});

// ---- requirements --------------------------------------------------------------
test('a minimum is assigned to the sentence its subject words name, even through a lost space',()=>{
 const checks=dimensionChecks({title:'Срок годности, условия хранения',constraint:'Минимальная высота шрифта для указания срока годности – не менее 2,0 мм\nДля условий хранения – не менее 0,8 мм'});
 assert.equal(scopeIndex(checks,'СРОК ГОДНОСТИ 12 МЕСЯЦЕВ С ДАТЫ РОЗЛИВА ПРИ СОБЛЮДЕНИИ УСЛОВИЙ ХРАНЕНИЯ'),0,'the first subject named decides');
 assert.equal(scopeIndex(checks,'СРОКТОДНОСТИ 12 МЕСЯЦЕВ'),0);
 assert.equal(scopeIndex(checks,'Хранить при температуре воздуха'),1);
 assert.equal(scopeIndex(checks,'Алкоголь противопоказан детям'),-1);
 const rest=dimensionChecks({title:'Срок годности',constraint:'Минимальная высота шрифта для срока годности - не менее 2,0 мм; для остального текста - не менее 0,8 мм'});
 assert.equal(scopeIndex(rest,'Алкоголь противопоказан детям'),1,'"the remaining text" takes what no other minimum names');
});
test('raised digits of Word become the signs they stand for; tables and plain text yield the same rules',()=>{
 assert.equal('25 '+raisedText('0')+'С','25 °С');assert.equal('г/дм'+raisedText('3'),'г/дм³');assert.equal('мм'+raisedText('2'),'мм²');
 const table=requirementsFromSource({tables:[[['Информационный раздел этикетки','Требования ТНПА (СТБ 1100) к маркировке продукции (размеры шрифтов)','Текст для размещения на этикетке'],['1','2','3'],['Срок годности','Минимальная высота шрифта – не менее 2,0 мм','Срок годности 24 месяца.'],['Массовая концентрация сахаров','','Сахар 50 г/дм³'],['Импортер','Минимальная высота шрифта – не менее 0,8 мм','']]],paragraphs:['!!!Просьба размер высоты шрифтов увеличивать хотя бы на 0,1 мм от указанного минимального.','*** Добавить информацию: Соответствует требованиям ТР ТС 021/2011.']});
 const plain=requirementsFromSource({tables:[],paragraphs:['Раздел: Срок годности','Требования: Минимальная высота шрифта – не менее 2,0 мм','Текст: Срок годности 24 месяца.','Раздел: Массовая концентрация сахаров','Текст: Сахар 50 г/дм³','*** Добавить информацию: Соответствует требованиям ТР ТС 021/2011.']});
 const brief=rules=>rules.map(rule=>[rule.title,rule.text,dimensionChecks(rule).map(check=>check.min).join()]);
 assert.deepEqual(brief(table).filter(row=>row[0]!=='Импортер'),brief(plain));
 assert.equal(table.find(rule=>rule.title==='Импортер').sourceReview,true,'an empty text cell is a question, not a missing inscription');
 assert.equal(table.at(-1).extra,true);assert.match(table.at(-1).text,/ТР ТС 021\/2011/);
});
