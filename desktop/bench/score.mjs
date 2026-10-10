// Scores the saved runs of both methods (bench/out/<sheet>-<method>.json, made
// by `npm run bench`) against the hand-made truth (bench/truth/*.json).
// Deterministic and quick: no OCR runs here, only counting — so the numbers of
// the report can be recomputed at any time from the saved readings.
//   node bench/score.mjs [--out docs/desktop-spike/results-tables.md]
import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assess} from '../../src/automatic.js';
import {evaluate} from '../../src/engine.js';
import {isQuantityRule} from '../../src/quantity.js';
import {toAppWords} from '../shared/ocr-result.mjs';
import {fragmentsOf,phraseTokens} from '../../src/phrase.js';
import {textVerdict} from '../renderer/compare.js';
import {scoreSheet,sum,percent,readingTexts} from './metrics.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),out=path.join(here,'out'),args=process.argv.slice(2),value=name=>{const at=args.indexOf('--'+name);return at>=0?args[at+1]:undefined;};
const corpus=JSON.parse(readFileSync(path.join(here,'corpus.json'),'utf8')).sheets,load=file=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
const skipStress=args.includes('--quick');
const kinds={image:'Растровые файлы (JPG, PNG)','raster-pdf':'PDF с вложенной картинкой','vector-pdf':'Векторные PDF'};

// What a method concluded about a section against what the label really shows.
//   confirmed   same on the label and in Word, and the method says "match"
//   caught      different, and the method asserts a difference
//   flagged     different, and the method is unsure or did not find the text —
//               a person is sent to look, nothing false is stated
//   open        same, but the method could not confirm it
//   falseMatch  DIFFERENT, yet the method says "match"   ← the dangerous error
//   falseDiff   same, yet the method asserts a difference
function outcome(truth,verdict){
 if(truth==='same')return verdict==='match'?'confirmed':verdict==='difference'?'falseDiff':'open';
 if(truth==='different')return verdict==='difference'?'caught':verdict==='match'?'falseMatch':'flagged';
 return null;
}
function judge(truth,rules,volume,matches,text){
 const rows=evaluate(rules,text,{volume,margin:false,review:{},automatic:matches}),tally={confirmed:0,caught:0,flagged:0,open:0,falseMatch:0,falseDiff:0,same:0,different:0},sections=[];
 for(const section of truth.sections){
  const row=rows.find(item=>item.id===section.rule),verdict=row?textVerdict(row,matches[section.rule]):'skip',result=outcome(section.truth,verdict);
  if(result){tally[result]++;tally[section.truth]++;}
  sections.push({rule:section.rule,title:section.title,truth:section.truth,verdict,outcome:result,read:matches[section.rule]?.recognizedText||''});
 }
 return {tally,sections};
}
// Readings of the print by an OCR engine (not the PDF text layer, not the barcode reader).
const passCount=words=>new Set(words.filter(word=>word.pass&&!['pdf','barcode'].includes(word.pass)).map(word=>word.pass)).size;
const reading=(truth,words,label,fused)=>scoreSheet(truth,readingTexts(words.filter(word=>word.pass!=='barcode'),{label,fused}));

