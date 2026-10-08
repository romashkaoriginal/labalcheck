import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {matchRequirements} from '../src/automatic.js';
import {evaluate} from '../src/engine.js';

const reference=JSON.parse(readFileSync(new URL('../tests/fixtures/sample-human-reference.json',import.meta.url),'utf8'));
const sample=JSON.parse(gunzipSync(readFileSync(new URL('../tests/fixtures/sample-lines-ocr.json.gz',import.meta.url))));
const automatic=matchRequirements(sample.rules,sample.words,'0,7',false,sample.label,true);
const observed=evaluate(sample.rules,sample.actual,{automatic});
const byId=new Map(observed.map(row=>[row.id,row]));
const textLabels={matches:'есть в макете',conditional:'условное требование',not_applicable:'не применяется',graphics:'знаки видны',date_sample_missing:'подпись есть, даты нет'};
const physicalLabels={near_minimum_estimate:'около минимума',above_minimum_estimate:'выше минимума',below_minimum_estimate:'ниже минимума, перепроверить',not_specified:'без порога',requires_market_decision:'решить применимость',requires_symbol_review:'проверить знаки',requires_print_sample:'нужен образец печати'};

if(reference.sections.length!==observed.length||reference.sections.some(section=>!byId.has(section.id))){
 throw new Error('Разделы эталона и результата программы не совпадают');
}

const result=reference.sections.map(section=>{
 const row=byId.get(section.id);
 return {'№':Number(section.id.slice(1))+1,'Раздел':section.name,'Макет: текст':textLabels[section.text],'Макет: размеры/условия':physicalLabels[section.physical],'OCR':row.comparison.status};
});
console.table(result);
const misses=reference.sections.filter(section=>section.text==='matches'&&byId.get(section.id).comparison.status!=='found');
console.log(`Независимый эталон: ${reference.sections.length} разделов; полный обязательный текст виден в ${reference.sections.filter(section=>section.text==='matches').length}.`);
console.log(`OCR не подтверждает ${misses.length} из этих 13 разделов: ${misses.map(section=>section.name).join(', ')||'нет'}.`);
console.log('Статусы «около/ниже минимума» основаны на растровых оценках PDF и требуют проверки исходного печатного макета.');
