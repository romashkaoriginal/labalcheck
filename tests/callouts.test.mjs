import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyInk,findCalloutClusters,findGauges,findTarget,parseClaim,separatorCount,claimMarks,insideSimilarity,linkClaims,verifyOnLabel,applyDeclaredDimensions,readCallouts} from '../src/callouts.js';

// ---- a drawn technical sheet ------------------------------------------------
// Glyphs are solid blocks: enough for geometry, and nothing here depends on the
// position, colour or wording of any real sheet.
const PINK=[228,0,120],BLUE=[20,90,220],BLACK=[25,25,25];
function sheet(width=1600,height=1200){
 const data=new Uint8ClampedArray(width*height*4).fill(255);
 const fill=(x0,y0,x1,y1,[r,g,b])=>{for(let y=Math.max(0,Math.round(y0));y<Math.min(height,Math.round(y1));y++)for(let x=Math.max(0,Math.round(x0));x<Math.min(width,Math.round(x1));x++){const i=(y*width+x)*4;data[i]=r;data[i+1]=g;data[i+2]=b;}};
 // pattern: d digit · m unit letter · x small letter · "." point · "," comma · "*" raised mark · " " space
 const callout=(pattern,x,y,{size=24,color=PINK,turned=false}={})=>{
  let u=0;const boxes=[];
  for(const char of pattern){
   const [w,h,top]=char==='d'?[.55,1,0]:char==='m'?[.8,.7,.3]:char==='x'?[.5,.7,.3]:char==='.'?[.16,.16,.84]:char===','?[.16,.34,.82]:char==='*'?[.3,.3,0]:[.35,0,0];
   if(h){
    // turned: the line runs up the page and is read after a quarter turn clockwise
    const box=turned?[x+top*size,y-(u+w*size),x+(top+h)*size,y-u]:[x+u,y+top*size,x+u+w*size,y+(top+h)*size];
    fill(...box,color);boxes.push(box);
   }
   u+=(w+.12)*size;
  }
  return {x0:Math.min(...boxes.map(b=>b[0])),y0:Math.min(...boxes.map(b=>b[1])),x1:Math.max(...boxes.map(b=>b[2])),y1:Math.max(...boxes.map(b=>b[3]))};
 };
 // words: letter counts per word; returns the box of the whole line
 const text=(words,x,y,{size=30,turned=false,color=BLACK}={})=>{
  let u=0;
  for(const count of words){for(let i=0;i<count;i++){const box=turned?[x,y+u,x+size,y+u+size*.5]:[x+u,y,x+u+size*.5,y+size];fill(...box,color);u+=size*.62;}u+=size*.4;}
  u-=size*.52;
  return turned?{x0:x,y0:y,x1:x+size,y1:y+u}:{x0:x,y0:y,x1:x+u,y1:y+size};
 };
 return {pixels:{data,width,height},fill,callout,text};
}
const inside=(inner,outer,slack=4)=>inner.x0>=outer.x0-slack&&inner.y0>=outer.y0-slack&&inner.x1<=outer.x1+slack&&inner.y1<=outer.y1+slack;
const covers=(found,drawn,slack=6)=>Math.abs(found.x0-drawn.x0)<=slack&&Math.abs(found.x1-drawn.x1)<=slack&&found.y0<=drawn.y0+slack&&found.y1>=drawn.y1-slack;
const analyse=s=>{const ink=classifyInk(s.pixels),clusters=findCalloutClusters(ink),gauges=findGauges(ink,clusters);return {ink,clusters,gauges,targets:clusters.map((cluster,i)=>findTarget(ink,cluster,gauges[i]))};};

test('leader lines lead from the callout to its line, whichever side the callout stands on',()=>{
 for(const mirrored of [false,true]){
  const s=sheet(),line=s.text([6,9,5],mirrored?200:700,300),other=s.text([8,7],mirrored?200:700,360);
  const mark=s.callout('d,d mm',mirrored?line.x1+130:line.x0-250,304);
  const [from,to]=mirrored?[line.x1+6,mark.x0-6]:[mark.x1+6,line.x0-6];
  s.fill(from,line.y0,to,line.y0+2,PINK);s.fill(from,line.y1-2,to,line.y1,PINK);
  const {clusters,gauges,targets}=analyse(s);
  assert.equal(clusters.length,1,'one callout');
  assert.equal(clusters[0].count,5,'digits, comma and unit letters');
  assert.equal(separatorCount(clusters[0]),1);
  assert.equal(gauges[0]?.type,'height');
  assert.equal(targets[0]?.via,'gauge');
  assert.ok(covers(targets[0],line),`the indicated line, mirrored=${mirrored}`);
  assert.ok(!inside(other,targets[0],0),'the neighbouring line below is not taken');
 }
});