// ── The dangerous error under controlled change ─────────────────────────────
// Real labels that differ from their Word are few. A known difference can be
// made at will, though: take a section that truly is the same on the label and
// in Word and change the WORD text — another digit, a word removed, a letter
// replaced. The label and its reading stay as they were, so the truth is known
// by construction: the section now differs, and "match" is a false match.
const kindsOfChange={number:'в Word другая цифра числа',added:'в Word есть слово, которого нет на этикетке',inside:'на этикетке лишнее слово внутри фразы',letter:'в слове другая буква',edge:'на этикетке лишнее слово с края фразы (сайт такое не сверяет)'};
const spread=(list,limit)=>list.length<=limit?list:Array.from({length:limit},(_,i)=>list[Math.floor(i*list.length/limit)]);
function mutations(text){
 const list=[];
 for(const match of spread([...text.matchAll(/\d+/g)],12)){const digits=match[0],changed=digits.slice(0,-1)+(Number(digits.at(-1))+1)%10;list.push({kind:'number',from:digits,to:changed,text:text.slice(0,match.index)+changed+text.slice(match.index+digits.length)});}
 const words=[...text.matchAll(/\p{L}{4,}/gu)];
 // A word at the very start or end of a sentence of the requirement stands
 // outside the phrase once it is removed from Word, and print around a phrase
 // is not compared at all; a word inside a sentence is.
 const pieces=fragmentsOf(text),sentences=[];let from=0;
 for(const piece of pieces.length?pieces:[text]){const at=text.indexOf(piece,from);sentences.push({from:at,to:at+piece.length});from=at+piece.length;}
 const inside=match=>{const sentence=sentences.find(item=>match.index>=item.from&&match.index<item.to);return !!sentence&&phraseTokens(text.slice(sentence.from,match.index)).length>0&&phraseTokens(text.slice(match.index+match[0].length,sentence.to)).length>0;};
 for(const match of spread(words.filter(inside),8))list.push({kind:'inside',from:match[0],to:'',text:(text.slice(0,match.index)+text.slice(match.index+match[0].length)).replace(/ {2,}/g,' ')});
 for(const match of spread(words.filter(item=>!inside(item)),4))list.push({kind:'edge',from:match[0],to:'',text:(text.slice(0,match.index)+text.slice(match.index+match[0].length)).replace(/ {2,}/g,' ')});
 for(const match of spread(words.filter(inside),8))list.push({kind:'added',from:'',to:`дополнительно ${match[0]}`,text:text.slice(0,match.index)+'дополнительно '+text.slice(match.index)});
 for(const match of spread(words.filter(item=>item[0].length>=6),8)){
  const word=match[0],middle=Math.floor(word.length/2),letter=word[middle].toLowerCase()==='ж'?'ш':'ж',changed=word.slice(0,middle)+(word[middle]===word[middle].toLowerCase()?letter:letter.toUpperCase())+word.slice(middle+1);
  list.push({kind:'letter',from:word,to:changed,text:text.slice(0,match.index)+changed+text.slice(match.index+word.length)});
 }
 return list;
}
const mutable=rule=>rule.text&&rule.text!=='-'&&!isQuantityRule(rule)&&!/штриховой код|знаки|мебиус|рюмка/i.test(rule.title);
function stress(truth,rules,volume,common,text){
 const tally=Object.fromEntries(Object.keys(kindsOfChange).map(kind=>[kind,{total:0,falseMatch:0,caught:0,flagged:0}])),examples=[];
 for(const section of truth.sections){
  const rule=rules.find(item=>item.id===section.rule);if(section.truth!=='same'||!rule||!mutable(rule))continue;
  for(const change of mutations(rule.text)){
   const altered={...rule,text:change.text,original:change.text},matches=assess({...common,rules:[altered]}),verdict=textVerdict(evaluate([altered],text,{volume,margin:false,review:{},automatic:matches})[0],matches[altered.id]),group=tally[change.kind];
   group.total++;if(verdict==='match'){group.falseMatch++;examples.push({section:section.title,kind:change.kind,from:change.from,to:change.to});}else if(verdict==='difference')group.caught++;else group.flagged++;
  }
 }
 return {tally,examples};
}

// ── Methods ─────────────────────────────────────────────────────────────────
// Every saved run of a sheet (bench/out/<sheet>-<method>.json) is a method.
//   baseline               the web version as it is
//   lab-<first>-<second>   the web version's whole reading order with its two
//                          engines replaced (renderer/lab): tesseract | local
//                          as the first reader, web | local | tesseract | none
//                          as the second
//   local                  the simple local method (no line cutting, no sizes)
const engineNames={tesseract:'Tesseract.js',local:'локальный движок',web:'PaddleOCR в WASM',none:'без второго'};
const title=method=>{const lab=method.match(/^lab-(\w+)-(\w+)$/);return method==='baseline'?'Веб-версия как есть':method==='local'?'Упрощённый локальный (без конвейера сайта)':lab?`Конвейер сайта: ${engineNames[lab[1]]||lab[1]} + ${lab[2]==='none'?'без второго движка':(engineNames[lab[2]]||lab[2])+' вторым'}`:method;};
const short=method=>{const lab=method.match(/^lab-(\w+)-(\w+)$/),letter={tesseract:'T',local:'Л',web:'P',none:'—'};return method==='baseline'?'Веб (T+P)':method==='local'?'Упрощ.':lab?`${letter[lab[1]]}+${letter[lab[2]]}`:method;};
const wanted=value('methods')?.split(',');
const rank=method=>method==='baseline'?0:method.startsWith('lab-')?1:method==='local'?2:3;

