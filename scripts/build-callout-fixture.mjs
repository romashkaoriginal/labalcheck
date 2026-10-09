// Builds tests/fixtures/callout-readings.json from real runs of the built site.
// Each sheet is analysed in Chrome (scripts/browser-run.mjs, ?audit and
// window.__labelCheckState) and what the page read from its callouts is stored:
// numbers, pointer kind and the readings of the indicated inscription, with
// the rules of the matching Word file. No artwork pixels are stored.
//
// `expected` — the links a person wrote down by eye from the sheet — is never
// generated: it is carried over from the existing fixture. A new sheet gets
// `proposed` (what the program linked) for a person to check and rename.
//
//   node scripts/build-callout-fixture.mjs sheets.json            rebuild
//   node scripts/build-callout-fixture.mjs sheets.json --check    compare only
//   … --dump folder   also save every full run there (words, probes) for audits
//   … --from folder   take the runs saved there by --dump instead of opening the browser
//   … --runs          also write tests/fixtures/run-<sheet>.json.gz: the whole reading of
//                     the sheet (words of both engines, places looked at again), which
//                     tests/runs.test.mjs judges exactly as the page did
//
// sheets.json: {"rose":{"docx":"C:/…/req.docx","art":"C:/…/sheet.jpg"},"sjabry":{}}
// An empty entry is the bundled sample. Paths stay outside the repository.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {browserRun} from './browser-run.mjs';
import {linkClaims} from '../src/callouts.js';

const target=new URL('../tests/fixtures/callout-readings.json',import.meta.url);
const args=process.argv.slice(2),option=name=>args.includes(name)?args[args.indexOf(name)+1]:null,dump=option('--dump'),from=option('--from'),manifestPath=args.find(arg=>!arg.startsWith('--')&&arg!==dump&&arg!==from),check=args.includes('--check'),runs=args.includes('--runs');
assert.ok(manifestPath,'Usage: node scripts/build-callout-fixture.mjs sheets.json [--check]');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8')),previous=existsSync(target)?JSON.parse(readFileSync(target,'utf8')):{sheets:{}};

const round=(value,digits=0)=>Number.isFinite(value)?Number(value.toFixed(digits)):value;
// What a test needs of a reading, and nothing that locates it on the artwork.
const reading=item=>({raw:item.raw,claim:item.claim,confidence:round(item.confidence),marksAgree:item.marksAgree,reads:item.reads,vertical:item.vertical,
 ...(item.dark?{dark:true}:{}),...(item.lines?{lines:item.lines}:{}),
 gauge:item.gauge?{type:item.gauge.type}:null,
 target:item.target?{via:item.target.via,vertical:item.target.vertical,aspect:round(item.target.aspect,2)}:null,
 targetReadings:(item.targetReadings||[]).map(entry=>({text:entry.text,confidence:round(entry.confidence)}))});
const stated=claim=>claim.kind==='height'?`${claim.value} мм`:claim.kind==='box'?`${claim.values.join('×')} мм`:`${claim.comparator}${claim.value} %`;
// The same wording the test compares, so a person can paste it into `expected`.
const links=page=>linkClaims(page.readings,page.rules,page.volume).filter(item=>item.claim.kind!=='unreadable')
 .map(item=>`${stated(item.claim)} → ${item.links.map(entry=>`${page.rules.find(rule=>rule.id===entry.ruleId).title.slice(0,12)}[${entry.format?'формат':entry.checks.map(check=>check.label).join(',')}]`).sort().join(' + ')||'—'}`).sort();

const sheets={};let differences=0;
for(const [name,files] of Object.entries(manifest)){
 console.log(`\n${name}: ${from?'сохранённый прогон':'прогон в браузере…'}`);
 const run=from?JSON.parse(readFileSync(`${from}/${name}.json`,'utf8')):await browserRun({docx:files.docx,artwork:files.art,volume:files.volume,log:line=>process.stdout.write(`  ${line}\r`)});
 assert.deepEqual(run.errors,[],`${name}: ошибки страницы`);
 if(dump)writeFileSync(`${dump}/${name}.json`,JSON.stringify(run));
 // The reading of the whole sheet, without its pixels: enough to judge it again as the page did.
 if(runs&&!check){const {volume,rules,label,hasContour,image,pageMm,scale,pdfRaster,words,secondaryWords,edgeProbes,calloutReadings,actual}=run;writeFileSync(new URL(`../tests/fixtures/run-${name}.json.gz`,import.meta.url),gzipSync(JSON.stringify({volume,rules,label,hasContour,image,pageMm,scale,pdfRaster,words,secondaryWords,edgeProbes,calloutReadings,actual}),{level:9}));}
 const page={volume:run.volume,rules:run.rules.map(({id,title,constraint,text,original})=>({id,title,constraint,text,original})),readings:run.calloutReadings.map(reading)};
 const now=links(page),old=previous.sheets?.[name],expected=old?.expected;
 if(expected){
  page.expected=expected;
  const wanted=[...expected].sort(),missing=wanted.filter(line=>!now.includes(line)),extra=now.filter(line=>!wanted.includes(line));
  console.log(`  выносок: ${page.readings.length} (было ${old.readings.length}); связей по эталону совпало ${wanted.length-missing.length} из ${wanted.length}`);
  for(const line of missing)console.log(`  − эталон, которого теперь нет:  ${line}`);
  for(const line of extra)console.log(`  + связь, которой нет в эталоне: ${line}`);
  differences+=missing.length+extra.length;
 }else{
  // Not an expectation: the program's own links, to be checked against the sheet by eye.
  page.proposed=now;
  console.log(`  новый лист, выносок: ${page.readings.length}. Связи программы записаны в "proposed"; сверьте их с листом глазами и переименуйте в "expected":`);
  for(const line of now)console.log(`    ${line}`);
 }
 sheets[name]=page;
}
// Sheets of the existing fixture that were not rerun are kept as they are.
for(const [name,page] of Object.entries(previous.sheets||{}))sheets[name]??=page;
if(check){console.log(`\nТолько сверка: файл не изменён. Расхождений с эталоном: ${differences}.`);process.exit(differences?1:0);}
writeFileSync(target,JSON.stringify({note:'Callout readings of production sheets as returned by the browser OCR (numbers, pointer kind, readings of the indicated inscription) with the rules of the matching Word file. No artwork pixels. Built by scripts/build-callout-fixture.mjs. expected: links written down by eye from the sheets; proposed: links of the program, not yet checked by a person.',sheets})+'\n');
console.log(`\nЗаписано: tests/fixtures/callout-readings.json. Расхождений с эталоном: ${differences}.`);