test('arrowed ticks beside quarter-turned callouts: each callout keeps its own line',()=>{
 const s=sheet(),first=s.text([7,10],385,260,{size:34}),second=s.text([6,6],385,340,{size:20});
 // Two turned callouts in neighbouring columns that overlap in height, each
 // running alongside its own pair of ticks like "2.56 mm" / "0.96 mm".
 const a=s.callout('d.dd mm',250,331,{turned:true}),b=s.callout('d.dd mm',290,404,{turned:true});
 for(const line of [first,second]){
  s.fill(330,line.y0,365,line.y0+2,PINK);s.fill(330,line.y1-2,365,line.y1,PINK);
  s.fill(346,line.y0-16,348,line.y0,PINK);s.fill(346,line.y1,348,line.y1+16,PINK); // arrow shafts
 }
 const {clusters,gauges,targets}=analyse(s);
 assert.equal(clusters.length,2,'side-by-side turned callouts are not merged; ticks are not glyphs');
 assert.ok(clusters.every(cluster=>cluster.vertical&&cluster.count===6));
 const byColumn=[...clusters.keys()].sort((i,j)=>clusters[i].x0-clusters[j].x0);
 assert.ok(covers(targets[byColumn[0]],first),'left callout → upper line');
 assert.ok(covers(targets[byColumn[1]],second),'right callout → lower line');
 assert.ok(gauges.every(gauge=>gauge?.type==='height'));
 assert.ok(a.x1<b.x0);
});

test('three leader lines close together: a callout takes the tightest pair around itself',()=>{
 const s=sheet(),small=s.text([10,8,7],500,300,{size:18}),large=s.text([6,12],500,330,{size:44});
 const upper=s.callout('d,dd mm',220,297,{size:24}),lower=s.callout('d,d mm',250,340,{size:24});
 for(const y of [small.y0,small.y1,large.y0,large.y1])s.fill(350,y-1,490,y+1,PINK);
 const {clusters,gauges,targets}=analyse(s);
 assert.equal(clusters.length,2);
 const top=clusters.findIndex(cluster=>cluster.y0<320),bottom=1-top;
 assert.ok(Math.abs(gauges[top].to-gauges[top].from-18)<=4,'upper callout: the 18 px interval');
 assert.ok(Math.abs(gauges[bottom].to-gauges[bottom].from-44)<=4,'lower callout: the 44 px interval');
 assert.ok(covers(targets[top],small)&&covers(targets[bottom],large));
 assert.ok(upper.y0<lower.y0);
});

test('without ticks the callout belongs to the inscription written right before it',()=>{
 const s=sheet(),big=s.text([5,4,5],200,300,{size:50}),above=s.text([9,9,9],200,230,{size:16});
 s.callout('d.ddd mm',big.x1+12,big.y1-18,{size:14});
 const small=s.text([9],200,420,{size:14});s.callout('d.ddd mm',small.x1+16,420,{size:14});
 const {clusters,gauges,targets}=analyse(s);
 assert.equal(clusters.length,2);assert.ok(gauges.every(gauge=>gauge===null));
 const first=clusters.findIndex(cluster=>cluster.y0<400);
 assert.equal(targets[first].via,'adjacent');
 assert.ok(covers(targets[first],big),'a small callout beside a large line takes the whole line');
 assert.ok(!inside(above,targets[first],0));
 assert.ok(covers(targets[1-first],small));
});

test('a size written under a square mark points at the mark, not at text beside it',()=>{
 const s=sheet();
 for(const x of [600,628,656])s.fill(x,300,x+22,372,BLACK);          // three heavy letters, 78 × 72
 const aside=s.text([4,7,9,6],720,300,{size:14,turned:true});          // quarter-turned text next to it
 s.callout('d,dxd,d mm',560,392);
 const {ink,clusters,targets}=analyse(s);
 assert.equal(clusters.length,1);assert.equal(separatorCount(clusters[0]),2);
 assert.ok(targets[0].x0>=aside.x0-6,'a plain size would be taken for the text right beside it');
 // A W×H statement sizes a mark: the shape above it is looked at first.
 const target=findTarget(ink,clusters[0],null,{mark:true}),aspect=(target.x1-target.x0)/(target.y1-target.y0);
 assert.ok(covers(target,{x0:600,y0:300,x1:678,y1:372}));
 assert.ok(aspect>.7&&aspect<1.45,'square mark');
 assert.ok(target.x1<aside.x0,'the turned text beside the mark is left out');
});

