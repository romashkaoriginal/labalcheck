// Parse document structure, never use instruction prose as expected label copy.
const clean=value=>String(value??'').trim();
const header=value=>clean(value).toLowerCase().replace(/ё/g,'е');
const titleHeader=s=>/раздел|показатель|элемент|наименование информации/.test(s);
const textHeader=s=>/текст|формулировк|^надпись$/.test(s)&&!(/размер.*надписи/.test(s));
const constraintHeader=s=>/требован|размер|услови|высот|ограничен/.test(s);
const textMarker=/^(?:текст(?:\s+(?:этикетки|для (?:размещения|нанесения)(?: на этикетке)?|на этикетке))?|надпись|формулировка)\s*:\s*(.*)$/i;
const constraintMarker=/^(?:требования(?: к (?:размерам|маркировке))?|размеры|условия|высота(?: шрифта)?)\s*:\s*(.*)$/i;
const sectionMarker=/^(?:раздел|элемент маркировки|показатель)\s*:\s*(.+)$/i;
const sizeSentence=s=>/(?:не менее|не более|минимальн|максимальн|высота шрифта|размер букв)/i.test(s)&&/\d\s*(?:мм|см|%|mm|cm)/i.test(s);

export function parseRequirements(source){
 const rules=[],diagnostics=[],globalConditions=[];
 const add=(title,constraint,text,extra=false,review=false)=>{if(!clean(title)&&!clean(text)&&!clean(constraint))return;rules.push({id:'r'+rules.length,title:clean(title)||'Раздел '+(rules.length+1),constraint:clean(constraint),original:clean(text),text:clean(text),extra,sourceReview:review});};
 const tables=source.tables||[];
 for(const [ti,table] of tables.entries()){
  let columns=null,start=0;
  for(let i=0;i<Math.min(3,table.length);i++){
   const h=table[i].map(header),text=h.findIndex(textHeader),constraint=h.findIndex(constraintHeader),title=h.findIndex(titleHeader);
   if(text>=0&&(constraint>=0||title>=0)&&text!==constraint&&!h.some(s=>/\d\s*(?:мм|см|%)/i.test(s))){columns={title,constraint,text};start=i+1;break;}
  }
  if(!columns&&table.some(row=>row.length>=3)){
   columns={title:0,constraint:1,text:2};
   diagnostics.push(`Таблица ${ti+1}: заголовки не определены. Проверьте назначение столбцов в списке требований.`);
  }
  if(!columns){diagnostics.push(`Таблица ${ti+1}: структура не определена; строки сохранены для ручного разбора.`);for(const row of table)add('Неразобранная строка таблицы',row.map(clean).join(' · '),'',false,true);continue;}
  for(const row of table.slice(start)){
   if(row.every(s=>!clean(s))||row.slice(0,3).map(clean).join('|')==='1|2|3'||row.every(s=>/^[a-z]$/i.test(clean(s))))continue;
   const text=clean(row[columns.text]),constraint=clean(row[columns.constraint]);
   add(columns.title<0?text.slice(0,65):row[columns.title],constraint,text);
  }
 }
 const paragraphs=(source.blocks?.filter(b=>b.type==='paragraph')|| (source.paragraphs||[]).map(text=>({text}))).flatMap(p=>String(p.text||'').split('\n').map(text=>({...p,text}))).filter(p=>clean(p.text));
 let current=null,mode=null,supplement=false,supplementText=[];
 const flush=()=>{if(current){add(current.title,current.constraint.join('\n'),current.text.join('\n'),false,!current.text.length);current=null;}mode=null;};
 for(const p of paragraphs){
  let s=clean(p.text),m;
  if(s.includes('***')){flush();supplement=true;s=s.slice(s.indexOf('***')+3);}
  if(supplement){s=s.replace(/^\s*Добавить информацию\s*:\s*/i,'').trim();if(s)supplementText.push(s);continue;}
  if((m=s.match(sectionMarker))||p.heading||(m=s.match(/^([\p{L}][\p{L}\s/()–-]{2,80}):\s*$/u))){flush();current={title:m?m[1]:s,constraint:[],text:[]};continue;}
  if((m=s.match(textMarker))){if(!current)current={title:'Текст этикетки',constraint:[],text:[]};current.text.push(m[1]);mode='text';continue;}
  if((m=s.match(constraintMarker))){if(!current)current={title:'Условия маркировки',constraint:[],text:[]};current.constraint.push(m[1]);mode='constraint';continue;}
  // Explicit copy instructions may quote the literal inscription.
  if((m=s.match(/^(?:нанести|указать|разместить)(?: на этикетке)?(?: (?:текст|надпись))?\s*:\s*[«“"](.+)[»”"]\s*[.]?$/i))){flush();add('Надпись', '', m[1]);continue;}
  if(current){
   if(sizeSentence(s)){current.constraint.push(s);mode='constraint';}
   else if(mode)current[mode].push(s);
   else if(!/(?:долж[еён]|следует|необходимо|требуется|указать|нанести|разместить|проверить|согласовать)/i.test(s)){current.text.push(s);mode='text';}
   else {current.constraint.push(s);diagnostics.push(`«${current.title}»: текст не помечен как надпись. Сохранён как условие, требуется разбор.`);}
  }else globalConditions.push(s);
 }
 flush();if(supplementText.length)add('Дополнительная информация под ***','Обязательное наличие текста',supplementText.join('\n'),true);
 if(!rules.length&&globalConditions.length){add('Неразобранные требования',globalConditions.join('\n'),'',false,true);diagnostics.push('Не найдены явно обозначенные тексты этикетки. Условия сохранены; укажите ожидаемый текст в редакторе требований.');}
 return {rules,diagnostics,globalConditions};
}
