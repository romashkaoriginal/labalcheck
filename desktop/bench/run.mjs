// Runs the methods on every sheet of the corpus, each run in an application
// started for it alone: memory left behind by one run (the browser's GPU
// process keeps canvases for a while) then cannot be counted as another's.
//   node bench/run.mjs [--sheets=rose,dolce] [--methods=baseline,lab-local-tesseract] [--det=…] [--rec=…]
// Methods: baseline (the site as it is), lab-<first>-<second> (the site's reading
// order with the engines tesseract | local | web | none), local (the simple
// local method). Without --methods: the site and the two modes of the app.
// Readings go to bench/out/<sheet>-<method>.json, times and memory to
// bench/out/summary.json. Score them with `npm run score`.
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..'),out=path.join(here,'out'),args=process.argv.slice(2);
const option=name=>args.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const electron=createRequire(import.meta.url)('electron'),corpus=JSON.parse(readFileSync(path.join(here,'corpus.json'),'utf8')).sheets;
const sheets=(option('sheets')?.split(',')||corpus.map(sheet=>sheet.id)),methods=(option('methods')||'baseline,lab-local-tesseract,lab-tesseract-local').split(','),pass=args.filter(value=>/^--(det|rec|scale)=/.test(value));
mkdirSync(out,{recursive:true});
// Runs kept from an earlier, partial call stay in the summary.
const summaryFile=path.join(out,'summary.json'),kept=existsSync(summaryFile)?JSON.parse(readFileSync(summaryFile,'utf8')).runs||[]:[],runs=[];let last=null;
for(const sheet of sheets)for(const method of methods){
 const started=Date.now(),child=spawnSync(electron,['.','--bench',`--sheets=${sheet}`,`--methods=${method}`,...pass],{cwd:root,stdio:'inherit'});
 if(child.status!==0||!existsSync(summaryFile)){console.error(`bench: ${sheet} · ${method} не выполнен (код ${child.status})`);continue;}
 last=JSON.parse(readFileSync(summaryFile,'utf8'));
 runs.push(...last.runs.map(run=>({...run,wallMs:Date.now()-started})));
}
if(last)writeFileSync(summaryFile,JSON.stringify({...last,runs:[...kept.filter(old=>!runs.some(run=>run.sheet===old.sheet&&run.method===old.method)),...runs]},null,1));
console.log(runs.map(run=>`${run.sheet}\t${run.method}\t${run.error||Math.round(run.ms/1000)+' с\tпик '+run.memory?.peakTotalMb+' МБ'}`).join('\n'));