test('a callout in another ink is found by its own colour; frame dashes are not callouts',()=>{
 const s=sheet(),line=s.text([8,8],500,300);
 s.callout('d.d mm',line.x1+14,306,{color:BLUE});
 for(let x=100;x<1500;x+=40)s.fill(x,100,x+24,103,[240,150,60]);       // dashed orange border
 const {clusters,targets}=analyse(s);
 assert.equal(clusters.length,1);assert.ok(covers(targets[0],line));
});

// ---- what a callout states ----------------------------------------------------
test('a callout states one size; a lost decimal mark is unreadable, never ten times larger',()=>{
 assert.deepEqual(parseClaim('2,1 mm'),{kind:'height',value:2.1,raw:'2,1 mm'});
 assert.equal(parseClaim('0.688 mm').value,.688);
 assert.equal(parseClaim('+ 0.96 mm').value,.96);
 assert.equal(parseClaim('2,1 тт').value,2.1,'Cyrillic look-alike of mm');
 assert.equal(parseClaim('0 88 mm').kind,'unreadable');
 assert.equal(parseClaim('084 mm').kind,'unreadable');
 assert.equal(parseClaim('5 1x5,1 mm').kind,'unreadable');
 assert.deepEqual(parseClaim('5,1x5,1 mm').values,[5.1,5.1]);
 assert.deepEqual(parseClaim('49mm*6mm').values,[49,6]);
 assert.deepEqual(parseClaim('5.1 mm*5.1 mm').values,[5.1,5.1]);
 assert.equal(parseClaim('ПЕЧАТЬ ПО КЛЕЮ'),null);
 // A number inside a sentence is not a letter height, and a sentence is no callout.
 assert.equal(parseClaim('S надписи = 359 9 mm'),null);
 assert.equal(parseClaim('YXYAWAKWHUE KAYECTBO TOTOBOM MPOAYKUMM. NOCNE YTBEPKAEHMA MAKETA MPETEH3'),null);
 const area=parseClaim('S надписи = 359,9 мм² > 10% от S этикетки, исключая место для фсм (318,1 мм²)');
 assert.deepEqual([area.kind,area.value,area.comparator,area.areas],['percent',10,'>',[359.9,318.1]]);
 assert.deepEqual([parseClaim('>11% от площади этикетки').value,parseClaim('>11% от площади этикетки').comparator],[11,'>']);
 // "22mm" parses, but the ink has a decimal mark the text lacks: the reading is distrusted.
 assert.equal(claimMarks(parseClaim('22mm')),0);assert.equal(claimMarks(parseClaim('2,2 mm')),1);assert.equal(claimMarks(parseClaim('5,1x5,1 mm')),2);
});

test('approximate substring search tolerates OCR slips and a changed number',()=>{
 assert.equal(insideSimilarity('срокгодности','срокгодности24месяца'),1);
 assert.ok(insideSimilarity('сроктодности12месяцев','срокгодности24месяцасдатырозлива')>.75);
 assert.ok(insideSimilarity('чрезмерноеупотребление','напитокслабоалкогольный')<.5);
});

