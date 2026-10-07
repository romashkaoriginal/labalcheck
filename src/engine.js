export function normalize(s){return String(s).toLowerCase().replace(/ё/g,'е').replace(/[«»“”"'‘’]/g,'').replace(/[º°]/g,'°').replace(/[–—−]/g,'-').replace(/\s+/g,' ').replace(/\s*([,.:;%/()-])\s*/g,'$1').trim();}
export function compact(s){return normalize(s).replace(/(\d)[,.](?=\d)/g,'$1¤').replace(/-(?=\d)/g,'§').replace(/[^\p{L}\p{N}¤§]/gu,'');}
export function compareText(expected,actual){
  const e=compact(expected),a=compact(actual);
  if(!e)return {status:'manual',coverage:0};
  if(a.includes(e))return {status:'found',coverage:100};
  const tokens=normalize(expected).match(/[\p{L}\p{N}]{2,}/gu)||[];
  const actualWords=new Set(normalize(actual).match(/[\p{L}\p{N}]{2,}/gu)||[]);
  const coverage=tokens.length?Math.round(tokens.filter(t=>actualWords.has(t)).length/tokens.length*100):0;
  const missing=[...new Set(tokens.filter(t=>!actualWords.has(t)))];
  return {status:coverage>=75?'review':'missing',coverage,missing};
}
export function requirementsFromSource(source){
 let rules=[];
 for(const table of source.tables){for(const row of table.slice(1)){if(row.length<3)continue;const [title,constraint,text]=row.map(s=>s.trim());if(!title||title==='1'&&constraint==='2'&&text==='3')continue;rules.push({id:'r'+rules.length,title,constraint,original:text,text,extra:false});}}
 const paragraphs=source.paragraphs||[];const index=paragraphs.findIndex(p=>p.includes('***'));if(index>=0){let text=[paragraphs[index].slice(paragraphs[index].indexOf('***')+3),...paragraphs.slice(index+1)].join('\n').replace(/^\s*Добавить информацию\s*:\s*/i,'').trim();if(text)rules.push({id:'r'+rules.length,title:'Дополнительная информация под ***',constraint:'Обязательное наличие текста',original:text,text,extra:true});}
 return rules;
}
export function variantText(rule,volume){
 const value=volume.replace('.',',');
 if(/^Объем$/i.test(rule.title)&&/[0-9][,.][0-9]\s*л/.test(rule.original))return 'Объем '+value+' л';
 if(/штриховой код/i.test(rule.title)){const lines=rule.original.split('\n');const line=lines.find(s=>new RegExp(value.replace(',','[,.]')+'\\s*л').test(s));if(line)return line.match(/\d{8,14}/)?.[0]||line;}
 return rule.text;
}
export function dimensionChecks(rule,margin=false){
 const title=rule.title.toLowerCase(),c=rule.constraint;
 let checks=[];const add=(label,min,unit='мм')=>checks.push({label,min,unit});
 const minimums=[...c.matchAll(/(?:не менее\s*)?(\d+(?:[,.]\d+)?)\s*мм/gi)].map(m=>Number(m[1].replace(',','.')));
 const percent=c.match(/не менее\s*(\d+(?:[,.]\d+)?)\s*%/i);
 if(percent)add('Площадь предупреждения',Number(percent[1].replace(',','.')),'%');
 else if(/еас/.test(title)&&minimums.length){add('Высота ЕАС',minimums[0]);add('Ширина ЕАС',minimums[0]);}
 else if(/^объем$/i.test(rule.title)&&minimums.length){add('Буквы «Объем»',minimums[0]);if(minimums[1])add('Количество товара',minimums[1]);}
 else if(/окно.*дат/.test(title)&&minimums.length){add('Буквы подписи даты',minimums[0]);if(minimums[1])add('Цифры даты / партии',minimums[1]);}
 else {const match=c.match(/не менее\s*(\d+(?:[,.]\d+)?)\s*мм/i);if(match)add('Высота букв',Number(match[1].replace(',','.')));}
 if(margin)checks=checks.map(x=>({...x,min:x.unit==='мм'&&!/ЕАС/.test(x.label)?Math.round((x.min+.2)*10)/10:x.min}));
 return checks;
}
export function evaluate(rules,actual,{volume='0,7',margin=false,review={},automatic={}}={}){
 return rules.map(rule=>{const expected=variantText(rule,volume);const state=review[rule.id]||{};let comparison=expected==='-'?{status:'na',coverage:0}:compareText(expected,actual);
  if(/знаки|мебиус|рюмка/.test(rule.title.toLowerCase())||!expected)comparison={status:'manual',coverage:0};
  const dimensions=dimensionChecks(rule,margin).map((x,i)=>{const manual=Number.isFinite(state.dimensions?.[i]),value=manual?state.dimensions[i]:automatic[rule.id]?.dimensions?.[i];return {...x,value,estimated:!manual&&Number.isFinite(value),pass:Number.isFinite(value)&&value>=x.min};});
  const textConfirmed=state.textConfirmed===true;
  const failed=state.rejected===true||dimensions.some(x=>!x.estimated&&Number.isFinite(x.value)&&!x.pass);
  const complete=textConfirmed&&dimensions.every(x=>x.pass)&&(!rule.constraint||state.constraintsConfirmed)&&(!/окно.*дат/i.test(rule.title)||state.windowConfirmed);
  const exempt=!expected.trim()&&state.notApplicable&&state.note?.trim();
  return {...rule,expected,comparison,dimensions,state,status:failed?'error':comparison.status==='na'||exempt?'na':complete?'pass':dimensions.some(x=>x.estimated&&!x.pass)||actual&&['missing','review'].includes(comparison.status)?'issue':automatic[rule.id]?.exact?'detected':'pending'};
 });
}
export function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