const sheets=[];
for(const entry of corpus){
 const truth=load(path.join(here,entry.truth));if(!truth)continue;
 const saved=readdirSync(out).filter(file=>file.startsWith(entry.id+'-')&&file.endsWith('.json')).map(file=>({method:file.slice(entry.id.length+1,-5),data:load(path.join(out,file))})).filter(item=>item.data?.rules&&(!wanted||wanted.includes(item.method))).sort((a,b)=>rank(a.method)-rank(b.method)||a.method.localeCompare(b.method));
 if(!saved.length){console.error(`нет данных листа ${entry.id}: выполните «npm run bench»`);continue;}
 const sheet={id:entry.id,title:entry.title,kind:truth.kind,dpi:truth.sourceDpi,truthStatus:truth.status,methods:{}};
 const simple=saved.find(item=>item.method==='local')?.data,extra=simple?toAppWords(simple.result).filter(word=>word.ocrEngine):null;
 for(const {method,data} of saved){
  const rules=data.rules,volume=data.volume;
  if(data.run){
   const run=data.run,common={rules,volume,margin:false,label:run.label,hasContour:run.hasContour,edgeProbes:run.edgeProbes,page:run.image,words:run.words,secondaryWords:run.secondaryWords},text=run.words.map(word=>word.text).join(' '),fused=reading(truth,run.words,run.label,true);
   sheet.methods[method]={name:title(method),short:short(method),ms:data.ms,memory:data.memory,words:run.words.length,passes:passCount(run.words),secondPasses:passCount(run.secondaryWords),sizes:data.sizes||null,
    ocr:{fused:fused.total,best:reading(truth,run.words,run.label,false).total,byTag:fused.byTag},
    second:run.secondaryWords.length?{fused:reading(truth,run.secondaryWords,run.label,true).total,best:reading(truth,run.secondaryWords,run.label,false).total}:null,
    ...judge(truth,rules,volume,assess(common),text),stress:skipStress?null:stress(truth,rules,volume,common,text)};
   // The readings of the simple local method added to this one as further passes of its first reader.
   if(extra&&method==='baseline'){const joined={...common,words:[...run.words,...extra]};sheet.methods['baseline+local']={name:'Веб-версия + чтения упрощённого локального как ещё проходы',short:'Веб ∪ Л',derived:true,...judge(truth,rules,volume,assess(joined),text),stress:skipStress?null:stress(truth,rules,volume,joined,text)};}
  }else if(data.result){
   const result=data.result,words=toAppWords(result),text=result.words.map(word=>word.text).join(' '),common={rules,words,secondaryWords:[],volume,margin:false,label:result.label,hasContour:result.hasContour,edgeProbes:[],page:result.page},fused=reading(truth,words,result.label,true);
   sheet.methods[method]={name:title(method),short:short(method),ms:data.ms,memory:data.memory,words:result.words.length,passes:passCount(words),secondPasses:0,sizes:null,
    ocr:{fused:fused.total,best:reading(truth,words,result.label,false).total,byTag:fused.byTag},second:null,
    ...judge(truth,rules,volume,assess(common),text),stress:skipStress?null:stress(truth,rules,volume,common,text)};
  }
 }
 sheets.push(sheet);
}
const methods=[...new Set(sheets.flatMap(sheet=>Object.keys(sheet.methods)))].sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b));
const read=methods.filter(method=>sheets.some(sheet=>sheet.methods[method]?.ocr));