// ---- which requirement a callout belongs to ----------------------------------
const rules=[
 {id:'name',title:'Наименование',constraint:'Минимальная высота шрифта – не менее 2,0 мм',text:'Напиток слабоалкогольный натуральный газированный непастеризованный «САН РЕМИНО. РОЗЕ»'},
 {id:'made',title:'Состав и пищевая ценность',constraint:'Минимальная высота шрифта – не менее 0,8 мм',text:'Состав: виноматериал виноградный натуральный белый (содержит пищевую добавку антиокислитель Е220), вода питьевая, сахар белый. Пищевая ценность на 100 мл напитка слабоалкогольного: углеводы – 5,0 г.'},
 {id:'shelf',title:'Срок годности, условия хранения',constraint:'Минимальная высота шрифта для указания срока годности – не менее 2,0 мм\nДля условий хранения – не менее 0,8 мм',text:'Срок годности 24 месяца с даты розлива при соблюдении условий хранения.\nХранить при температуре от 0 °С до плюс 25 °С в затемненных помещениях.'},
 {id:'warn',title:'Обязательная надпись',constraint:'Надпись должна занимать не менее 10% от площади этикетки',text:'ЧРЕЗМЕРНОЕ УПОТРЕБЛЕНИЕ АЛКОГОЛЯ ВРЕДИТ ВАШЕМУ ЗДОРОВЬЮ'},
 {id:'abv',title:'Крепость (Объемная доля этилового спирта)',constraint:'',text:'Спирт 6,8 %'},
 {id:'volume',title:'Объем',constraint:'Термин «объем»: минимальная высота шрифта – не менее 2 мм\nКоличество товара упаковочной единицы (например, «0,5 л»): минимальная высота шрифта – не менее 4 мм',text:'Объем 0,75 л'},
 {id:'std',title:'Технологические стандарты',constraint:'',text:'СТБ 1122\nРЦ ВУ 491315438.113'},
 {id:'signs',title:'Прочие знаки (ЕАС, петли Мебиуса, рюмка с вилкой)',constraint:'Знак ЕАС: в форме квадрата и не менее 5 мм в высоту и ширину',text:'ЕАС\nПетля Мебиуса «GL»\nРюмка с вилкой'},
 {id:'date',title:'Окно для даты розлива',constraint:'Высота шрифта [Дата розлива:] – не менее 0,8 мм\nМинимальная высота шрифта цифр – не менее 2,0 мм\nФормат: 42х11 или 49х6 (мм)',text:'Дата розлива / номер партии:'}
].map(rule=>({...rule,original:rule.text}));
const reading=(raw,targetText,extra={})=>({claim:parseClaim(raw),raw,confidence:93,marksAgree:true,reads:1,gauge:{type:'height'},target:{via:'gauge',aspect:8},targetReadings:targetText==null?[]:[].concat(targetText).map(text=>({text,confidence:90})),...extra});
const link=(raw,targetText,extra)=>linkClaims([reading(raw,targetText,extra)],rules,'0,75')[0];
const checked=item=>item.links.map(entry=>[entry.ruleId,...entry.checks.map(check=>`${check.label}:${check.passes}`)].join(' '));

test('the inscription beside a callout selects the Word rule and the minimum it is compared with',()=>{
 // An extra word on the artwork and a different number do not hide which rule it is.
 assert.deepEqual(checked(link('2.56 mm','НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ НАТУРАЛЬНЫЙ АРОМАТИЗИРОВАННЫЙ')),['name Высота букв:true']);
 assert.deepEqual(checked(link('0.96 mm','Состав: виноматериал виноградный натуральный белый из сортов винограда')),['made Высота букв:true']);
 assert.deepEqual(checked(link('2.23 mm','СРОКТОДНОСТИ 12 МЕСЯЦЕВ')),['shelf Срок годности:true'],'12 instead of 24 and a lost space');
 assert.deepEqual(checked(link('0.9 mm','Хранить при температуре от 0 °С до плюс 25 °С')),['shelf Для условий хранения:true']);
 assert.deepEqual(checked(link('1.7 mm','СРОК ГОДНОСТИ 12 МЕСЯЦЕВ')),['shelf Срок годности:false'],'a stated size below the minimum is reported as such');
 const code=link('1.57 mm','СТБ 1122 РЦ BY 190239501.9-21.200');
 assert.deepEqual(checked(code),['std']);assert.match(code.reason,/минимальной высоты.*нет/);
 assert.equal(link('4.66 mm','ЧРЕЗМЕРНОЕ УПОТРЕБЛЕНИЕ АЛКОГОЛЯ').links[0].ruleId,'warn');
 assert.deepEqual(link('4.66 mm','ЧРЕЗМЕРНОЕ УПОТРЕБЛЕНИЕ АЛКОГОЛЯ').links[0].checks,[],'an area minimum is not a letter height');
});

