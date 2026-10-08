import {isQuantityRule,quantities} from './quantity.js';
import {parseRequirements} from './requirements.js';
const twins={a:'а',e:'е',o:'о',c:'с',p:'р',x:'х',y:'у',k:'к',m:'м',t:'т',h:'н',b:'в'};
// "BY" typed in Latin and "ВУ" typed in Cyrillic are one and the same print.
export function normalize(s){return String(s).toLowerCase().replace(/ё/g,'е').replace(/[aeocpxykmthb]/g,char=>twins[char]).replace(/[«»“”"'‘’]/g,'').replace(/[º°]/g,'°').replace(/(^|\s)[–—−-]\s+(?=\d)/g,'$1').replace(/[–—−]/g,'-').replace(/\s+/g,' ').replace(/\s*([,.:;%/()-])\s*/g,'$1').trim();}
export function compact(s){return normalize(s).replace(/(\d)[,.](?=\d)/g,'$1¤').replace(/-(?=\d)/g,'§').replace(/[^\p{L}\p{N}¤§%°]/gu,'');}
export function dehyphenate(s){return String(s).replace(/(\p{L})-\s*(?:[<>|{}\[\]]+\s*)?(\p{L})/gu,'$1$2');}
export function words(s){return (normalize(dehyphenate(s)).match(/-?\d+(?:[,.]\d+)?|[\p{L}]+|[%°]/gu)||[]).map(t=>/^\d+\.\d+$/.test(t)?t.replace('.',','):t).filter(t=>t.length>1||/^[%°лг]$/.test(t));}
// Latin and Cyrillic letters of the same shape, and digits OCR swaps for them.
const lookalikes='aаeеoоcсpрxхyуkкmмtтhнbв3з0о6б';
const confusable=new Map([...lookalikes].flatMap((char,i,all)=>i%2?[]:[[char,all[i+1]]]));
export const fold=token=>[...String(token)].map(char=>confusable.get(char)||char).join('');
// The same word in another grammatical form or with one misread letter.
export function alike(a,b){
 if(a===b)return true;const x=fold(a),y=fold(b);if(x===y)return true;
 if(/\d/.test(a)||/\d/.test(b))return false;
 let prefix=0;while(prefix<x.length&&prefix<y.length&&x[prefix]===y[prefix])prefix++;
 if(prefix>=4&&Math.min(x.length,y.length)>=4&&Math.abs(x.length-y.length)<=2&&prefix>=Math.min(x.length,y.length)-2)return true;
 return x.length===y.length&&x.length>=6&&[...x].reduce((n,char,i)=>n+(char!==y[i]),0)<=1;
}
// Which of several minima a sentence falls under: the one whose subject words
// ("срока годности", "условий хранения") occur earliest in it. "Остальной
// текст" takes whatever no other minimum names. -1: undecided.
export function scopeIndex(checks,text){
 // Stems are searched in the text with its spaces removed, so a reading that
 // lost a space ("СРОКТОДНОСТИ") still shows which sentence it is.
 const flat=fold(compact(text)),ranked=[];let rest=-1;
 checks.forEach((check,index)=>{
  if(!check.scope)return;if(/остальн/iu.test(check.scope)){rest=index;return;}
  const positions=words(check.scope).filter(word=>word.length>3).map(word=>flat.indexOf(fold(word).slice(0,4))).filter(at=>at>=0);
  if(positions.length)ranked.push({index,first:Math.min(...positions),hits:positions.length});
 });
 ranked.sort((a,b)=>a.first-b.first||b.hits-a.hits);
 return ranked.length&&(ranked.length===1||ranked[0].first<ranked[1].first)?ranked[0].index:rest;
}
export function compareText(expected,actual){
  const e=compact(dehyphenate(expected)),a=compact(dehyphenate(actual));
  if(!e)return {status:'manual',coverage:0};
  if(a.includes(e))return {status:'found',coverage:100};
  const tokens=words(expected),actualWords=new Set(words(actual));
  const missing=[...new Set(tokens.filter(t=>!actualWords.has(t)))];
  const coverage=tokens.length?Math.round(tokens.filter(t=>actualWords.has(t)).length/tokens.length*100):0;
  return {status:coverage===100?'all_words':coverage>0?'partial':'unreadable',coverage,missing};
}
export function requirementsFromSource(source){
 const parsed=parseRequirements(source);source.diagnostics=parsed.diagnostics;source.globalConditions=parsed.globalConditions;return parsed.rules;
}
export function variantText(rule,volume){
 const value=volume.replace('.',',');
 if(isQuantityRule(rule)){const options=quantities(rule.original);if(options.length>1){const choice=options.find(q=>q.kind==='volume'&&Math.abs(q.baseValue-Number(value.replace(',','.')))<1e-9);if(choice)return rule.original.slice(0,options[0].index).trim()+' '+choice.text;}return rule.text;}
 if(/штриховой код/i.test(rule.title)){const lines=rule.original.split('\n');const line=lines.find(s=>new RegExp(value.replace(',','[,.]')+'\\s*л').test(s));if(line)return line.match(/\d{8,14}/)?.[0]||line;}
 return rule.text;
}
export function dimensionChecks(rule,margin=false){
 const title=rule.title.toLowerCase(),c=rule.constraint;
 let checks=[];const add=(label,min,unit='мм',target='letters',scope='')=>checks.push({label,min,unit,target,...(scope?{scope}:{})});
 const sizeText=c.split(/формат\s*:|размер(?:ы)?\s+окна\s*:/i)[0];
 const matches=[...sizeText.matchAll(/(\d+(?:[,.]\d+)?)\s*(мм|см|mm|cm)(?!\p{L})/giu)];
 const sizes=matches.map((m,i)=>({min:Number(m[1].replace(',','.'))*(/см|cm/i.test(m[2])?10:1),context:sizeText.slice(i?matches[i-1].index+matches[i-1][0].length:0,m.index).split(/[;\n]/).at(-1),after:sizeText.slice(m.index+m[0].length,Math.min(m.index+m[0].length+45,matches[i+1]?.index??Infinity))})).filter(s=>!/(?:не более|максимальн)[^;]*$/i.test(s.context));
 const minimums=sizes.map(s=>s.min);
 const percent=c.match(/не менее\s*(\d+(?:[,.]\d+)?)\s*%/i);
 if(percent)add('Площадь предупреждения',Number(percent[1].replace(',','.')),'%');
 else if(/еас/.test(title)&&minimums.length){add('Высота ЕАС',minimums[0]);add('Ширина ЕАС',minimums[0]);}
 else if(isQuantityRule(rule)&&minimums.length){for(const [i,s] of sizes.entries()){const label=/термин|букв|подпис/i.test(s.context)&&!/количество[^;]*$/i.test(s.context),target=label?'quantity_label':/количество|цифр|значени/i.test(s.context)?'quantity':sizes.length>1&&i===0?'quantity_label':'quantity';add(target==='quantity_label'?'Буквы «'+rule.title+'»':'Количество товара',s.min,'мм',target);}}
 else if(/окно.*дат/.test(title)&&minimums.length){for(const [i,s] of sizes.entries()){const target=/цифр/i.test(s.context)||/шрифт самих цифр/i.test(s.after)?'date_digits':/букв|подпис/i.test(s.context)||/шрифт букв/i.test(s.after)?'date_label':i===0?'date_label':'date_digits';add(target==='date_digits'?'Цифры даты / партии':'Буквы подписи даты',s.min,'мм',target);}}
 else if(/не менее/i.test(c)&&minimums.length){
  for(const [i,size] of sizes.entries()){
   if(sizes.length===1){add('Высота букв',size.min);continue;}
   const context=(size.context+' '+size.after).toLowerCase().replace(/ё/g,'е');
   // "для условий хранения – не менее 0,8 мм": the words before the dash name
   // the sentences this minimum belongs to and later select them.
   const subject=size.context.match(/(?:^|\s)для\s+(?:указания\s+)?([^–—:;\n-]{3,60}?)\s*[–—-]?\s*(?:не\s+менее)?\s*$/iu)?.[1]?.trim();
   const label=/срок.*годност/.test(context)?'Срок годности':/остальн.*текст/.test(context)?'Остальной текст':subject?'Для '+subject.toLowerCase():`Высота букв · условие ${i+1}`;
   add(label,size.min,'мм','partitioned_letters',subject||(/срок.*годност/.test(context)?'срок годности':''));
  }
 }
 if(margin){const extra=typeof margin==='number'?margin:.2;checks=checks.map(x=>({...x,min:x.unit==='мм'&&!/ЕАС/.test(x.label)?Math.round((x.min+extra)*100)/100:x.min}));}
 return checks;
}
// A difference the OCR itself is sure of: another or an extra word read with
// confidence, or a word missing between two words that were both read.
const sureDifference=change=>change.kind==='missing'?change.anchored===true:change.kind!=='uncertain'&&change.confidence>=75;
export function evaluate(rules,actual,{volume='0,7',margin=false,review={},automatic={}}={}){
 return rules.map(rule=>{const expected=variantText(rule,volume);const state=review[rule.id]||{};let comparison=expected==='-'?{status:'na',coverage:0}:compareText(expected,actual);
  if(/знаки|мебиус|рюмка/.test(rule.title.toLowerCase())||!expected)comparison={status:'manual',coverage:0};
  const dimensions=dimensionChecks(rule,margin).map((x,i)=>{const manual=Number.isFinite(state.dimensions?.[i]),value=manual?state.dimensions[i]:automatic[rule.id]?.dimensions?.[i],meta=manual?null:automatic[rule.id]?.measurementMeta?.[i],borderline=Number.isFinite(value)&&meta?.pixelStep>0&&Math.abs(value-x.min)<=meta.pixelStep*2;const declared=automatic[rule.id]?.declared?.[i]||[];return {...x,value,estimated:!manual&&Number.isFinite(value),pass:Number.isFinite(value)&&value>=x.min,borderline,meta,declared,contradicted:!manual&&declared.some(item=>item.level!=='low'&&item.raster?.agrees===false),reason:manual?'':automatic[rule.id]?.measurementNotes?.[i]};});
  const textConfirmed=state.textConfirmed===true;
  const failed=state.rejected===true||dimensions.some(x=>!x.estimated&&Number.isFinite(x.value)&&!x.pass);
  const complete=textConfirmed&&dimensions.every(x=>x.pass&&!x.estimated)&&(!rule.constraint||state.constraintsConfirmed)&&(!/окно.*дат/i.test(rule.title)||state.windowConfirmed);
  const exempt=!expected.trim()&&state.notApplicable&&state.note?.trim();
  const match=automatic[rule.id];
  if(match?.scope==='label'&&expected&&expected!=='-')comparison=compareText(expected,match.words.map(word=>word.text).join(' '));
  if(match?.exact)comparison={status:'found',coverage:100,missing:[]};
  else if(match?.diff?.length)comparison={confident:match.diff.some(sureDifference),status:match.diff.some(sureDifference)?'partial':'uncertain',coverage:Math.round(Math.max(0,match.similarity??match.coverage/100)*100),wordCoverage:match.coverage,missing:[],changes:match.diff};
  else if(Object.hasOwn(automatic,rule.id)&&comparison.status==='found')comparison={...comparison,status:'all_words',coverage:100,missing:[]};
  const quantity=match?.quantity,date=match?.date;
  const quantityIssue=quantity&&quantity.status!=='match';
  const numericDifference=match?.diff?.some(change=>change.kind==='replace'&&change.confidence>=80&&(/\d/.test(change.expected)&&/\d/.test(change.actual))&&((change.expected.match(/\d+(?:[,.]\d+)*/g)||[]).join('|')!==(change.actual.match(/\d+(?:[,.]\d+)*/g)||[]).join('|')));
  const declaredLow=dimensions.some(x=>x.declared.some(item=>item.level!=='low'&&item.passes===false));
  const notation=match?.exact&&match.notation;
  const statusLabel=quantityIssue?'Проверить количество':notation?'Другая запись единицы':numericDifference?'Проверить число':dimensions.some(x=>x.estimated&&!x.pass)||declaredLow?'Проверить размеры':comparison.confident?'Отличие текста':dimensions.some(x=>x.contradicted)?'Выноска ≠ замер':dimensions.some(x=>x.borderline)?'Пограничный замер':comparison.status==='uncertain'?'Неуверенное OCR':null;
  const status=failed?'error':comparison.status==='na'||exempt?'na':complete?'pass':quantityIssue||notation||declaredLow||dimensions.some(x=>x.contradicted||x.estimated&&(!x.pass||x.borderline))?'issue':comparison.status==='found'?'detected':comparison.status==='all_words'?'words':actual&&['partial','unreadable','uncertain'].includes(comparison.status)?'issue':'pending';
  return {...rule,expected,comparison,dimensions,state,status,quantity,date,statusLabel:status==='issue'?statusLabel:null};
 });
}
export function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