// ── Tables ──────────────────────────────────────────────────────────────────
const table=(head,rows)=>[`| ${head.join(' | ')} |`,`|${head.map(()=>'---').join('|')}|`,...rows.map(row=>`| ${row.join(' | ')} |`)].join('\n');
const rate=(errors,total)=>total?`${percent(errors,total)} %`:'—',ratio=(errors,total)=>total?`${errors} из ${total}`:'—';
// Two views of one method. "Общее чтение" is the single reading the site
// makes of all its passes — what the comparison with Word really works on; it
// keeps words and numbers only, so it is counted in letters, words and
// numbers. "Лучший проход" takes for every line the pass that read it best:
// an upper bound no method reaches by itself, and the only view in which
// punctuation and spaces can be counted.
const ocrRow=(label,fused,best)=>[label,rate(fused.letterErrors,fused.letters),rate(fused.tokenErrors,fused.tokens),ratio(fused.numberTokenErrors,fused.numberTokens),ratio(fused.linesMissed,fused.lines),rate(best.characterErrors,best.characters),rate(best.wordErrors,best.words),ratio(best.numberErrors,best.numbers),ratio(best.markErrors,best.marks)];
const ocrHead=['Первый движок метода','Общее чтение: ошибка букв и цифр','Общее чтение: ошибка слов','Общее чтение: числа с ошибкой','Строк не прочитано','Лучший проход: ошибка символов (CER)','Лучший проход: ошибка слов (WER)','Лучший проход: числа с ошибкой','Лучший проход: знаки с ошибкой'];
const tagNames={small:'мелкий текст (до 1,2 мм)',medium:'средний (1,2–3 мм)',large:'крупный (от 3 мм)',numbers:'строки с числами',rotated:'повёрнутый текст',reversed:'выворотка (светлое на цвете)',italic:'курсив',latin:'латиница'};
const tallyHead=['Метод','Верно подтверждено','Отличие поймано','Отправлено на проверку','Не подтверждено','**Ложное совпадение**','Ложное расхождение'];
const tallyRow=(label,tally)=>[label,ratio(tally.confirmed,tally.same),ratio(tally.caught,tally.different),ratio(tally.flagged,tally.different),ratio(tally.open,tally.same),`**${tally.falseMatch}**`,String(tally.falseDiff)];
const addTally=list=>list.reduce((all,tally)=>{for(const key of Object.keys(all))all[key]+=tally[key];return all;},{confirmed:0,caught:0,flagged:0,open:0,falseMatch:0,falseDiff:0,same:0,different:0});
const seconds=ms=>ms==null?'—':`${Math.round(ms/1000)} с`;
const outcomeNames={confirmed:'совпадает ✓',caught:'отличие ✓',flagged:'на проверку',open:'не подтверждено',falseMatch:'**ЛОЖНОЕ СОВПАДЕНИЕ**',falseDiff:'ложное расхождение'};
const number=value=>value==null?'—':String(Math.round(value*100)/100).replace('.',',');