test('one callout after a line shared by several rules speaks for each of them',()=>{
 const item=link('4.115 mm','СПИРТ 6,8% — САХАР 75 Г/Л ОБЪЕМ 0,75 Л',{gauge:null,target:{via:'adjacent',aspect:10}});
 assert.deepEqual(checked(item).sort(),['abv','volume Буквы «Объем»:true Количество товара:true']);
 assert.equal(item.shared,true);assert.equal(item.level,'medium');
 // The amount alone is the amount; the caption alone is the caption.
 assert.deepEqual(checked(link('4,2 mm',['О,/л','0,7л'])),[],'0,7 л is not this product volume');
 assert.deepEqual(checked(link('4,2 mm',['О,75 /л','0,75 л'])),['volume Количество товара:true'],'the reading that makes sense is kept');
 assert.deepEqual(checked(link('3,0 mm','0,75 л')),['volume Количество товара:false']);
 assert.deepEqual(checked(link('2,1 mm','ОБЪЕМ')),['volume Буквы «Объем»:true']);
 assert.deepEqual(checked(link('0.905 mm','Дата розлива:')),['date Буквы подписи даты:true']);
});

test('text outside Word, an unread number and a callout pointing nowhere stay unlinked with a reason',()=>{
 assert.match(link('0.688 mm','Ароматика').reason,/не входит в тексты столбца 3/);
 assert.match(link('6,0 mm',null,{target:null,gauge:null}).reason,/нет надписи или указателя/);
 assert.match(linkClaims([{...reading('0 88 mm','Состав: виноматериал')}],rules,'0,75')[0].reason,/число в ней не прочитано/);
 assert.equal(link('0.688 mm','Ароматика').links.length,0);
 assert.equal(link('0,8 mm','[222]').links.length,0,'a few bare digits identify no rule');
});

test('area share, window format and the conformity sign are linked by what they state',()=>{
 const share=link('>11% от площади этикетки',null,{target:null,gauge:null,marksAgree:undefined});
 assert.deepEqual(checked(share),['warn Площадь предупреждения:true']);assert.equal(share.level,'medium');
 const format=link('49x6 mm',null,{target:null,gauge:null});
 assert.equal(format.links[0].ruleId,'date');assert.equal(format.links[0].format,true);assert.deepEqual(format.links[0].checks,[]);
 assert.equal(link('30x8 mm',null,{target:null,gauge:null}).links.length,0,'a format Word does not list is not attached to the window');
 // The sign is read as ЕНГ, EAL or not at all; its square shape identifies it.
 assert.deepEqual(checked(link('5.1 mm*5.1 mm','ЕНГ',{gauge:null,target:{via:'adjacent',aspect:1.02}})),['signs Высота ЕАС:true Ширина ЕАС:true']);
 assert.deepEqual(checked(link('5.10 mm','EAL',{gauge:{type:'width'},target:{via:'gauge',aspect:1}})),['signs Ширина ЕАС:true']);
 assert.deepEqual(checked(link('5.10 mm','ЕНГ',{gauge:{type:'height'},target:{via:'gauge',aspect:1}})),['signs Высота ЕАС:true']);
 // A caption of the same section is not the sign: its size is not held against 5 mm.
 const caption=linkClaims([reading('0,8 mm','РЮМКА С ВИЛКОЙ')],rules,'0,75')[0];
 assert.deepEqual(checked(caption),['signs']);
});

test('confidence separates the number from the link',()=>{
 assert.equal(link('2.56 mm','НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ НАТУРАЛЬНЫЙ').level,'high');
 assert.equal(link('2.56 mm','НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ НАТУРАЛЬНЫЙ',{gauge:null,target:{via:'adjacent',aspect:9}}).level,'medium');
 assert.equal(link('2.56 mm','НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ НАТУРАЛЬНЫЙ',{marksAgree:false}).level,'low','decimal mark not confirmed by ink');
 assert.equal(link('2.56 mm','НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ НАТУРАЛЬНЫЙ',{confidence:35}).level,'low');
 assert.equal(link('2.56 mm','НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ НАТУРАЛЬНЫЙ',{confidence:35,reads:2}).level,'high','two equal readings and agreeing marks');
});

