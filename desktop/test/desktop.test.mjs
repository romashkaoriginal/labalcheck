import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {regions,quarterTurn,lineTensor,uprightSize} from '../src/ocr/imaging.mjs';
import {readConfig,createEngine} from '../src/ocr/engine.mjs';
import {SCHEMA,wordsFromEngine,toAppWords,fromAppWords,validate} from '../shared/ocr-result.mjs';
import {scoreLine,scoreSheet,strict,letters} from '../bench/metrics.mjs';
import {textVerdict,tokenDiff} from '../renderer/compare.js';
import {assess} from '../../src/automatic.js';
import {evaluate} from '../../src/engine.js';

const models=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../models');
const blank=(width,height,value=255)=>({data:new Uint8ClampedArray(width*height*4).fill(value),width,height});
const paint=(image,x0,y0,x1,y1,[r,g,b])=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const p=(y*image.width+x)*4;image.data[p]=r;image.data[p+1]=g;image.data[p+2]=b;image.data[p+3]=255;}};

test('regions of a probability map come back as separate boxes with their mean probability',()=>{
 const width=20,height=10,map=new Float32Array(width*height);
 for(let y=2;y<5;y++)for(let x=1;x<8;x++)map[y*width+x]=.9;
 for(let y=6;y<9;y++)for(let x=12;x<19;x++)map[y*width+x]=.5;
 const found=regions(map,width,height,.3).sort((a,b)=>a.x0-b.x0);
 assert.deepEqual(found.map(box=>[box.x0,box.y0,box.x1,box.y1]),[[1,2,8,5],[12,6,19,9]]);
 assert.ok(Math.abs(found[0].score-.9)<1e-6&&Math.abs(found[1].score-.5)<1e-6);
 assert.equal(regions(map,width,height,.95).length,0);
});

test('a quarter turn puts the top-left pixel in the top-right corner',()=>{
 const image=blank(3,2);paint(image,0,0,1,1,[10,20,30]);
 const turned=quarterTurn(image);
 assert.deepEqual([turned.width,turned.height],[2,3]);
 assert.deepEqual([...turned.data.slice(4,7)],[10,20,30]); // (x=1, y=0)
});

test('a line is turned upright the way its rotation says',()=>{
 // A tall box whose bottom is dark: print reading bottom-to-top starts there.
 const image=blank(10,40);paint(image,0,30,10,40,[0,0,0]);
 const box={x0:0,y0:0,x1:10,y1:40};
 assert.deepEqual(uprightSize(box,90),{width:40,height:10});
 const read=rotation=>{const out=new Float32Array(3*8*32);lineTensor(image,box,rotation,8,32,out,0,32);return out;};
 const up=read(90),down=read(270);
 assert.ok(up[4*32+1]<-.9&&up[4*32+30]>.9,'at 90° the dark end of the line comes first');
 assert.ok(down[4*32+1]>.9&&down[4*32+30]<-.9,'at 270° it comes last');
});

test('the character list of a PaddleOCR model config is read with its quoting',{skip:!existsSync(path.join(models,'eslav_PP-OCRv5_mobile_rec/inference.yml'))&&'models are not downloaded'},()=>{
 const config=readConfig(path.join(models,'eslav_PP-OCRv5_mobile_rec/inference.yml'));
 assert.equal(config.characters.length,517);
 for(const char of ["'",'"','Я','я','ё','№','%'])assert.ok(config.characters.includes(char),`no ${char} in the list`);
 assert.ok(config.characters.every(char=>typeof char==='string'&&[...char].length===1));
 const det=readConfig(path.join(models,'PP-OCRv6_medium_det/inference.yml'));
 assert.deepEqual([det.thresh,det.boxThresh,det.unclipRatio],[.2,.45,1.4]);
});

test('a missing model is reported as an error the interface can show',async()=>{
 await assert.rejects(createEngine({modelsDir:path.join(models,'no-such-folder')}),error=>error.code==='MODEL_MISSING'&&error.stage==='load'&&/npm run models/.test(error.message));
});

test('words of the engine keep their place on the page through the common format and back',()=>{
 const lines=[{text:'СРОК ГОДНОСТИ',rotation:90,confidence:97,box:{x0:20,y0:100,x1:40,y1:300},words:[{text:'СРОК',confidence:98,box:{x0:20,y0:220,x1:40,y1:300}},{text:'ГОДНОСТИ',confidence:96,box:{x0:20,y0:100,x1:40,y1:210}}]}];
 const result={schema:SCHEMA,page:{width:1000,height:2000},words:wordsFromEngine(lines,{crop:{x:100,y:400},zoom:2,pass:'local0-x1'})};
 assert.deepEqual(validate(result),[]);
 assert.deepEqual(result.words[0].box,{x:110,y:510,w:10,h:40});
 assert.equal(result.words[0].pass,'local0-x1:90');
 const app=toAppWords(result);
 assert.deepEqual(app[0].box,{x:.11,y:.255,w:.01,h:.02});
 assert.equal(app[0].ocrEngine,'paddle');
 // In reading order the first word of bottom-to-top print stands to the left of the second.
 assert.ok(app[0].readingBox.x<app[1].readingBox.x);
 const back=fromAppWords(app,result.page);
 assert.ok(Math.abs(back.words[0].box.x-110)<1e-9&&Math.abs(back.words[0].box.h-40)<1e-9);
 assert.equal(back.words[0].source,'ocr');
});

