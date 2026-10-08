import {isQuantityRule,quantities} from './quantity.js';
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
 let rules=[];
 for(const table of source.tables){for(const row of table.slice(1)){if(row.length<3)continue;const [title,constraint,text]=row.map(s=>s.trim());if(!title||title==='1'&&constraint==='2'&&text==='3')continue;rules.push({id:'r'+rules.length,title,constraint,original:text,text,extra:false});}}
 const paragraphs=source.paragraphs||[];const index=paragraphs.findIndex(p=>p.includes('***'));if(index>=0){let text=[paragraphs[index].slice(paragraphs[index].indexOf('***')+3),...paragraphs.slice(index+1)].join('\n').replace(/^\s*Добавить информацию\s*:\s*/i,'').trim();if(text)rules.push({id:'r'+rules.length,title:'Дополнительная информация под ***',constraint:'Обязательное наличие текста',original:text,text,extra:true});}
 return rules;
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
 const minimums=[...c.matchAll(/(?:не менее\s*)?(\d+(?:[,.]\d+)?)\s*(мм|см|mm|cm)(?!\p{L})/giu)].map(m=>Number(m[1].replace(',','.'))*(/см|cm/i.test(m[2])?10:1));
 const percent=c.match(/не менее\s*(\d+(?:[,.]\d+)?)\s*%/i);
 if(percent)add('Площадь предупреждения',Number(percent[1].replace(',','.')),'%');
 else if(/еас/.test(title)&&minimums.length){add('Высота ЕАС',minimums[0]);add('Ширина ЕАС',minimums[0]);}
 else if(isQuantityRule(rule)&&minimums.length){if(minimums.length>1){add('Буквы «'+rule.title+'»',minimums[0],'мм','quantity_label');add('Количество товара',minimums[1],'мм','quantity');}else add('Количество товара',minimums[0],'мм','quantity');}
 else if(/окно.*дат/.test(title)&&minimums.length){add('Буквы подписи даты',minimums[0],'мм','date_label');if(minimums[1])add('Цифры даты / партии',minimums[1],'мм','date_digits');}
 else if(/не менее/i.test(c)&&minimums.length)add('Высота букв',minimums[0]);
 if(margin)checks=checks.map(x=>({...x,min:x.unit==='мм'&&!/ЕАС/.test(x.label)?Math.round((x.min+.2)*10)/10:x.min}));
 return checks;
}
export function evaluate(rules,actual,{volume='0,7',margin=false,review={},automatic={}}={}){
 return rules.map(rule=>{const expected=variantText(rule,volume);const state=review[rule.id]||{};let comparison=expected==='-'?{status:'na',coverage:0}:compareText(expected,actual);
  if(/знаки|мебиус|рюмка/.test(rule.title.toLowerCase())||!expected)comparison={status:'manual',coverage:0};
  const dimensions=dimensionChecks(rule,margin).map((x,i)=>{const manual=Number.isFinite(state.dimensions?.[i]),value=manual?state.dimensions[i]:automatic[rule.id]?.dimensions?.[i];return {...x,value,estimated:!manual&&Number.isFinite(value),pass:Number.isFinite(value)&&value>=x.min,reason:manual?'':automatic[rule.id]?.measurementNotes?.[i]};});
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
  const statusLabel=quantityIssue?'Проверить количество':dimensions.some(x=>x.estimated&&!x.pass)?'Проверить размеры':comparison.status==='uncertain'?'Неуверенное OCR':null;
  const status=failed?'error':comparison.status==='na'||exempt?'na':complete?'pass':quantityIssue||dimensions.some(x=>x.estimated&&!x.pass)?'issue':comparison.status==='found'?'detected':comparison.status==='all_words'?'words':actual&&['partial','unreadable','uncertain'].includes(comparison.status)?'issue':'pending';
  return {...rule,expected,comparison,dimensions,state,status,quantity,date,statusLabel:status==='issue'?statusLabel:null};
 });
}
export function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
