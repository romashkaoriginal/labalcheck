// The local engine alone on the label of every corpus sheet, for each
// combination of detector, recogniser and detector enlargement: how well each
// reads, against the hand-made transcription. No Electron, no requirements —
// this measures the OCR, not the comparison with Word.
//   node bench/grid.mjs [--det a,b] [--rec a,b] [--scale 1,2] [--sheet id] [--out file.json]
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEngine} from '../src/ocr/engine.mjs';
import {wordsFromEngine,toAppWords,SCHEMA} from '../shared/ocr-result.mjs';
import {scoreSheet,sum,percent,readingTexts} from './metrics.mjs';
import {loadSheet,resolveCorpus} from './sheets.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2),value=name=>{const at=args.indexOf('--'+name);return at>=0?args[at+1]:undefined;};
const list=(name,fallback)=>(value(name)?.split(',')||fallback);
const dets=list('det',['PP-OCRv5_mobile_det','PP-OCRv5_server_det','PP-OCRv6_medium_det']),recs=list('rec',['cyrillic_PP-OCRv5_mobile_rec','eslav_PP-OCRv5_mobile_rec']),scales=list('scale',['1','2']).map(Number);
const sheets=resolveCorpus().filter(sheet=>!value('sheet')||value('sheet').split(',').includes(sheet.id));
const rows=[];
for(const sheet of sheets){
 const truth=JSON.parse(readFileSync(path.join(here,sheet.truth),'utf8')),page=await loadSheet(sheet.artwork,{dpi:truth.sourceDpi});
 const crop={x:Math.round(truth.label.x*page.width),y:Math.round(truth.label.y*page.height),w:Math.round(truth.label.w*page.width),h:Math.round(truth.label.h*page.height)};
 const image={data:page.crop(crop),width:crop.w,height:crop.h};
 for(const det of dets)for(const rec of recs){
  const engine=await createEngine({modelsDir:path.resolve(here,'../models'),det,rec});
  for(const scale of scales){
   const result=await engine.recognize(image,{scale});
   const unified={schema:SCHEMA,page:{width:page.width,height:page.height},words:wordsFromEngine(result.lines,{crop:{x:crop.x,y:crop.y}})};
   const score=scoreSheet(truth,readingTexts(toAppWords(unified)));
   rows.push({sheet:sheet.id,det,rec,scale,ms:Math.round(result.timings.detectMs+result.timings.recognizeMs),lines:result.lines.length,...score.total,byTag:score.byTag,wrongNumbers:score.lines.flatMap(line=>line.wrongNumbers)});
   console.error(`${sheet.id} ${det} ${rec} ×${scale}: CER ${percent(score.total.characterErrors,score.total.characters)} %`);
  }
  await engine.release();
 }
}
const table=[];
for(const det of dets)for(const rec of recs)for(const scale of scales){
 const own=rows.filter(row=>row.det===det&&row.rec===rec&&row.scale===scale),total=sum(own);
 table.push({det,rec,scale,'CER %':percent(total.characterErrors,total.characters),'буквы/цифры %':percent(total.letterErrors,total.letters),'WER %':percent(total.wordErrors,total.words),'числа с ошибкой':`${total.numberErrors}/${total.numbers}`,'знаки с ошибкой':`${total.markErrors}/${total.marks}`,'строк не найдено':`${total.linesMissed}/${total.lines}`,'мс на лист':Math.round(own.reduce((n,row)=>n+row.ms,0)/own.length)});
}
console.table(table);
if(value('out')){mkdirSync(path.dirname(path.resolve(value('out'))),{recursive:true});writeFileSync(value('out'),JSON.stringify({rows,table},null,1));}