test('the common format refuses words without a place or a direction',()=>{
 const problems=validate({schema:SCHEMA,page:{width:10,height:10},words:[{text:'а',box:{x:0,y:0,w:0,h:1},rotation:45,confidence:120,source:'guess'}]});
 assert.equal(problems.length,4);
});

test('strict text keeps case and punctuation; letters keep neither and join look-alike letters',()=>{
 assert.equal(strict('  «Сан  Ремино» –  0 ºС '),'"Сан Ремино" - 0 °С');
 assert.equal(letters('ООО «BY» 0,75 л'),letters('000 "ВУ" О,75л'));
 assert.notEqual(letters('Е220'),letters('Е224'));
});

test('a line is found inside a longer reading and its errors are counted where they are',()=>{
 const line='углеводы – 7,5 г; энергетическая ценность (калорийность) - 290 кДж (70 ккал).';
 const exact=scoreLine(line,['шум до '+line+' шум после']);
 assert.deepEqual([exact.characterErrors,exact.wordErrors,exact.numberErrors,exact.markErrors],[0,0,0,0]);
 const wrong=scoreLine(line,['углеводы – 7,5 г; энергетическая ценность (калорийность) - 280 кДж (70 ккал)']);
 assert.equal(wrong.characterErrors,2);
 assert.deepEqual(wrong.wrongNumbers,['290']);
 assert.equal(wrong.numberTokenErrors,1);
 assert.equal(wrong.markErrors,1); // the final full stop
 const lost=scoreLine('Е220',['добавку антиокислитель Е22), вода']);
 assert.equal(lost.numberErrors,1);
 const extra=scoreLine('0,75 л',['ОБЪЕМ 10,75 л']);
 assert.equal(extra.numberErrors,1,'a digit added in front of a number makes it another number');
 assert.equal(scoreLine('нет такой строки',['совсем другое']).missed,false);
 assert.equal(scoreLine('абв',[]).missed,true);
});

test('scores add up by tag',()=>{
 const truth={lines:[{text:'СПИРТ 6,8 %',tags:['large','numbers']},{text:'Состав: вода',tags:['small']}]};
 const score=scoreSheet(truth,['СПИРТ 6,8 % Состав вода']);
 assert.equal(score.total.lines,2);
 assert.equal(score.byTag.numbers.numbers,1);
 assert.equal(score.byTag.small.markErrors,1);
});

test('two readings are compared word by word',()=>{
 const diff=tokenDiff('белки 0 г, жиры 0 г, 250 кДж (60 ккал)','белки 0 г жиры 0 г 240 кДж 60 кал');
 assert.equal(diff.different,true);
 assert.deepEqual(diff.left.filter(item=>!item.same).map(item=>item.token),['250','ккал']);
 assert.deepEqual(diff.right.filter(item=>!item.same).map(item=>item.token),['240','кал']);
 assert.equal(tokenDiff('Спирт 6,8 %','СПИРТ 6,8%').different,false);
});

// The verdict about a section is taken from the unchanged comparison of the
// web version. A number that differs from Word must never come out as a match.
test('readings in the common format are judged by the comparison of the web version',()=>{
 const rules=[{id:'r0',title:'Срок годности',text:'Срок годности 24 месяца с даты розлива',original:'Срок годности 24 месяца с даты розлива',constraint:''},{id:'r1',title:'Обязательная надпись',text:'ВРЕДИТ ВАШЕМУ ЗДОРОВЬЮ',original:'ВРЕДИТ ВАШЕМУ ЗДОРОВЬЮ',constraint:''}];
 const word=(text,x,y,line)=>({text,confidence:99,box:{x0:x,y0:y,x1:x+text.length*10,y1:y+20}});
 const lines=[{text:'СРОК ГОДНОСТИ 12 МЕСЯЦЕВ С ДАТЫ РОЗЛИВА',rotation:0,confidence:99,box:{x0:100,y0:100,x1:520,y1:120},words:['СРОК','ГОДНОСТИ','12','МЕСЯЦЕВ','С','ДАТЫ','РОЗЛИВА'].map((text,i)=>word(text,100+i*60,100))},
  {text:'ВРЕДИТ ВАШЕМУ ЗДОРОВЬЮ',rotation:0,confidence:99,box:{x0:100,y0:200,x1:400,y1:220},words:['ВРЕДИТ','ВАШЕМУ','ЗДОРОВЬЮ'].map((text,i)=>word(text,100+i*100,200))}];
 const result={schema:SCHEMA,page:{width:1000,height:1000},words:wordsFromEngine(lines,{pass:'local0-x1'})},label={x:.05,y:.05,w:.9,h:.9};
 const matches=assess({rules,words:toAppWords(result),secondaryWords:[],volume:'0,7',margin:false,label,hasContour:true,edgeProbes:[],page:result.page});
 const rows=evaluate(rules,'x',{volume:'0,7',automatic:matches});
 assert.equal(textVerdict(rows[1],matches.r1),'match');
 assert.notEqual(textVerdict(rows[0],matches.r0),'match','12 months on the label against 24 in Word is not a match');
});
