import {isQuantityRule,quantities} from './quantity.js';
import {parseRequirements} from './requirements.js';
export function normalize(s){return String(s).toLowerCase().replace(/ё/g,'е').replace(/[«»“”"'‘’]/g,'').replace(/[º°]/g,'°').replace(/\s+[–—]\s+(?=\d)/g,' ').replace(/[–—−]/g,'-').replace(/\s+/g,' ').replace(/\s*([,.:;%/()-])\s*/g,'$1').trim();}
export function compact(s){return normalize(s).replace(/(\d)[,.](?=\d)/g,'$1¤').replace(/-(?=\d)/g,'§').replace(/[^\p{L}\p{N}¤§%°]/gu,'');}
export function dehyphenate(s){return String(s).replace(/(\p{L})-\s*(?:[<>|{}\[\]]+\s*)?(\p{L})/gu,'$1$2');}
export function words(s){return (normalize(dehyphenate(s)).match(/-?\d+(?:[,.]\d+)?|[\p{L}]+|[%°]/gu)||[]).map(t=>/^\d+\.\d+$/.test(t)?t.replace('.',','):t).filter(t=>t.length>1||/^[%°лг]$/.test(t));}
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
 let checks=[];const add=(label,min,unit='мм',target='letters')=>checks.push({label,min,unit,target});
 const sizeText=c.split(/формат\s*:|размер(?:ы)?\s+окна\s*:/i)[0];
 const matches=[...sizeText.matchAll(/(\d+(?:[,.]\d+)?)\s*(мм|см|mm|cm)(?!\p{L})/giu)];
 const sizes=matches.map((m,i)=>({min:Number(m[1].replace(',','.'))*(/см|cm/i.test(m[2])?10:1),context:sizeText.slice(i?matches[i-1].index+matches[i-1][0].length:0,m.index).split(/[;\n]/).at(-1),after:sizeText.slice(m.index+m[0].length,Math.min(m.index+m[0].length+45,matches[i+1]?.index??Infinity))})).filter(s=>!/(?:не более|максимальн)[^;]*$/i.test(s.context));
 const minimums=sizes.map(s=>s.min);
 const percent=c.match(/не менее\s*(\d+(?:[,.]\d+)?)\s*%/i);
 if(percent)add('Площадь предупреждения',Number(percent[1].replace(',','.')),'%');
 else if(/еас/.test(title)&&minimums.length){add('Высота ЕАС',minimums[0]);add('Ширина ЕАС',minimums[0]);}
 else if(isQuantityRule(rule)&&minimums.length){for(const [i,s] of sizes.entries()){const label=/термин|букв|подпис/i.test(s.context)&&!/количество[^;]*$/i.test(s.context),target=label?'quantity_label':/количество|цифр|значени/i.test(s.context)?'quantity':sizes.length>1&&i===0?'quantity_label':'quantity';add(target==='quantity_label'?'Буквы «'+rule.title+'»':'Количество товара',s.min,'мм',target);}}
 else if(/окно.*дат/.test(title)&&minimums.length){for(const [i,s] of sizes.entries()){const target=/цифр/i.test(s.context)||/шрифт самих цифр/i.test(s.after)?'date_digits':/букв|подпис/i.test(s.context)||/шрифт букв/i.test(s.after)?'date_label':i===0?'date_label':'date_digits';add(target==='date_digits'?'Цифры даты / партии':'Буквы подписи даты',s.min,'мм',target);}}
 else if(/не менее/i.test(c)&&minimums.length)add('Высота букв',minimums[0]);
 if(margin)checks=checks.map(x=>({...x,min:x.unit==='мм'&&!/ЕАС/.test(x.label)?Math.round((x.min+.2)*10)/10:x.min}));
 return checks;
}
export function evaluate(rules,actual,{volume='0,7',margin=false,review={},automatic={}}={}){
 return rules.map(rule=>{const expected=variantText(rule,volume);const state=review[rule.id]||{};let comparison=expected==='-'?{status:'na',coverage:0}:compareText(expected,actual);
  if(/знаки|мебиус|рюмка/.test(rule.title.toLowerCase())||!expected)comparison={status:'manual',coverage:0};
  const dimensions=dimensionChecks(rule,margin).map((x,i)=>{const manual=Number.isFinite(state.dimensions?.[i]),value=manual?state.dimensions[i]:automatic[rule.id]?.dimensions?.[i],meta=manual?null:automatic[rule.id]?.measurementMeta?.[i],borderline=Number.isFinite(value)&&meta?.pixelStep>0&&Math.abs(value-x.min)<=meta.pixelStep*2;return {...x,value,estimated:!manual&&Number.isFinite(value),pass:Number.isFinite(value)&&value>=x.min,borderline,meta,reason:manual?'':automatic[rule.id]?.measurementNotes?.[i]};});
  const textConfirmed=state.textConfirmed===true;
  const failed=state.rejected===true||dimensions.some(x=>!x.estimated&&Number.isFinite(x.value)&&!x.pass);
  const complete=textConfirmed&&dimensions.every(x=>x.pass&&!x.estimated)&&(!rule.constraint||state.constraintsConfirmed)&&(!/окно.*дат/i.test(rule.title)||state.windowConfirmed);
  const exempt=!expected.trim()&&state.notApplicable&&state.note?.trim();
  const match=automatic[rule.id];
  if(match?.scope==='label'&&expected&&expected!=='-')comparison=compareText(expected,match.words.map(word=>word.text).join(' '));
  if(match?.exact)comparison={status:'found',coverage:100,missing:[]};
  else if(match?.diff?.length)comparison={status:match.diff.every(d=>d.confidence<75)?'uncertain':'partial',coverage:Math.round(Math.max(0,match.similarity??match.coverage/100)*100),wordCoverage:match.coverage,missing:[],changes:match.diff};
  else if(Object.hasOwn(automatic,rule.id)&&comparison.status==='found')comparison={...comparison,status:'all_words',coverage:100,missing:[]};
  const quantity=match?.quantity,date=match?.date;
  const quantityIssue=quantity&&quantity.status!=='match';
  const statusLabel=quantityIssue?'Проверить количество':dimensions.some(x=>x.estimated&&!x.pass)?'Проверить размеры':dimensions.some(x=>x.borderline)?'Пограничный замер':comparison.status==='uncertain'?'Неуверенное OCR':null;
  const status=failed?'error':comparison.status==='na'||exempt?'na':complete?'pass':quantityIssue||dimensions.some(x=>x.estimated&&(!x.pass||x.borderline))?'issue':comparison.status==='found'?'detected':comparison.status==='all_words'?'words':actual&&['partial','unreadable','uncertain'].includes(comparison.status)?'issue':'pending';
  return {...rule,expected,comparison,dimensions,state,status,quantity,date,statusLabel:status==='issue'?statusLabel:null};
 });
}
export function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
