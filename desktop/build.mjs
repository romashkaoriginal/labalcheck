// Builds what the desktop window loads, into desktop/build:
//   build/web      the web version exactly as `npm run build` makes it in the
//                  repository root — the baseline method runs from this copy
//   build/desktop  the page of the desktop shell
// The web version's own build and sources are not changed.
import {execFileSync} from 'node:child_process';
import {cpSync,existsSync,mkdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'..');
if(!existsSync(path.join(repo,'node_modules/esbuild')))throw new Error('Сначала выполните «npm install» в корне репозитория: настольная версия собирается теми же инструментами.');
const {build}=createRequire(import.meta.url)(path.join(repo,'node_modules/esbuild'));

execFileSync(process.execPath,['build.mjs'],{cwd:repo,stdio:'inherit'});
// Large files that did not change are not copied again.
const same=(from,to)=>{try{const a=statSync(from),b=statSync(to);return a.isFile()&&a.size===b.size&&Math.abs(a.mtimeMs-b.mtimeMs)<2;}catch{return false;}};
cpSync(path.join(repo,'dist'),path.join(here,'build/web'),{recursive:true,preserveTimestamps:true,filter:(from,to)=>!same(from,to)});

// The same web version with its two OCR engines replaceable (build/web/lab.html):
// src/app.js is bundled as it is, but its import of `tesseract.js` and its
// dynamic import of `./secondary-ocr.js` are pointed at renderer/lab/*, which
// hand out either the original engines or the local OCR process, as the
// address of the page says (?primary=…&second=…).
const fromApp=importer=>importer.replace(/\\/g,'/').endsWith('/src/app.js');
const lab={name:'replaceable-engines',setup(setup){
 setup.onResolve({filter:/^tesseract\.js$/},args=>fromApp(args.importer)?{path:path.join(here,'renderer/lab/tesseract.js')}:null);
 setup.onResolve({filter:/^\.\/secondary-ocr\.js$/},args=>fromApp(args.importer)?{path:'./secondary-ocr-lab.js',external:true}:null);
}};
await build({entryPoints:[path.join(repo,'src/app.js')],bundle:true,format:'esm',outfile:path.join(here,'build/web/app-lab.js'),target:'es2022',plugins:[lab],logLevel:'warning'});
await build({entryPoints:[path.join(here,'renderer/lab/secondary-ocr.js')],bundle:true,format:'esm',outfile:path.join(here,'build/web/secondary-ocr-lab.js'),target:'es2022',external:['fs','path'],logLevel:'warning'});
writeFileSync(path.join(here,'build/web/lab.html'),readFileSync(path.join(repo,'dist/index.html'),'utf8').replace('./app.js','./app-lab.js'));

mkdirSync(path.join(here,'build/desktop'),{recursive:true});
for(const file of ['index.html','host.css'])cpSync(path.join(here,'renderer',file),path.join(here,'build/desktop',file));
await build({entryPoints:[path.join(here,'renderer/host.js')],bundle:true,format:'esm',outfile:path.join(here,'build/desktop/host.js'),target:'es2022',sourcemap:'linked',logLevel:'warning'});
console.log('Desktop pages built: desktop/build');