// ---- declared against measured -------------------------------------------------
const word=(text,x,y,height,glyph)=>({text,confidence:95,box:{x,y,w:text.length*.01,h:height},rotation:0,pass:'print',line:String(y),sourcePixelMm:.085,glyphs:[...text].map(char=>({text:char,height:glyph}))});
test('a callout fills a size only where nothing was measured and only for the text it covers',()=>{
 const empty=()=>({dimensions:[null],measurementNotes:[''],measurementMeta:[null],words:[]});
 const matches={name:empty(),made:empty(),shelf:{...empty(),dimensions:[null,null]},volume:{...empty(),dimensions:[null,null]},abv:empty()};
 const annotations=verifyOnLabel(linkClaims([reading('2.56 mm','НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ НАТУРАЛЬНЫЙ ГАЗИРОВАННЫЙ НЕПАСТЕРИЗОВАННЫЙ'),reading('4,2 mm','0,75 л'),reading('3,0 mm','0,75 л'),reading('1.2 mm','Состав: виноматериал',{confidence:40})],rules,'0,75'),matches);
 applyDeclaredDimensions(matches,annotations);
 assert.equal(matches.name.dimensions[0],2.56);assert.equal(matches.name.measurementMeta[0].method,'declared');
 // Digits 4,2 mm and unit letter 3,0 mm: both stay visible, the smaller decides.
 assert.equal(matches.volume.dimensions[1],3);assert.deepEqual(matches.volume.measurementMeta[1].values,[3,4.2]);
 assert.match(matches.volume.measurementNotes[1],/несколько разных значений/);
 assert.equal(matches.made.dimensions[0],null,'a low-confidence reading is listed but not entered');
 assert.equal(matches.made.declared[0][0].level,'low');
 // A measured value is never overwritten by a statement.
 const measured={name:{...empty(),dimensions:[2.4],measurementMeta:[{method:'raster-glyphs'}]}};
 applyDeclaredDimensions(measured,verifyOnLabel(linkClaims([reading('2.56 mm','НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ НАТУРАЛЬНЫЙ ГАЗИРОВАННЫЙ НЕПАСТЕРИЗОВАННЫЙ')],rules,'0,75'),measured));
 // One line of a longer section, not found on the label: listed, not entered.
 const partial={made:empty()};
 applyDeclaredDimensions(partial,verifyOnLabel(linkClaims([reading('0.96 mm','Состав: виноматериал виноградный')],rules,'0,75'),partial));
 assert.equal(partial.made.dimensions[0],null);assert.equal(partial.made.declared[0][0].scope,'line');
 assert.equal(measured.name.dimensions[0],2.4);assert.equal(measured.name.declared[0][0].value,2.56);
});

test('the same inscription on the printed label tells whether a callout speaks for the section and agrees with the raster',()=>{
 const maker={id:'maker',title:'Изготовитель',constraint:'Минимальная высота шрифта - не менее 0,8 мм',text:'Страна происхождения продукта – Республика Беларусь. Изготовитель: ООО «Компания». Место нахождения: Гомельская обл.',original:''};
 const country=['Страна','происхождения','продукта'].map((text,i)=>word(text,.1+i*.15,.5,.021,2.1)),address=['Изготовитель','ООО','Компания','Место','нахождения','Гомельская','обл'].map((text,i)=>word(text,.1+i*.11,.3,.009,.9));
 const matches={maker:{dimensions:[null],measurementNotes:[''],measurementMeta:[null],words:[...address,...country]}};
 const annotations=verifyOnLabel(linkClaims([reading('2,1 mm','СТРАНА ПРОИСХОЖДЕНИЯ ПРОДУКТА:')],[maker],'0,7'),matches,{width:1000,height:1000});
 const entry=annotations[0].links[0];
 assert.equal(entry.scope,'line','the address in the same section is set smaller');
 assert.deepEqual([entry.raster.agrees,Math.round(entry.raster.value*10)/10],[true,2.1]);
 applyDeclaredDimensions(matches,annotations);
 assert.equal(matches.maker.dimensions[0],null,'2,1 mm of one line is not entered for the whole section');
 assert.equal(matches.maker.declared[0][0].scope,'line');
 // A number ten times off (a lost decimal mark that slipped through) is exposed by the raster.
 const wrong=verifyOnLabel(linkClaims([reading('21 mm','СТРАНА ПРОИСХОЖДЕНИЯ ПРОДУКТА:')],[maker],'0,7'),matches,{width:1000,height:1000});
 assert.equal(wrong[0].links[0].raster.agrees,false);
});

