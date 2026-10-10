// The local engine on one image file, outside Electron — for trying models
// and settings.
//   node bench/ocr-cli.mjs sheet.jpg [--crop x,y,w,h] [--det NAME] [--rec NAME] [--scale 2] [--out lines.json]
// --crop is in fractions of the image. Prints the lines read, top to bottom.
import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEngine} from '../src/ocr/engine.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
// Image decoding outside a browser: the canvas package pdf.js already brings into the web project.
const {loadImage,createCanvas}=createRequire(import.meta.url)(path.resolve(here,'../../node_modules/@napi-rs/canvas'));

export async function readImage(file,crop=null){
 const picture=await loadImage(file),x=Math.round((crop?.x||0)*picture.width),y=Math.round((crop?.y||0)*picture.height),width=Math.round((crop?.w||1)*picture.width),height=Math.round((crop?.h||1)*picture.height);
 const canvas=createCanvas(width,height),context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(picture,-x,-y);
 return {data:context.getImageData(0,0,width,height).data,width,height,page:{width:picture.width,height:picture.height},offset:{x,y}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=name=>{const at=args.indexOf('--'+name);return at>=0?args[at+1]:undefined;};
 const crop=value('crop')?.split(',').map(Number),image=await readImage(args[0],crop&&{x:crop[0],y:crop[1],w:crop[2],h:crop[3]});
 const started=performance.now(),engine=await createEngine({modelsDir:path.resolve(here,'../models'),det:value('det'),rec:value('rec'),threads:Number(value('threads')||0)}),loaded=performance.now();
 const result=await engine.recognize(image,{scale:Number(value('scale')||1)});
 const lines=[...result.lines].sort((a,b)=>a.rotation-b.rotation||a.box.y0-b.box.y0||a.box.x0-b.box.x0);
 for(const line of lines)console.log(`${String(line.rotation).padStart(3)}° ${line.confidence.toFixed(0).padStart(3)}  ${line.text}`);
 console.error(`${engine.models.det} + ${engine.models.rec} · ${image.width}×${image.height} · ${lines.length} строк · загрузка ${Math.round(loaded-started)} мс · поиск ${Math.round(result.timings.detectMs)} мс · чтение ${Math.round(result.timings.recognizeMs)} мс · память ${Math.round(process.memoryUsage().rss/1048576)} МБ`);
 if(value('out'))writeFileSync(value('out'),JSON.stringify({...result,offset:image.offset,page:image.page}));
}