const text=['Обозначения столбцов: T — Tesseract.js, Л — локальный движок, P — PaddleOCR в WASM; первым назван первый движок, вторым — второй. «Веб ∪ Л» — веб-версия, к чтениям которой добавлены чтения упрощённого локального метода.',''];
for(const [kind,heading] of Object.entries(kinds)){
 const own=sheets.filter(sheet=>sheet.kind===kind);
 text.push(`## ${heading}`,'');
 if(!own.length){text.push('В корпусе нет ни одного такого файла. Измерений нет.','');continue;}
 for(const sheet of own){
  const present=methods.filter(method=>sheet.methods[method]);
  text.push(`### ${sheet.title} (${sheet.dpi} dpi)`,'','Чтение этикетки против ручной расшифровки:','');
  text.push(table(ocrHead,present.filter(method=>sheet.methods[method].ocr).map(method=>ocrRow(`${sheet.methods[method].name} (проходов: ${sheet.methods[method].passes})`,sheet.methods[method].ocr.fused,sheet.methods[method].ocr.best))),'');
  text.push('Разделы против того, что на этикетке на самом деле:','',table(tallyHead,present.map(method=>tallyRow(sheet.methods[method].name,sheet.methods[method].tally))),'');
  text.push(table(['Метод','Время','Пик памяти всех процессов','Память до начала','Пик страницы','Пик процесса OCR'],present.filter(method=>sheet.methods[method].memory).map(method=>{const item=sheet.methods[method],peaks=item.memory.peakByTypeMb||{};return [item.name,seconds(item.ms),`${item.memory.peakTotalMb} МБ`,`${item.memory.idleTotalMb} МБ`,`${peaks.Tab??'—'} МБ`,`${Object.entries(peaks).find(([name])=>/node|ocr/i.test(name))?.[1]??'—'} МБ`];})),'');
  const rows=sheet.methods[present[0]].sections,truthNames={same:'то же, что в Word',different:'отличается от Word'};
  text.push(table(['Раздел','На этикетке',...present.map(method=>sheet.methods[method].short)],rows.filter(section=>section.outcome).map(section=>[section.title,truthNames[section.truth],...present.map(method=>outcomeNames[sheet.methods[method].sections.find(item=>item.rule===section.rule)?.outcome]||'—')])),'');
  // Sizes: only methods that run the site's reading order measure anything.
  const measuring=present.filter(method=>sheet.methods[method].sizes);
  if(measuring.length){
   const first=sheet.methods[measuring[0]].sizes,lines=[];
   for(const rule of first)rule.dimensions.forEach((dimension,index)=>lines.push([`${rule.title.split('\n')[0].slice(0,40)} — ${dimension.label}`,`${number(dimension.min)} ${dimension.unit}`,...measuring.map(method=>{const found=sheet.methods[method].sizes.find(item=>item.id===rule.id)?.dimensions[index];return !found||found.value==null?'—':`${found.method==='declared'?'заявлено ':found.estimated?'≈ ':''}${number(found.value)}`;})]));
   if(lines.length)text.push('Размеры (мм или %): что измерил каждый метод. «—» — замера нет, «заявлено» — взято из выноски типографии.','',table(['Раздел — размер','Минимум',...measuring.map(method=>sheet.methods[method].short)],lines),'');
  }
 }
}
const every=method=>sheets.map(sheet=>sheet.methods[method]).filter(Boolean),complete=method=>every(method).length===sheets.length;
text.push('## Все листы вместе','','В итог входят только методы, выполненные на всех листах.','');
text.push(table(ocrHead,read.filter(complete).map(method=>ocrRow(title(method),sum(every(method).map(item=>item.ocr.fused)),sum(every(method).map(item=>item.ocr.best))))),'');
text.push(table([...tallyHead,'Время, среднее','Пик памяти, наибольший'],methods.filter(complete).map(method=>{const items=every(method),timed=items.filter(item=>item.ms!=null);return [...tallyRow(items[0].name,addTally(items.map(item=>item.tally))),timed.length?seconds(timed.reduce((total,item)=>total+item.ms,0)/timed.length):'—',timed.length?`${Math.max(...timed.map(item=>item.memory?.peakTotalMb||0))} МБ`:'—'];})),'');
if(!skipStress){
 const stressOf=method=>every(method).map(item=>item.stress).filter(Boolean);
 const cell=(list,kind)=>{const all=list.reduce((total,item)=>{for(const key of ['total','falseMatch','caught','flagged'])total[key]+=item.tally[kind][key];return total;},{total:0,falseMatch:0,caught:0,flagged:0});return all.total?`**${all.falseMatch}** из ${all.total} (поймано ${all.caught}, на проверку ${all.flagged})`:'—';};
 text.push('## Опасная ошибка на управляемых изменениях Word','','Разделы, которые на этикетке действительно совпадают с Word; в тексте Word сделано одно изменение, чтение этикетки то же самое. Число перед «из» — сколько раз метод объявил совпадение (ложное совпадение).','');
 text.push(table(['Метод',...Object.values(kindsOfChange)],methods.filter(method=>complete(method)&&stressOf(method).length).map(method=>[every(method)[0].name,...Object.keys(kindsOfChange).map(kind=>cell(stressOf(method),kind))])),'');
 const examples=methods.flatMap(method=>sheets.flatMap(sheet=>(sheet.methods[method]?.stress?.examples||[]).filter(item=>item.kind!=='edge').map(item=>[sheet.methods[method].short,sheet.title,item.section,kindsOfChange[item.kind],`${item.from||'—'} → ${item.to||'(убрано из Word)'}`])));
 if(examples.length)text.push('Ложные совпадения этой проверки (кроме слов с края фразы):','',table(['Метод','Лист','Раздел','Изменение','Что изменено в Word'],examples),'');
}
const tags=[...new Set(sheets.flatMap(sheet=>Object.values(sheet.methods).flatMap(item=>Object.keys(item.ocr?.byTag||{}))))];
text.push('Ошибка букв и цифр общего чтения по видам строк:','',table(['Вид строк','Строк',...read.filter(complete).map(short)],tags.map(tag=>{const cells=read.filter(complete).map(method=>sum(every(method).map(item=>item.ocr.byTag[tag]).filter(Boolean)));return [tagNames[tag]||tag,String(Math.max(...cells.map(item=>item.lines))),...cells.map(item=>rate(item.letterErrors,item.letters))];})),'');

const markdown=text.join('\n');
writeFileSync(path.join(out,'scores.json'),JSON.stringify({scored:new Date().toISOString(),sheets},null,1));
if(value('out'))writeFileSync(path.resolve(value('out')),markdown+'\n');
console.log(markdown);