// ---- readings taken from real sheets ----------------------------------------
// Numbers and inscriptions exactly as the browser read them on three production
// sheets of two printers; no artwork pixels are stored. The expected links were
// written down by eye from the sheets themselves, independently of the program.
const real=JSON.parse(readFileSync(new URL('./fixtures/callout-readings.json',import.meta.url),'utf8'));
const stated=claim=>claim.kind==='height'?`${claim.value} мм`:claim.kind==='box'?`${claim.values.join('×')} мм`:`${claim.comparator}${claim.value} %`;
test('callouts of three real sheets are linked the way a person reads the sheet',()=>{
 for(const [name,page] of Object.entries(real.sheets)){
  const linked=linkClaims(page.readings,page.rules,page.volume).filter(item=>item.claim.kind!=='unreadable');
  const seen=linked.map(item=>`${stated(item.claim)} → ${item.links.map(entry=>`${page.rules.find(rule=>rule.id===entry.ruleId).title.slice(0,12)}[${entry.format?'формат':entry.checks.map(check=>check.label).join(',')}]`).sort().join(' + ')||'—'}`);
  assert.deepEqual(seen.sort(),[...page.expected].sort(),name);
  // A real number is never trusted on OCR confidence alone.
  assert.ok(linked.filter(item=>['height','box'].includes(item.claim.kind)).every(item=>item.marksAgree===true),`${name}: decimal marks agree with the ink`);
 }
});

// ---- the whole sequence with a scripted OCR ---------------------------------
// The reader counts glyph blocks on the middle row of the crop it receives, so
// each inscription is recognised by its own shape and not by the order of calls.
const blocks=({data,width,height})=>{const y=Math.floor(height/2);let n=0,inked=false;for(let x=0;x<width;x++){const dark=data[(y*width+x)*4]<128;if(dark&&!inked)n++;inked=dark;}return n;};
test('reading a sheet: number, pointer, inscription and rule in a layout and in its mirror image',async()=>{
 for(const mirrored of [false,true]){
  const s=sheet(),place=(words,x,y,options)=>{const probe=sheet().text(words,0,y,options);return s.text(words,mirrored?1600-x-(probe.x1-probe.x0):x,y,options);};
  const name=place([7,16,11],560,200,{size:34}),life=place([4,8,2,7],560,320,{size:30}),label={x:(mirrored?900:100)/1600,y:700/1200,w:600/1600,h:400/1200};
  s.fill(label.x*1600,700,label.x*1600+600,1100,[235,200,210]);                                   // printed label, excluded from the search
  s.callout('d.dd mm',label.x*1600+200,800);                                                    // pink text inside the label is not a callout
  for(const line of [name,life]){
   const mark=s.callout(line===name?'d,dd mm':'d,d mm',mirrored?line.x1+150:line.x0-290,line.y0+4);
   const [from,to]=mirrored?[line.x1+6,mark.x0-6]:[mark.x1+6,line.x0-6];
   s.fill(from,line.y0,to,line.y0+2,PINK);s.fill(from,line.y1-2,to,line.y1,PINK);
  }
  const crop=(box,pad)=>{const x=Math.max(0,Math.floor(box.x0-pad)),y=Math.max(0,Math.floor(box.y0-pad)),w=Math.min(1600,Math.ceil(box.x1+pad))-x,h=Math.min(1200,Math.ceil(box.y1+pad))-y,data=new Uint8ClampedArray(w*h*4);for(let row=0;row<h;row++)data.set(s.pixels.data.subarray(((row+y)*1600+x)*4,((row+y)*1600+x+w)*4),row*w*4);return {pixels:{data,width:w,height:h},x,y};};
  const readLatin=async image=>({text:{5:'2,56 mm',4:'2,1 mm'}[blocks(image)]||'',confidence:92});
  const readWords=async image=>({text:{34:'НАПИТОК СЛАБОАЛКОГОЛЬНЫЙ НАТУРАЛЬНЫЙ',21:'СРОК ГОДНОСТИ 12 МЕСЯЦЕВ'}[blocks(image)]||'',confidence:90});
  const readings=await readCallouts({sheet:s.pixels,crop,readLatin,readWords,avoid:[label]});
  assert.equal(readings.length,2,`two callouts outside the label, mirrored=${mirrored}`);
  const linked=linkClaims(readings,rules,'0,75');
  assert.deepEqual(linked.map(item=>[item.claim.value,item.links[0]?.ruleId,item.links[0]?.checks[0]?.label,item.level]).sort(),[[2.1,'shelf','Срок годности','high'],[2.56,'name','Высота букв','high']]);
  assert.ok(readings.every(item=>item.marksAgree===true&&item.gauge.type==='height'&&item.target.via==='gauge'));
 }
});
