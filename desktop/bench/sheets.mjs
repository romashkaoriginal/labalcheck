// Corpus files and their pixels outside a browser (for the scripts run by
// plain Node). The desktop app itself draws pages in its window, as the web
// version does.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
const require=createRequire(import.meta.url),{loadImage,createCanvas}=require(path.join(repo,'node_modules/@napi-rs/canvas'));

// "repo:" is a file of the repository, "corpus:" one in LABEL_CORPUS_DIR
// (the user's Downloads unless set): customers' artwork is not committed.
export function resolveCorpus(file=path.join(here,'corpus.json')){
 const corpus=JSON.parse(readFileSync(file,'utf8')),dir=process.env.LABEL_CORPUS_DIR||path.join(os.homedir(),'Downloads');
 const locate=name=>name.startsWith('repo:')?path.join(repo,name.slice(5)):name.startsWith('corpus:')?path.join(dir,name.slice(7)):path.resolve(name);
 return corpus.sheets.map(sheet=>({...sheet,artwork:locate(sheet.artwork),requirements:locate(sheet.requirements)}));
}

// The first page of a PDF at `dpi`, or an image at its own size.
// Returns {width, height, crop({x,y,w,h}) → RGBA bytes}.
export async function loadSheet(file,{dpi=300,page:pageNumber=1}={}){
 let canvas;
 if(/\.pdf$/i.test(file)){
  const pdfjs=await import(pathToFileURL(path.join(repo,'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
  const document=await pdfjs.getDocument({data:new Uint8Array(readFileSync(file)),cMapUrl:path.join(repo,'node_modules/pdfjs-dist/cmaps/'),cMapPacked:true,standardFontDataUrl:path.join(repo,'node_modules/pdfjs-dist/standard_fonts/'),verbosity:0}).promise;
  const page=await document.getPage(pageNumber),viewport=page.getViewport({scale:dpi/72});
  canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:context,viewport}).promise;
 }else{
  const picture=await loadImage(file);canvas=createCanvas(picture.width,picture.height);
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(picture,0,0);
 }
 const context=canvas.getContext('2d');
 return {width:canvas.width,height:canvas.height,crop:({x,y,w,h})=>context.getImageData(x,y,w,h).data};
}
