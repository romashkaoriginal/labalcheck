import {unzipSync,strFromU8} from 'fflate';
import * as pdfjs from 'pdfjs-dist';
import {createWorker} from 'tesseract.js';
import {suggestedHeightMargin,raisedText} from './requirements.js';
import {requirementsFromSource,evaluate,compareText,comparePunctuation,variantText,escapeHtml as esc} from './engine.js';
import {detectFrames, refineFrame, detectArtworkRegion, segmentInk, wordsFromOcr, matchRequirements, assess} from './automatic.js';
import {scanEan13} from './barcode.js';
import {refinementAreas,pageReadingBox,edgePlaces} from './phrase.js';
import {seedBlocks,blockLines,printOnly} from './lines.js';
import {quantityReadAreas,quantities,isQuantityRule,numericInk,recoverNumericReading,insideLabel} from './quantity.js';
import {readCallouts,linkClaims,verifyOnLabel,applyDeclaredDimensions,statedAreaShare} from './callouts.js';
import {imageDensity,resolveScale,declaredLabelSize} from './scale.js';
pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.min.mjs',location.href).href;

const paths={check:'M9 12l2 2 4-4 M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z',file:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',scan:'M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M3 12h18',book:'M4 3h7a3 3 0 0 1 3 3v15a4 4 0 0 0-4-3H4z M14 6a3 3 0 0 1 3-3h4v15h-3a4 4 0 0 0-4 3',upload:'M12 16V3 M7 8l5-5 5 5 M4 15v5h16v-5',download:'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',ruler:'M3 17L17 3l4 4L7 21z M7 13l3 3 M11 9l3 3 M15 5l3 3',plus:'M12 5v14 M5 12h14',info:'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',x:'M6 6l12 12 M18 6L6 18',chevron:'M9 5l7 7-7 7',alert:'M12 9v4 M12 17h.01 M10 3L2 19a1 1 0 0 0 1 2h18a1 1 0 0 0 1-2L14 3a2 2 0 0 0-4 0',clock:'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',crop:'M6 3v15h15 M3 6h15v15',rotate:'M3 10a9 9 0 1 1 2 8 M3 3v7h7',eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',trash:'M3 6h18 M8 6V3h8v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7'};
const icon=(name,cls='')=>`<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`;
const app=document.querySelector('#app');
const state={tab:'check',category:'Водка',volume:'0,7',product:'',rules:[],sourceName:'',fileName:'',image:null,pdf:null,page:1,pages:1,label:null,width:0,height:0,full:false,zoom:100,actual:'',origin:'',review:{},margin:false,marginAmount:.2,selected:'r0',filter:'all',busy:false,progress:0,busyMessage:'',edited:false,error:'',geometryConfirmed:false,words:[],secondaryWords:[],matches:{},calloutReadings:[],annotations:[],hasContour:false,pageMm:null,scale:null,density:null,analysisNote:''};
let worker=null,workerLanguage='',ocrGeneration=0;
const statuses={pass:['Проверено','success'],na:['Не применяется','neutral'],error:['Несоответствие','danger'],issue:['Проверить OCR','warning'],pending:['Нужна проверка','neutral'],detected:['Текст найден','success'],words:['Слова найдены','neutral']};
const comparisonNames={found:'Текст совпадает с требованиями',all_words:'Все слова найдены; порядок не подтверждён',partial:'Есть отличия в чтении OCR',uncertain:'Спорное чтение текста',unreadable:'OCR не прочитал слова',manual:'Проверяется вручную',na:'Не применяется'};
const toast=(message)=>{const el=document.querySelector('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('visible'),4000);};
function rows(){return evaluate(state.rules,state.actual,{volume:state.volume,margin:state.margin?state.marginAmount:false,review:state.review,automatic:state.matches});}
function render(){
 const listScroll=document.querySelector('.rule-list')?.scrollTop;
 const result=rows(),passed=result.filter(r=>['pass','detected','words'].includes(r.status)).length,issues=result.filter(r=>['error','issue'].includes(r.status)).length,pending=result.filter(r=>r.status==='pending').length;
 const selected=result.find(r=>r.id===state.selected)||result[0];
 const allDone=result.length>0&&result.every(r=>['pass','na'].includes(r.status))&&state.geometryConfirmed;
 app.innerHTML=`<aside class="sidebar"><a class="brand" href="#" aria-label="Контроль маркировки">${icon('scan')}<span>label<span class="brand-light">check</span><small>КОНТРОЛЬ МАРКИРОВКИ</small></span></a><div class="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div><nav aria-label="Основная навигация">${[['check','scan','Проверка макета'],['requirements','book','Требования'],['method','info','Как проверять']].map(([id,i,t])=>`<button class="nav-item ${state.tab===id?'active':''}" data-tab="${id}" ${state.busy?'disabled':''}>${icon(i)}<span>${t}</span>${id==='check'?'<span class="nav-count">1</span>':''}</button>`).join('')}</nav><div class="side-divider"></div><div class="workspace-label">ПРОДУКЦИЯ</div><div class="category-list">${['Водка','Виски','Настойки','Вино','Другая продукция'].map((c,i)=>`<button class="category ${state.category===c?'active':''}" data-category="${c}" ${state.busy?'disabled':''}><span class="category-mark">${['В','W','Н','V','+'][i]}</span>${c}${state.category===c?icon('chevron'):''}</button>`).join('')}</div><div class="side-bottom">${icon('check')}<div><strong>Файлы остаются у вас</strong><p>Обработка в браузере.<br>Без отправки документов.</p></div></div><div class="side-account"><span class="avatar">СК</span><div><strong>Специалист по качеству</strong><small>Рабочее место</small></div></div></aside>
 <div class="main"><header class="topbar"><div class="crumb">Рабочее пространство <span>/</span> <strong>${state.tab==='check'?'Проверка макета':state.tab==='requirements'?'Требования':'Как проверять'}</strong></div><span class="local-badge">Обработка в браузере</span></header>
 <main class="content"><div class="heading"><div><h1>${state.tab==='check'?'Проверка контрэтикетки':state.tab==='requirements'?'Требования к маркировке':'Как проходит проверка'}</h1><p>${state.tab==='check'?'Загрузите требования и макет. Сайт найдёт текстовые блоки и сверит требования.':state.tab==='requirements'?'Источник проверки — ваши требования в DOCX или TXT.':'Текст, физические размеры и знаки проверяются отдельно.'}</p></div>${state.tab!=='method'?`<button class="button secondary" id="export" ${state.busy?'disabled':''}>${icon('download')}Скачать отчёт</button>`:''}</div>
 ${state.sourceDiagnostics?.length?`<div class="notice" role="status">${icon('info')}<span>Проверьте разбор требований: ${state.sourceDiagnostics.map(esc).join(' ')}</span></div>`:''}
 ${state.error?`<div class="notice danger-notice" role="alert">${icon('alert')}<span>${esc(state.error)}</span><button class="icon-button" id="dismiss-error" aria-label="Закрыть сообщение">${icon('x')}</button></div>`:''}
 ${state.tab==='check'?checkView(result,selected,{passed,issues,pending,allDone}):state.tab==='requirements'?requirementsView():methodView()}
 <footer class="footer"><span>Проверка по предоставленным требованиям</span><span>Решение о согласовании принимает специалист</span></footer></main></div>
 <input type="file" id="docx-input" accept=".docx,.txt" hidden><input type="file" id="art-input" accept=".pdf,image/png,image/jpeg,image/webp" hidden>`;
 bind(); if(state.tab==='check'){if(listScroll!=null&&document.querySelector('.rule-list'))document.querySelector('.rule-list').scrollTop=listScroll;drawPreview(state.previewFocus);state.previewFocus=false;}
}
function phraseView(rule){
 const match=state.matches[rule.id];if(!match||match.method==='manual')return '';
 if(!match.recognizedText)return '<p class="muted">Слова найдены в отдельных участках. Связную фразу автоматически восстановить пока не удалось.</p>';
 const explanation=match.exact?(match.notation?`Слова и числа совпадают с Word, но единица записана иначе: в Word «${match.notation.expected}», на макете «${match.notation.printed}». Величина та же; допустима ли такая запись, решает специалист.`:match.method==='quantity'?'Термин, числовое значение и единица найдены отдельно. Количество сопоставлено с выбранным вариантом столбца 3.':match.method==='independent-ocr'?'Второе OCR независимо прочитало фразу в том же месте. Первое чтение было неуверенным; оба чтения показаны ниже.':match.method==='barcode'?'EAN-13 считан из полос штрихкода. Номер совпадает с Word; контрольная цифра верна.':match.method==='fragments'?`Фрагменты требования (${match.fragments}) найдены и совпадают по словам и порядку внутри каждого фрагмента.`:match.method==='consensus'?'Фраза восстановлена по координатам и нескольким чтениям одного участка. Слова и их порядок совпадают с Word.':'Порядок слов восстановлен по строкам макета. Текст совпадает с требованием с учётом регистра, переносов и записи чисел.'):rule.comparison.status==='uncertain'?'Некоторые символы OCR прочитал неуверенно. Это не доказывает расхождение с макетом; проверьте указанные места по оригиналу.':rule.comparison.confident?'Это наиболее близкая фраза на макете. Отличия ниже прочитаны уверенно, но и уверенное чтение бывает ошибочным: решение принимается после сверки с оригиналом.':'Это наиболее близкая фраза на макете после повторного чтения. Ниже показаны отличия распознанного текста.';
 return `<div class="phrase-review ${rule.comparison.status==='uncertain'?'uncertain':''}"><h3>${rule.comparison.status==='uncertain'?'Черновое чтение OCR':'Найденная фраза'}</h3><div class="found-phrase">${esc(match.recognizedText).replace(/\n/g,'<br>')}</div><p>${explanation}</p>${match.ocrEvidence?`<div class="phrase-differences"><div class="difference-head"><span>Основное OCR</span><span>Независимое OCR</span></div><div class="difference-row"><span>${esc(match.ocrEvidence.primary)}</span><span>${esc(match.ocrEvidence.secondary)}</span></div></div>`:''}${match.diff?.length?`<div class="phrase-differences" aria-label="Отличия распознанной фразы"><div class="difference-head"><span>В Word</span><span>${rule.comparison.status==='uncertain'?'Спорно':'Распознано'}</span></div>${match.diff.slice(0,12).map(d=>`<div class="difference-row"><span>${esc(d.expected||'Нет в требовании')}</span><span>${esc(d.actual||(d.anchored?(d.edge?(d.edge.blank?`Нет на макете: место ${d.edge.side==='leading'?'перед':'после'} «${d.edge.beside}» перечитано крупнее, там пусто`:`Нет на макете: на месте ${d.edge.side==='leading'?'перед':'после'} «${d.edge.beside}» напечатано другое — «${d.edge.seen.join(' / ').slice(0,80)}»`):'Нет на макете: соседние слова прочитаны'):d.edge?.reread?.length?`Не вошло в прочитанную фразу; при повторном чтении места ${d.edge.side==='leading'?'перед':'после'} «${d.edge.beside}» прочитано «${d.edge.reread.join(' / ').slice(0,80)}» — сверьте по макету`:'Не найдено: нет на макете либо не прочитано OCR'))}${d.kind==='uncertain'?' (похожие знаки, неуверенное чтение)':d.expected===d.actual?' (низкая уверенность)':''}</span></div>`).join('')}${match.diff.length>12?`<p>Ещё ${match.diff.length-12} отличий. Сверьте фрагмент целиком.</p>`:''}</div>`:''}</div>`;
}
function punctuationView(rule){
 const found=state.matches[rule.id]?.recognizedText;
 if(!found||!rule.expected)return '';
 const result=comparePunctuation(rule.expected,found);
 if(!result)return '<p class="punctuation-note">Регистр букв не влияет на совпадение. Знаки препинания сохранены в найденной фразе; при неполном чтении сверьте их по макету.</p>';
 if(!result.checked&&!result.differences.length)return '';
 return `<div class="punctuation-note"><strong>Знаки препинания</strong><p>${result.differences.length?'OCR прочитал знаки иначе или пропустил их. Сверьте с макетом; это само по себе не считается подтверждённой ошибкой.':'В прочитанной фразе знаки совпадают с Word.'} Регистр букв при сравнении не учитывается.</p>${result.differences.length?`<ul>${result.differences.slice(0,8).map(d=>`<li>После «${esc(d.word)}»: Word «${esc(d.expected)}», OCR «${esc(d.actual)}»</li>`).join('')}</ul>`:''}</div>`;
}
function quantityView(rule){
 const q=rule.quantity;if(!q)return '';
 const label=q.expected?`${format(q.expected.value)} ${q.expected.unit}`:'Не выбран вариант из Word',actual=q.actual?`${format(q.actual.value)} ${q.actual.unit}`:'Не прочитано';
 const verdict={match:'Значение и единица совпадают с Word',equivalent:'Количество эквивалентно после пересчёта, но единица записи отличается от Word',wrong_value:'Числовое значение отличается от Word',wrong_unit:'Единица относится к другой величине',wrong_quantity:'Количество после пересчёта отличается от Word',ambiguous:'Несколько вариантов или неоднозначное чтение. Проверьте макет и выбранный объём',unreadable:'Количество не прочитано уверенно'}[q.status];
 return `<div class="quantity-review"><h3>Количество и единица измерения</h3><dl><div><dt>Требования · выбранный вариант</dt><dd>${esc(label)}</dd></div><div><dt>На макете</dt><dd>${esc(actual)}</dd></div></dl><p class="${q.status==='match'?'quantity-match':'quantity-attention'}">${esc(verdict)}</p><p class="muted">Пример количества из столбца 2 не заменяет значение из столбца 3. Запятая, точка и обозначения л / L / l учитываются при сравнении.</p></div>`;
}
// The second figure for the share of the warning: the printer's formula, with
// stated numbers and raster measurements named apart.
function formulaText(f){
 const mm2=value=>`${format(value>=1000?Math.round(value):Math.round(value*10)/10)} мм²`,share=value=>`${format(Math.round(value*10)/10)} %`,s=f.stated,parts=[`Второй показатель — по формуле типографии «S надписи / S этикетки${f.exclusion?', исключая '+f.exclusion:''}».`];
 if(s.inscription&&s.base)parts.push(`По числам техлиста (заявлено, не измерено): ${mm2(s.inscription)} / ${mm2(s.base)} = ${share(s.share)}; база ${mm2(s.base)} получена из заявленных «${format(f.percent)} % = ${mm2(s.threshold)}».`);
 else if(s.inscription)parts.push(`На техлисте заявлена площадь надписи ${mm2(s.inscription)}; базу для процента типография не указала.`);
 if(f.measured){
  if(s.inscription)parts.push(`По растру прямоугольник надписи ≈ ${mm2(f.measured.inscription)}: с заявленным ${f.inscriptionAgrees?'согласуется':'расходится'}.`);
  if(f.excluded)parts.push(`Контур этикетки по растру ≈ ${mm2(f.measured.label)}, значит из базы исключено ≈ ${mm2(f.excluded.area)} (${share(f.excluded.part)} контура). ${f.exclusion?'Зону «'+f.exclusion+'»':'Исключённую зону'} программа на макете не измеряет: это число типографии.`);
  if(f.mixed)parts.push(`Смешанная оценка — надпись по растру к базе типографии: ≈ ${share(f.mixed.share)}.`);
 }
 parts.push(`По прямоугольнику ко всему контуру${f.measured?' ≈ '+share(f.measured.share):' значение не измерено'}. Какая методика применима, решает специалист.`);
 return parts.join(' ');
}
function measurementDetail(rule,d){
 const q=rule.quantity;
 let detail=d.target==='quantity'&&q?`Цифры: ${Number.isFinite(q.numberHeight)?'≈ '+format(q.numberHeight)+' мм':'не измерены'} · единица «${esc(q.actual?.unit||'—')}»: ${Number.isFinite(q.unitHeight)?'≈ '+format(q.unitHeight)+' мм':'не измерена'}. Поле показывает меньшую высоту. `:'';
 if(d.meta?.method==='declared')detail+=`Источник: выноска технического листа${d.meta.count>1?` (выносок для этой проверки: ${d.meta.count})`:''}, а не замер. Число прочитано OCR с уверенностью ${Math.round(d.meta.ocrConfidence)}%, уверенность привязки к надписи — ${levelNames[d.meta.level]}. Высота букв на этикетке при этом не измерена. `;
 // A measured value keeps its own source; the printer's statement is shown beside it.
 const stated=(d.declared||[]).filter(item=>item.level!=='low');
 if(stated.length&&d.meta?.method!=='declared')detail+=`Типография на техлисте заявляет: ${stated.map(item=>(item.comparator&&item.comparator!=='='?item.comparator+' ':'')+format(item.value)+' '+d.unit+(item.areas?.length?` (площади ${item.areas.map(format).join(' и ')} мм²)`:'')+(item.scope==='line'?' — только для строки «'+(item.nearText||'').slice(0,40)+'»':'')).join('; ')}. ${d.contradicted?'Выноска расходится с оценкой по растру той же надписи: проверьте число и привязку. ':stated.some(item=>item.raster?.agrees)?'Оценка по растру той же надписи с выноской согласуется. ':''}`;
 if(d.target==='date_digits'&&rule.date?.text)detail+='Найденные цифры: '+rule.date.text+'. ';
 if(d.meta?.method==='rectangle')detail+='Площадь прямоугольника вокруг всей надписи / площадь прямоугольного контура этикетки × 100. Это оценка занимаемого блока, не площадь чернил. Для фигурной этикетки и иного способа расчёта нужен отдельный замер.';
 if(d.formula)detail+=' '+formulaText(d.formula);
 if(d.meta?.method==='raster-glyphs')detail+=`Оценка видимой высоты, не кегль. ${d.target==='letters'?'Для обычного текста берётся типичная высота букв каждого найденного слова и наименьшая из этих высот; это не замер каждой буквы. ':''}${d.meta.pixelStep?`Шаг растра для замера ${format(d.meta.pixelStep)} мм/пиксель; два пикселя ≈ ${format(d.meta.pixelStep*2)} мм. `:''}Это разрешение, а не гарантия общей погрешности: границы OCR, фон и форма букв также влияют на результат.${d.meta.pixelStep>=.07?' Уточнить высоту точнее шага растра не удаётся надёжно: на модельных буквах известной высоты при 300 dpi замер по сглаженно увеличенной строке ошибается на 0,02–0,04 мм и завышает до 0,05 мм у округлых букв, а разбор краёв в градациях серого для букв до 1 мм не точнее. Различить 0,80 и 0,85 мм по такому растру нельзя.':''}`;
 if(d.borderline)detail+=' Значение близко к минимуму с учётом разрешения: нужен контроль по оригиналу.';
 if(d.reason)detail+=d.reason;
 return detail?`<p class="measurement-note">${esc(detail)}</p>`:'';
}
const levelNames={high:'высокая',medium:'средняя',low:'низкая',none:'нет'};
const claimText=claim=>claim.kind==='height'?`${format(claim.value)} мм`:claim.kind==='box'?`${format(claim.values[0])} × ${format(claim.values[1])} мм`:claim.kind==='percent'?`${claim.comparator==='='?'':claim.comparator+' '}${format(claim.value)} %${claim.areas?.length?` (площади: ${claim.areas.map(format).join(' и ')} мм²)`:''}`:claim.raw;
// Why the number and the link are (not) trusted, in plain words.
const calloutBasis=item=>[`число: OCR ${Math.round(item.confidence)}%${item.reads>1?', повторное чтение совпало':''}${item.marksAgree===false?', десятичный знак не подтверждён пикселями':''}`,item.target?(item.target.via==='gauge'?'привязка: линии размера у надписи':'привязка: надпись вплотную к выноске'):item.links.some(link=>link.semantic)?'привязка: по смыслу выноски':'указатель не найден'].join(' · ');
const calloutVerdict=link=>link.format?'Формат совпадает с допустимым в Word':link.checks.length?link.checks.map(check=>`${check.label}: ${check.passes===false?'ниже минимума':check.passes?'не ниже минимума':'сверка невозможна'} ${format(check.minimum)} ${check.unit}`).join('; '):'В Word нет минимума для этой надписи';
const calloutNotes=(item,link)=>[link.raster?`По растру этой же надписи на этикетке ≈ ${format(link.raster.value)} мм — ${link.raster.agrees?'согласуется с выноской':'расходится с выноской'}.`:'',link.scope==='line'?'Относится только к этой строке: остальной текст раздела другого размера, поле размера не заполняется.':'',item.shared?'Одна выноска на строку с несколькими разделами.':''].filter(Boolean).join(' ');
function annotationView(rule){
 const items=state.annotations.filter(item=>item.links.some(link=>link.ruleId===rule.id));
 if(!items.length)return '';
 return `<div class="annotation-review"><h3>Выноски техлиста для этого раздела</h3>${items.map(item=>{const link=item.links.find(entry=>entry.ruleId===rule.id),notes=calloutNotes(item,link);
  return `<div class="annotation-reading"><strong>${esc(claimText(item.claim))}</strong><span class="${link.checks.some(check=>check.passes===false)||link.raster?.agrees===false?'annotation-fail':'annotation-claim'}">${esc(calloutVerdict(link))}</span><small>${item.targetText?'Указывает на: «'+esc(item.targetText.slice(0,120))+'»':'Надпись рядом не определена'} · уверенность ${levelNames[item.level]} (${esc(calloutBasis(item))})</small>${notes?`<small>${esc(notes)}</small>`:''}</div>`;}).join('')}<p>Это числа, заявленные типографией на техническом листе. Они сравниваются с минимумами Word, но не являются измерением напечатанных букв.</p></div>`;
}
const calloutRows=()=>state.annotations.map(item=>{
 const sections=item.links.map(link=>`${esc(state.rules.find(rule=>rule.id===link.ruleId)?.title.replace(/\s+/g,' ')||'')}: ${esc(calloutVerdict(link))}${calloutNotes(item,link)?' '+esc(calloutNotes(item,link)):''}`).join('<br>')||esc(item.reason||'');
 return `<tr><td>${esc(claimText(item.claim))}</td><td>${item.targetText?'«'+esc(item.targetText.slice(0,90))+'»':'—'}</td><td>${sections}</td><td>${levelNames[item.level]}<br><small>${esc(calloutBasis(item))}</small></td></tr>`;}).join('');
const calloutCounts=()=>{const all=state.annotations,unread=all.filter(item=>item.claim.kind==='unreadable').length,checked=all.filter(item=>item.links.some(link=>link.checks.length||link.format)).length,linked=all.filter(item=>item.links.length).length;return {read:all.length-unread,unread,checked,plain:linked-checked,loose:all.length-unread-linked};};
function annotationOverview(){
 if(!state.annotations.length)return '';
 const n=calloutCounts();
 return `<details class="annotation-overview"><summary>Выноски размеров на техническом листе: прочитано ${n.read} · сверено с минимумами Word ${n.checked} · отнесено к разделам без минимума ${n.plain} · надписи нет в Word или привязка не найдена ${n.loose}${n.unread?` · число не прочитано ${n.unread}`:''}</summary><p>Выноска — заявление типографии о размере. Программа читает число, находит надпись, на которую выноска указывает линиями размера или расположением, и сравнивает число с минимумом Word. Это не замер букв: по растру этикетки размер оценивается отдельно и только при подтверждённом масштабе.</p><div class="table-wrap"><table class="callout-table"><thead><tr><th>Выноска</th><th>Указывает на</th><th>Раздел Word и сверка</th><th>Уверенность</th></tr></thead><tbody>${calloutRows()}</tbody></table></div></details>`;
}
function annotationReport(){
 if(!state.annotations.length)return '';
 return `<h2>Размеры, заявленные выносками на техническом листе</h2><p>Числа из выносок — заявление типографии, а не физический замер букв. Привязка выноски к надписи определена по линиям размера или по расположению; уверенность указана в последнем столбце.</p><table><thead><tr><th>Выноска</th><th>Указывает на</th><th>Раздел Word и сверка</th><th>Уверенность</th></tr></thead><tbody>${calloutRows()}</tbody></table>`;
}
// Where millimetres come from and how far they can be trusted.
function scaleText(){
 const scale=state.scale,size=scale?.declared?`${format(scale.declared[0])} × ${format(scale.declared[1])} мм`:'';
 if(!scale)return 'Масштаб определяется во время проверки макета.';
 const contour=scale.label&&state.hasContour?`Найденный контур этикетки ≈ ${format(scale.label.width)} × ${format(scale.label.height)} мм.`:'Контур этикетки не определён; доля площади не рассчитывается.';
 if(scale.source==='pdf')return `Миллиметры рассчитаны из геометрии страницы PDF при печати 1:1 (страница ${format(state.pageMm.width)} × ${format(state.pageMm.height)} мм). ${state.pdfRaster?`Страница PDF — это одна картинка ≈ ${Math.round(state.pdfRaster.dpi)} dpi, а не кривые: шаг растра ${(25.4/state.pdfRaster.dpi).toFixed(3).replace('.',',')} мм/пиксель, и увеличение при чтении не добавляет деталей. `:''}${contour}${size?` На листе заявлен размер ${size}: ${scale.fits?'контур ему соответствует.':'контур ему не соответствует — проверьте, тот ли контур найден.'}`:''} Высота букв оценивается по видимым символам, а не по кеглю.`;
 if(scale.source==='density+declared')return `В файле указано разрешение ${Math.round(scale.density.x)} dpi. Оно подтверждено независимо: на листе заявлен размер этикетки ${size}, а найденный контур при этом разрешении даёт ≈ ${format(scale.label.width)} × ${format(scale.label.height)} мм. Шаг растра ${format(scale.mmPerPixel)} мм/пиксель, поэтому оценки высоты мелких букв грубые (не точнее ±${format(scale.mmPerPixel*2)} мм).`;
 if(scale.source==='declared')return `Подтверждённого разрешения в файле нет. Масштаб выведен из заявленного на листе размера этикетки ${size} и найденного контура; второго независимого источника нет, поэтому миллиметры ориентировочные. ${contour}`;
 return `У изображения нет достоверного физического масштаба. ${scale.reason||''} Высота букв по растру не оценивается; доступны только числа из выносок техлиста.`;
}
const scaleBadge=()=>!state.scale?'':state.scale.source==='pdf'?'<span class="mini-success">из PDF</span>':state.scale.source==='density+declared'?'<span class="mini-success">подтверждён</span>':state.scale.source==='declared'?'<span class="tag">по размеру этикетки</span>':'<span class="tag">не определён</span>';
function checkView(result,selected,counts){return `
 <section class="document-bar" aria-label="Документы проверки"><div class="doc-slot"><span class="file-icon word">W</span><div><span class="field-caption">Требования · DOCX / TXT</span><strong title="${esc(state.sourceName)}">${esc(state.sourceName)}</strong><small>${state.rules.length} разделов · текст, размеры и условия</small></div><button class="text-button" id="upload-docx" ${state.busy?'disabled':''}>Заменить</button></div><div class="doc-slot"><span class="file-icon pdf">PDF</span><div><span class="field-caption">Макет контрэтикетки</span><strong title="${esc(state.fileName)}">${esc(state.fileName||'Выберите макет')}</strong><small>${state.pages} стр. · ${state.origin||'распознавание ещё не выполнено'}</small></div><button class="text-button" id="upload-art" ${state.busy?'disabled':''}>Заменить</button></div></section>
 <section class="product-bar"><label class="mobile-category">Категория<select id="category-picker">${['Водка','Виски','Настойки','Вино','Другая продукция'].map(c=>`<option ${state.category===c?'selected':''}>${c}</option>`).join('')}</select></label><label>Продукт<input id="product" placeholder="Введите название" value="${esc(state.product)}" ${state.busy?'disabled':''}></label><label>Объём, л<input id="volume" value="${esc(state.volume)}" list="volumes" ${state.busy?'disabled':''}><datalist id="volumes"><option value="0,2"><option value="0,5"><option value="0,7"><option value="1,0"></datalist></label><label class="margin-toggle"><input type="checkbox" id="margin" ${state.margin?'checked':''} ${state.busy?'disabled':''}><span>Запас высоты +${format(state.marginAmount)} мм<small>${state.marginSuggested?'Указан в Word':'Настройка проверки'}</small></span></label><button class="button primary" id="recognize" ${state.busy||!state.image?'disabled':''}>${icon('scan')}${state.busy?'Распознавание…':state.actual?'Проверить ещё раз':'Проверить макет'}</button></section>
 ${state.busy?`<div class="progress-panel" role="status"><div><span>${esc(state.busyMessage)}</span><strong>${Math.round(state.progress*100)}%</strong></div><progress value="${state.progress}" max="1"></progress></div>`:''}
 <div class="metrics"><div class="metric main-metric"><span class="metric-icon">${icon('file')}</span><div><small>Разделов в требованиях</small><strong>${result.length}<span>всего</span></strong></div></div><div class="metric"><span class="metric-icon success">${icon('check')}</span><div><small>Текст / слова найдены</small><strong>${counts.passed}<span>разделов</span></strong></div></div><div class="metric"><span class="metric-icon warning">${icon('alert')}</span><div><small>Требуют внимания</small><strong>${counts.issues}<span>разделов</span></strong></div></div><div class="metric"><span class="metric-icon neutral">${icon('clock')}</span><div><small>Ожидают проверки</small><strong>${counts.pending}<span>разделов</span></strong></div></div></div>
 <div class="result-banner ${counts.allDone?'complete':''}">${icon(counts.allDone?'check':'info')}<div><strong>${counts.allDone?'Все разделы подтверждены специалистом':'Макет пока не согласован'}</strong><span>${counts.allDone?'Все тексты и размеры подтверждены. Отчёт готов к передаче.':state.actual?'Блоки найдены автоматически. Выберите требование, чтобы увидеть соответствующий текст на макете.':'Нажмите «Проверить макет». Поиск этикетки и текста выполняется автоматически.'}</span></div><span class="status ${counts.allDone?'success':'neutral'}">${counts.allDone?'Проверено':'На проверке'}</span></div>
 ${annotationOverview()}
 <div class="work-grid"><section class="panel preview-panel"><div class="panel-heading"><h2>${icon('eye')}Макет</h2><span class="tag">${esc(state.volume)} л</span></div><div class="preview-toolbar"><button id="toggle-full" class="tool" ${state.busy?'disabled':''}>${icon('file')}Показать весь лист</button><button id="focus-section" class="tool" ${state.busy||!state.matches[state.selected]?.boxes?.length?'disabled':''}>${icon('search')}К разделу</button><select id="zoom" aria-label="Масштаб просмотра">${[50,100,150,200,300,400,500].map(z=>`<option value="${z}" ${state.zoom===z?'selected':''}>${z}%</option>`).join('')}</select></div><div class="canvas-wrap" id="canvas-wrap">${state.image?'<canvas id="preview" aria-label="Макет с автоматически найденными текстовыми блоками"></canvas>':'<div class="empty-state">'+icon('upload')+'<strong>Загрузите макет</strong><p>PDF, PNG или JPEG</p><button class="button secondary" id="empty-upload">Выбрать файл</button></div>'}</div><div class="preview-help">${icon('scan')}<span>${esc(state.analysisNote||'Области и текстовые блоки определяются автоматически.')} ${state.matches[state.selected]?'Найденный текст выбранного требования подсвечен.':''}</span></div>${state.pages>1?`<div class="page-controls"><button class="button secondary small" id="prev-page" ${state.page===1||state.busy?'disabled':''}>Предыдущая</button><span>Страница ${state.page} из ${state.pages}</span><button class="button secondary small" id="next-page" ${state.page===state.pages||state.busy?'disabled':''}>Следующая</button></div>`:''}
 <details class="calibration"><summary>Физический масштаб ${scaleBadge()}</summary><p>${esc(scaleText())}</p>${state.pageMm&&state.hasContour?`<p>Разрешение поиска контура: ≈ ${Number.isFinite(state.contourStep)?format(state.contourStep):'—'} мм/пиксель. Доля площади надписи считается от прямоугольника этого контура.</p>`:''}</details>
 </section><section class="panel checklist-panel"><div class="panel-heading"><h2>Результаты сверки</h2><span class="muted">${result.length} разделов</span></div><div class="filter-tabs" role="group" aria-label="Фильтр разделов">${[['all','Все',result.length],['issues','Внимание',counts.issues],['pending','Не проверены',counts.pending],['passed','Найдены',counts.passed]].map(([v,t,n])=>`<button class="filter ${state.filter===v?'active':''}" data-filter="${v}">${t}<span>${n}</span></button>`).join('')}</div><div class="rule-list">${result.filter(r=>state.filter==='all'||state.filter==='issues'&&['error','issue'].includes(r.status)||state.filter==='pending'&&r.status==='pending'||state.filter==='passed'&&['pass','detected','words'].includes(r.status)).map((r,i)=>`<button class="rule-row ${selected?.id===r.id?'chosen':''}" data-rule="${r.id}"><span class="rule-number">${String(state.rules.findIndex(x=>x.id===r.id)+1).padStart(2,'0')}</span><span class="rule-content"><strong>${esc(r.title)}</strong><small>${r.extra?'Дополнительный текст под ***':esc(r.dimensions.length?r.dimensions.map(d=>`${d.label} ≥ ${format(d.min)} ${d.unit}`).join(' · '):r.constraint||'Наличие и содержание')}</small></span><span class="status ${statuses[r.status][1]}">${r.statusLabel||statuses[r.status][0]}</span>${icon('chevron')}</button>`).join('')||'<div class="filter-empty">В этой группе нет разделов.</div>'}</div></section>
 ${selected?detailView(selected):''}</div>
 <details class="recognized-text" ${state.actual?'':'open'}><summary>${icon('file')}Извлечённый текст <span class="muted">${state.actual?state.origin:'Пока не распознан'}</span></summary><p>Исправьте ошибки распознавания по оригиналу. Правки сохраняются в текущей проверке и попадут в отчёт.</p><textarea id="actual" placeholder="Здесь появится текст макета. Можно вставить или исправить его вручную." ${state.busy?'disabled':''}>${esc(state.actual)}</textarea><div><button class="button secondary small" id="apply-text" ${state.busy?'disabled':''}>Применить текст</button>${state.edited?'<span class="tag">Текст исправлен вручную</span>':''}</div></details>`;}
function detailView(rule){const textConfirmed=rule.state.textConfirmed,index=state.rules.findIndex(r=>r.id===rule.id);return `<section class="panel detail-panel" id="detail"><div class="panel-heading"><div><span class="field-caption">ВЫБРАННЫЙ РАЗДЕЛ</span><h2>${esc(rule.title)}</h2></div><div class="section-controls"><button class="button secondary small" id="prev-section" ${index<=0?'disabled':''}>← Предыдущий</button><span>${index+1} / ${state.rules.length}</span><button class="button secondary small" id="next-section" ${index>=state.rules.length-1?'disabled':''}>Следующий →</button></div><span class="status ${statuses[rule.status][1]}">${rule.statusLabel||statuses[rule.status][0]}</span></div><div class="detail-grid"><div><label class="field-caption">ОЖИДАЕМЫЙ ТЕКСТ${rule.extra?' / ПОД ***':''}</label><div class="expected-text">${esc(rule.expected||'В Word текст не указан. Уточните применимость и текст для этого рынка.').replace(/\n/g,'<br>')}</div>${rule.comparison.missing?.length?`<div class="missing-words"><span>OCR не прочитал:</span>${rule.comparison.missing.slice(0,18).map(w=>`<code>${esc(w)}</code>`).join('')}${rule.comparison.missing.length>18?`<span>и ещё ${rule.comparison.missing.length-18}</span>`:''}</div>`:''}<div class="comparison-line">${icon(rule.comparison.status==='found'?'check':'info')}<strong>${rule.comparison.status==='partial'&&rule.comparison.confident?'Прочитанный текст отличается от Word':comparisonNames[rule.comparison.status]}</strong>${['all_words','partial','unreadable'].includes(rule.comparison.status)?`<span>${rule.comparison.changes?.length?'сходство фразы':'распознано слов'} ${rule.comparison.coverage}%</span>`:''}</div>${phraseView(rule)}${punctuationView(rule)}${quantityView(rule)}<label class="checkbox-row"><input id="confirm-text" type="checkbox" ${textConfirmed?'checked':''} ${state.busy?'disabled':''}>${rule.comparison.status==='manual'?'Содержание / знаки проверены по макету':'Текст проверен по макету'}</label>${!rule.expected?`<p class="muted">Укажите ожидаемый текст в редакторе требований либо объясните неприменимость раздела в комментарии.</p><label class="checkbox-row"><input id="not-applicable" type="checkbox" ${rule.state.notApplicable?'checked':''}>Раздел не применяется для выбранного рынка</label>`:''}</div><div><label class="field-caption">РАЗМЕРЫ И УСЛОВИЯ</label><p class="constraint-text">${esc(rule.constraint||'Минимальный размер в Word не указан.')}</p>${annotationView(rule)}${rule.dimensions.some(d=>d.borderline)?'<p class="measurement-warning">Проверить размер: оценка по пикселям слишком близка к минимуму. Измерьте надпись на печатном образце и внесите значение вручную.</p>':''}${rule.dimensions.map((d,i)=>`<div class="dimension-row"><label for="dim-${i}">${esc(d.label)}${d.estimated?(d.meta?.method==='declared'?' · заявлено выноской':' ≈ по растру'):''}<small>Минимум ${format(d.min)} ${d.unit}</small></label><div class="dimension-input"><input id="dim-${i}" data-dimension="${i}" type="number" min="0" step="0.01" placeholder="—" value="${d.value==null?'':Math.round(d.value*100)/100}" ${state.busy?'disabled':''}><span>${d.unit}</span></div><span class="dimension-verdict ${d.borderline?'neutral':Number.isFinite(d.value)?d.pass?'success':'danger':'neutral'}">${d.borderline?'?':Number.isFinite(d.value)?d.pass?'✓':'<':'—'}</span></div>${measurementDetail(rule,d)}`).join('')}${/окно.*дат/i.test(rule.title)?`<label class="checkbox-row"><input id="window-confirmed" type="checkbox" ${rule.state.windowConfirmed?'checked':''}>Размер окна из Word и цифры проверены по образцу печати</label>`:''}${rule.constraint?`<label class="checkbox-row"><input id="constraints-confirmed" type="checkbox" ${rule.state.constraintsConfirmed?'checked':''} ${state.busy?'disabled':''}>Все условия документа проверены по оригиналу</label>`:''}${rule.dimensions.length?'<p class="muted">«≈ по растру» — оценка по видимым символам этикетки; источник и точность масштаба указаны в блоке «Физический масштаб». «Заявлено выноской» — число с технического листа, не измерение. Пустое поле означает, что размер не определён; при необходимости внесите проверенное значение.</p>':''}<label class="comment-label">Комментарий специалиста<textarea id="review-note" rows="2" placeholder="Что исправить или на каком основании подтверждено" ${state.busy?'disabled':''}>${esc(rule.state.note||'')}</textarea></label><label class="checkbox-row rejection"><input type="checkbox" id="reject" ${rule.state.rejected?'checked':''} ${state.busy?'disabled':''}>Обнаружено несоответствие</label></div></div></section>`;}
function requirementsView(){return `<div class="notice">${icon('info')}<span>Загрузите DOCX с таблицей или разделами обычным текстом, либо TXT в UTF-8. Для текстового документа используйте заголовки «Раздел:», «Текст:», «Требования:». Неоднозначные условия сохраняются для разбора. Требования из образца «Сябры. Чистая» не переносятся автоматически на виски или вино.</span></div><div class="requirements-toolbar"><div><span class="field-caption">ТЕКУЩИЙ ИСТОЧНИК</span><strong>${esc(state.sourceName||'Не загружен')}</strong></div><button class="button primary" id="upload-docx">${icon('upload')}Загрузить требования</button><button class="button secondary" id="restore-sample">Загрузить образец</button></div><div class="panel table-wrap"><table><thead><tr><th>Раздел</th><th>Размеры и условия</th><th>Текст этикетки</th></tr></thead><tbody>${state.rules.map(r=>`<tr><td><strong>${esc(r.title)}</strong>${r.extra?'<span class="tag extra-tag">Под ***</span>':''}</td><td><textarea aria-label="Условия требования ${esc(r.title)}" data-rule-constraint="${r.id}" rows="3">${esc(r.constraint)}</textarea></td><td><textarea aria-label="Текст требования ${esc(r.title)}" data-rule-text="${r.id}" rows="${Math.min(5,Math.max(2,Math.ceil(r.text.length/70)))}">${esc(r.text)}</textarea></td></tr>`).join('')}</tbody></table></div>${state.globalConditions?.length?`<details class="recognized-text"><summary>Общие условия документа · ${state.globalConditions.length}</summary>${state.globalConditions.map(c=>`<p>${esc(c)}</p>`).join('')}</details>`:''}<p class="muted">Изменения текста применяются к текущей проверке. Оригинальный Word не изменяется. Минимальные размеры взяты из документа, их юридическая актуальность сайтом не устанавливается.</p>`;}
function methodView(){return `<section class="panel sources"><h2>Загрузите документы — получите сверку</h2><p>Word задаёт ожидаемый текст, размеры и дополнительные требования после ***. После загрузки сайт читает все части макета на листе, включая отдельно расположенные надписи и штрихкод. Контур задаёт границу сверки: увеличенные образцы за его пределами не подтверждают текст на этикетке.</p><p>Выберите раздел в результатах: найденные слова подсветятся на макете. Сайт восстанавливает строки и порядок слов по координатам. Неоднозначные фразы перечитываются отдельно, а оставшиеся отличия показываются рядом с текстом Word. Несколько законченных фрагментов требования могут совпасть в разных частях макета. При известном физическом масштабе высота букв оценивается по видимым символам. У PDF масштаб задан геометрией страницы. У JPG и PNG он принимается, только если разрешение из файла подтверждается размером этикетки, заявленным на самом листе, и найденным контуром. На технических листах цветные выноски с миллиметрами читаются отдельно: программа находит надпись, на которую выноска указывает линиями размера или расположением, и сравнивает число с минимумом Word как заявление типографии.</p><p>Если контур не найден, проверяется страница целиком; технические подписи также могут попасть в распознавание. Если PDF содержит несколько макетов, сайт выбирает контур с наибольшим совпадением текста с Word. Другие страницы проверяются при переключении.</p><p>Выноска даёт числовое значение, но сама не подтверждает фактическую высоту букв; заявленный размер и оценка по растру показываются раздельно, с источником и уверенностью. Если связь выноски с надписью неоднозначна или число прочитано неуверенно, оно остаётся без привязки. Знаки, фактическая дата печати, читаемость на фоне и спорные размеры остаются на проверке специалиста. Автоматическое совпадение не является согласованием макета.</p></section>`;}
function bind(){
 document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render();});
 const chooseCategory=value=>{if(state.busy||state.category===value)return;state.category=value;state.product='';state.rules=[];state.review={};state.matches={};state.words=[];state.calloutReadings=[];state.annotations=[];state.actual='';state.sourceName='';state.sourceDiagnostics=[];state.globalConditions=[];state.selected='';state.tab='requirements';render();toast('Загрузите требования Word для выбранной продукции.');};
 document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>chooseCategory(b.dataset.category));
 document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;render();});
 const selectRule=id=>{if(!id)return;state.selected=id;state.previewFocus=true;render();const list=document.querySelector('.rule-list'),chosen=list?.querySelector('.rule-row.chosen');if(list&&chosen){const top=chosen.getBoundingClientRect().top-list.getBoundingClientRect().top;if(top<0)list.scrollTop+=top;else if(top+chosen.offsetHeight>list.clientHeight)list.scrollTop+=top+chosen.offsetHeight-list.clientHeight;}};
 document.querySelectorAll('[data-rule]').forEach(b=>b.onclick=()=>selectRule(b.dataset.rule));
 onSectionNav();
 function onSectionNav(){document.querySelector('#prev-section')?.addEventListener('click',()=>selectRule(state.rules[state.rules.findIndex(r=>r.id===state.selected)-1]?.id));document.querySelector('#next-section')?.addEventListener('click',()=>selectRule(state.rules[state.rules.findIndex(r=>r.id===state.selected)+1]?.id));}
 const on=(id,event,fn)=>{const el=document.getElementById(id);if(el)el[event]=fn;};
 const chooseDoc=()=>document.querySelector('#docx-input').click();
 on('upload-docx','onclick',chooseDoc);on('upload-art','onclick',()=>document.querySelector('#art-input').click());on('empty-upload','onclick',()=>document.querySelector('#art-input').click());
 on('docx-input','onchange',async e=>{const file=e.target.files[0];if(!file)return;try{await importDocx(new Uint8Array(await file.arrayBuffer()),file.name);Object.assign(state,{category:'Другая продукция',product:'',tab:'check',image:null,pdf:null,fileName:'',page:1,pages:1,label:null,width:0,height:0,words:[],secondaryWords:[],matches:{},calloutReadings:[],annotations:[],actual:'',origin:'',review:{},hasContour:false,geometryConfirmed:false,analysisNote:''});render();}catch(error){fail(error.message);}});
 on('art-input','onchange',e=>{const file=e.target.files[0];if(file)loadArtwork(file);});
 on('restore-sample','onclick',()=>loadSample(true));
 on('recognize','onclick',recognize);
 on('category-picker','onchange',e=>chooseCategory(e.target.value));
 on('product','onchange',e=>{state.product=e.target.value;});
 on('volume','onchange',e=>{state.volume=e.target.value;state.review={};rematch();render();});
 on('margin','onchange',e=>{state.margin=e.target.checked;rematch();render();});
 on('toggle-full','onclick',()=>{state.zoom=100;drawPreview(true,false);document.querySelector('#zoom').value='100';});
 on('focus-section','onclick',()=>drawPreview(true,true));
 on('zoom','onchange',e=>{state.zoom=Number(e.target.value);drawPreview(false);});
 const wrap=document.querySelector('#canvas-wrap');if(wrap&&state.image){let start=null;wrap.onpointerdown=e=>{if(e.button!==0)return;start={x:e.clientX,y:e.clientY,left:wrap.scrollLeft,top:wrap.scrollTop};wrap.setPointerCapture(e.pointerId);wrap.classList.add('panning');};wrap.onpointermove=e=>{if(!start)return;wrap.scrollLeft=start.left+start.x-e.clientX;wrap.scrollTop=start.top+start.y-e.clientY;};wrap.onpointerup=wrap.onpointercancel=()=>{start=null;wrap.classList.remove('panning');};}
 on('prev-page','onclick',()=>changePage(state.page-1));on('next-page','onclick',()=>changePage(state.page+1));
 on('apply-text','onclick',()=>{state.actual=document.querySelector('#actual').value;state.matches={};state.words=[];state.secondaryWords=[];state.edited=true;state.origin='Текст исправлен вручную';state.review={};render();toast('Текст обновлён. Подтверждения сброшены для повторной сверки.');});
 on('confirm-text','onchange',e=>{const rule=state.rules.find(r=>r.id===state.selected);if(e.target.checked&&!rule?.text.trim()&&!getReview().note?.trim()){e.target.checked=false;toast('Укажите текст импортёра или причину неприменимости в комментарии.');return;}getReview().textConfirmed=e.target.checked;render();});
 on('not-applicable','onchange',e=>{if(e.target.checked&&!getReview().note?.trim()){e.target.checked=false;toast('Запишите причину неприменимости в комментарии.');return;}getReview().notApplicable=e.target.checked;render();});
 on('constraints-confirmed','onchange',e=>{getReview().constraintsConfirmed=e.target.checked;render();});
 on('window-confirmed','onchange',e=>{getReview().windowConfirmed=e.target.checked;render();});
 on('reject','onchange',e=>{getReview().rejected=e.target.checked;render();});
 on('review-note','onchange',e=>{getReview().note=e.target.value;});
 document.querySelectorAll('[data-dimension]').forEach(el=>el.onchange=()=>{const i=Number(el.dataset.dimension);const v=el.value===''?undefined:Number(el.value);if(v<0||!Number.isFinite(v)&&v!==undefined){toast('Введите неотрицательное измерение.');return;}getReview().dimensions??=[];getReview().dimensions[i]=v;render();});
 document.querySelectorAll('[data-rule-constraint]').forEach(el=>el.onchange=()=>{const rule=state.rules.find(r=>r.id===el.dataset.ruleConstraint);rule.constraint=el.value;delete state.review[rule.id];rematch();toast('Условия обновлены для текущей проверки.');});
 document.querySelectorAll('[data-rule-text]').forEach(el=>el.onchange=()=>{const rule=state.rules.find(r=>r.id===el.dataset.ruleText);rule.text=el.value;rule.original=el.value;delete state.review[rule.id];rematch();toast('Требование обновлено для текущей проверки.');});
 on('dismiss-error','onclick',()=>{state.error='';render();});on('export','onclick',exportReport);
}
function getReview(){return state.review[state.selected]??=( {} );}
function rematch(){
 // Both engines' readings and what the second look at edge places found are judged in one place.
 state.matches=assess({rules:state.rules,words:state.words,secondaryWords:state.secondaryWords,volume:state.volume,margin:state.margin?state.marginAmount:false,label:state.label,hasContour:state.hasContour,edgeProbes:state.edgeProbes||[],page:state.image?{width:state.image.width,height:state.image.height}:null});
 // Callouts are linked to rules, compared with the same inscription on the
 // label and entered as declared sizes only where nothing was measured.
 state.annotations=verifyOnLabel(linkClaims(state.calloutReadings,state.rules,state.volume,state.margin?state.marginAmount:false),state.matches,state.image?{width:state.image.width,height:state.image.height}:undefined);
 applyDeclaredDimensions(state.matches,state.annotations);
 // The printer's formula for the share of the warning: a second figure beside the rectangle share.
 for(const match of Object.values(state.matches)){if(!match?.declared)continue;match.areaFormula=match.declared.map((list,index)=>list?statedAreaShare(match,index,state.pageMm):null);}
}
function format(n){return Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2});}
function fail(message){state.error=message;state.busy=false;render();}
function drawPreview(focus=false,section=true){
 const canvas=document.querySelector('#preview'),wrap=document.querySelector('#canvas-wrap');
 if(!canvas||!wrap||!state.image)return;
 const img=state.image,box=state.matches[state.selected]?.boxes?.length?(()=>{const boxes=state.matches[state.selected].boxes;const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};})():null;
 const oldWidth=canvas.getBoundingClientRect().width,oldHeight=canvas.getBoundingClientRect().height;
 const centerX=oldWidth?(wrap.scrollLeft+wrap.clientWidth/2)/oldWidth:.5,centerY=oldHeight?(wrap.scrollTop+wrap.clientHeight/2)/oldHeight:.5;
 canvas.width=img.width;canvas.height=img.height;
 const fit=Math.min(1,(wrap.clientWidth-40)/img.width);
 if(focus&&section&&box){const target=Math.min((wrap.clientWidth*.72)/(box.w*img.width),(wrap.clientHeight*.6)/(box.h*img.height));state.zoom=Math.max(100,Math.min(500,Math.round(target/fit*100/25)*25));}
 const width=Math.max(1,img.width*fit*state.zoom/100);canvas.style.width=width+'px';
 const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
 for(const b of state.matches[state.selected]?.boxes||[]){const x=b.x*img.width,y=b.y*img.height,w=b.w*img.width,h=b.h*img.height;ctx.fillStyle='#2563eb10';ctx.fillRect(x,y,w,h);ctx.strokeStyle='#2563eb';ctx.lineWidth=1.25;ctx.strokeRect(x,y,w,h);}
 const height=width*img.height/img.width;
 if(focus){const x=section&&box?box.x+box.w/2:.5,y=section&&box?box.y+box.h/2:.5;wrap.scrollLeft=Math.max(0,width*x-wrap.clientWidth/2);wrap.scrollTop=Math.max(0,height*y-wrap.clientHeight/2);}
 else if(oldWidth){wrap.scrollLeft=Math.max(0,width*centerX-wrap.clientWidth/2);wrap.scrollTop=Math.max(0,height*centerY-wrap.clientHeight/2);}
 const zoom=document.querySelector('#zoom');if(zoom&&!Array.from(zoom.options).some(option=>Number(option.value)===state.zoom)){zoom.add(new Option(state.zoom+'%',state.zoom));}if(zoom)zoom.value=String(state.zoom);
}
async function importDocx(bytes,name){
 if(bytes.length>25*1024*1024)throw new Error('Word превышает 25 МБ. Уменьшите размер файла.');
 let source;
 if(/\.txt$/i.test(name))source={paragraphs:new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'').split(/\r?\n/),tables:[]};
 else {
 const archive=unzipSync(bytes,{filter:file=>file.name==='word/document.xml'});if(!archive['word/document.xml'])throw new Error('В файле не найден документ Word. Используйте формат .docx.');
 const xml=new DOMParser().parseFromString(strFromU8(archive['word/document.xml']),'application/xml');if(xml.querySelector('parsererror'))throw new Error('Не удалось прочитать структуру Word.');
 const ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
 // A raised 0 or 3 in Word stands for a degree sign or a cube.
 const raised=t=>t.parentNode?.getElementsByTagNameNS?.(ns,'vertAlign')[0]?.getAttributeNS(ns,'val')==='superscript';
  const paragraphs=node=>(node.localName==='p'?[node]:Array.from(node.getElementsByTagNameNS(ns,'p'))).map(p=>Array.from(p.getElementsByTagNameNS(ns,'*')).filter(t=>['t','br','tab'].includes(t.localName)).map(t=>t.localName==='t'?(raised(t)?raisedText(t.textContent):t.textContent):t.localName==='tab'?'\t':'\n').join(''));
 const tables=Array.from(xml.getElementsByTagNameNS(ns,'tbl')).map(t=>Array.from(t.children).filter(x=>x.localName==='tr').map(r=>Array.from(r.children).filter(x=>x.localName==='tc').map(c=>paragraphs(c).join('\n'))));
 const body=xml.getElementsByTagNameNS(ns,'body')[0];source={tables,blocks:Array.from(body.children).filter(x=>x.localName==='p').map(p=>({type:'paragraph',text:paragraphs(p)[0],heading:!!p.getElementsByTagNameNS(ns,'outlineLvl').length||/^heading|^заголовок/i.test(p.getElementsByTagNameNS(ns,'pStyle')[0]?.getAttributeNS(ns,'val')||'')}))};
 }
 const rules=requirementsFromSource(source);if(!rules.length)throw new Error('В документе нет требований. Загрузите DOCX или текст UTF-8 с разделами, текстами и условиями.');
 state.sourceDiagnostics=source.diagnostics;state.globalConditions=source.globalConditions;state.marginSuggested=suggestedHeightMargin(source.globalConditions)!=null;state.marginAmount=suggestedHeightMargin(source.globalConditions)??.2;state.margin=false;
 state.rules=rules;const productQuantities=quantities(rules.find(isQuantityRule)?.text||'').filter(q=>q.kind==='volume');if(productQuantities.length&&!productQuantities.some(q=>Math.abs(q.baseValue-Number(state.volume.replace(',','.')))<1e-9))state.volume=String(productQuantities[0].baseValue).replace('.',',');state.sourceName=name;state.review={};state.selected=rules[0].id;state.error='';
}
async function imageFromUrl(url){const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Не удалось открыть изображение.'));img.src=url;});return img;}
async function loadSample(analyze=true){try{state.busy=true;state.busyMessage='Открываем образец';render();const [doc,pdf]=await Promise.all([fetch('./assets/sample.docx').then(r=>r.arrayBuffer()),fetch('./assets/sample.pdf').then(r=>r.blob())]);await importDocx(new Uint8Array(doc),'информ.редизайн Сябры Чистая 0,2 0,5 0,7.docx');Object.assign(state,{category:'Водка',product:'Сябры. Чистая',volume:'0,7',tab:'check'});await loadArtwork(new File([pdf],'sjabry_chistaja_0,7L_54x103.pdf',{type:'application/pdf'}),{analyze});}catch(error){fail(error.message);}}
async function loadArtwork(file,{analyze=true}={}){try{
 if(file.size>30*1024*1024)throw new Error('Макет превышает 30 МБ. Загрузите файл меньшего размера.');
 state.busy=true;state.busyMessage='Открываем макет';state.progress=0;render();let pdf=null,img,density=null;
 if(file.name.toLowerCase().endsWith('.pdf')){pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),cMapUrl:new URL('./vendor/cmaps/',location.href).href,cMapPacked:true}).promise;img=await renderPdfPage(pdf,1);}
 else if(file.type.startsWith('image/')){density=imageDensity(new Uint8Array(await file.arrayBuffer()));const url=URL.createObjectURL(file);try{img=await imageFromUrl(url);}finally{URL.revokeObjectURL(url);}}
 else throw new Error('Поддерживаются PDF, PNG, JPEG и WebP.');
 Object.assign(state,{image:img,pdf,fileName:file.name,page:1,pages:pdf?.numPages||1,label:null,width:0,height:0,geometryConfirmed:false,full:false,actual:'',origin:'',review:{},words:[],secondaryWords:[],matches:{},calloutReadings:[],annotations:[],hasContour:false,pageMm:null,scale:null,density,analysisNote:'',busy:false,error:''});
 render();if(state.rules.length&&analyze)await recognize();
 }catch(error){fail('Макет не открыт: '+error.message);}}
async function renderPdfPage(pdf,pageNo){const page=await pdf.getPage(pageNo);const natural=page.getViewport({scale:1});const scale=Math.min(6,6500/Math.max(natural.width,natural.height));const vp=page.getViewport({scale});const canvas=document.createElement('canvas');canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;return imageFromUrl(canvas.toDataURL('image/png'));}
// A PDF page that is one picture has no outlines to draw again: its real
// resolution is that of the picture, whatever size it is rendered at.
async function pdfPicture(page){
 const list=await page.getOperatorList(),OPS=pdfjs.OPS,painted=new Set([OPS.fill,OPS.eoFill,OPS.stroke,OPS.fillStroke,OPS.eoFillStroke,OPS.closeStroke,OPS.closeFillStroke,OPS.closeEOFillStroke,OPS.showText,OPS.showSpacedText,OPS.nextLineShowText,OPS.nextLineSetSpacingShowText,OPS.shadingFill]),stack=[],pictures=[];
 let matrix=[1,0,0,1,0,0],drawn=0;
 list.fnArray.forEach((fn,i)=>{
  const args=list.argsArray[i];
  if(fn===OPS.save)stack.push(matrix);else if(fn===OPS.restore)matrix=stack.pop()||matrix;else if(fn===OPS.transform)matrix=pdfjs.Util.transform(matrix,args);
  else if(fn===OPS.paintImageXObject||fn===OPS.paintInlineImageXObject){const width=args[1]??args[0]?.width,height=args[2]??args[0]?.height,w=Math.hypot(matrix[0],matrix[1]),h=Math.hypot(matrix[2],matrix[3]);if(width&&height&&w&&h)pictures.push({dpi:Math.min(width/w,height/h)*72,area:w*h});}
  else if(painted.has(fn))drawn++;
 });
 const view=page.getViewport({scale:1}),largest=pictures.sort((a,b)=>b.area-a.area)[0];
 return !drawn&&largest&&largest.area>=view.width*view.height*.8?{dpi:largest.dpi}:null;
}
async function renderPdfCrop(pdf,pageNo,region,wanted=Infinity){const page=await pdf.getPage(pageNo),natural=page.getViewport({scale:1}),scale=Math.min(10,9500/Math.max(natural.width,natural.height),wanted),vp=page.getViewport({scale}),canvas=document.createElement('canvas');canvas.width=Math.ceil(vp.width*region.w);canvas.height=Math.ceil(vp.height*region.h);await page.render({canvasContext:canvas.getContext('2d'),viewport:vp,transform:[1,0,0,1,-vp.width*region.x,-vp.height*region.y]}).promise;return canvas;}
async function changePage(n){try{state.busy=true;state.busyMessage='Открываем страницу';render();state.image=await renderPdfPage(state.pdf,n);Object.assign(state,{page:n,label:null,full:false,geometryConfirmed:false,actual:'',origin:'',review:{},words:[],secondaryWords:[],matches:{},calloutReadings:[],annotations:[],pageMm:null,hasContour:false,busy:false});await recognize();}catch(error){fail(error.message);}}
async function recognize(){
 if(!state.image||state.busy)return;
 if(!state.rules.length){toast('Сначала загрузите требования Word.');return;}
 const generation=++ocrGeneration;
 try{
  Object.assign(state,{busy:true,error:'',progress:0,busyMessage:'Ищем контуры этикетки',review:{},matches:{},words:[],secondaryWords:[],calloutReadings:[],annotations:[],edgeProbes:[],actual:'',pageMm:null,scale:null,pdfRaster:null,geometryConfirmed:false});render();
  const img=state.image,probe=document.createElement('canvas'),ratio=Math.min(1,1200/Math.max(img.width,img.height));probe.width=Math.round(img.width*ratio);probe.height=Math.round(img.height*ratio);probe.getContext('2d').drawImage(img,0,0,probe.width,probe.height);
  const probePixels=probe.getContext('2d').getImageData(0,0,probe.width,probe.height),artwork=detectArtworkRegion(probePixels);
  // One working copy of the whole sheet serves contour refinement and callouts.
  const sheetScale=Math.min(1,3600/Math.max(img.width,img.height)),sheetCanvas=document.createElement('canvas');sheetCanvas.width=Math.round(img.width*sheetScale);sheetCanvas.height=Math.round(img.height*sheetScale);
  const sheetContext=sheetCanvas.getContext('2d',{willReadFrequently:true});sheetContext.drawImage(img,0,0,sheetCanvas.width,sheetCanvas.height);
  const sheet=sheetContext.getImageData(0,0,sheetCanvas.width,sheetCanvas.height),frames=detectFrames(probePixels).map(frame=>refineFrame(sheet,frame));
  let candidates=frames.length?frames:[{x:0,y:0,w:1,h:1}];state.hasContour=frames.length>0;
  // Lengths are millimetres for a PDF and source pixels for an image, whose
  // scale is settled only after the label contour is known.
  let pageUnits={width:img.width,height:img.height};
  if(state.pdf){const page=await state.pdf.getPage(state.page),vp=page.getViewport({scale:1});pageUnits=state.pageMm={width:vp.width*25.4/72,height:vp.height*25.4/72};state.geometryConfirmed=true;state.contourStep=Math.max(state.pageMm.width/sheet.width,state.pageMm.height/sheet.height);
   const picture=await pdfPicture(page);state.pdfRaster=picture&&{dpi:picture.dpi,coarser:img.width/vp.width*72/picture.dpi};}
  const language=state.rules.some(r=>/(?:[a-z]{5}|[a-z]{3,}\s+[a-z]{3,})/i.test(r.text))?'rus+eng':'rus';
  if(worker&&workerLanguage!==language){await worker.terminate();worker=null;}
  if(!worker){worker=await createWorker(language,1,{workerPath:new URL('./vendor/worker.min.js',location.href).href,corePath:new URL('./vendor/core/',location.href).href,langPath:new URL('./assets/lang/',location.href).href,logger:m=>{const p=document.querySelector('progress');if(p)p.value=m.progress;const text=document.querySelector('.progress-panel span');if(text)text.textContent=state.busyMessage;const percent=document.querySelector('.progress-panel strong');if(percent)percent.textContent=Math.round((m.progress||0)*100)+'%';}});workerLanguage=language;}
  // The order table names the label size: a witness for the contour and the scale.
  state.busyMessage='Читаем параметры заказа на листе';
  await worker.setParameters({tessedit_pageseg_mode:'11',preserve_interword_spaces:'1'});
  const overview=document.createElement('canvas'),overviewScale=Math.min(1,2600/Math.max(sheetCanvas.width,sheetCanvas.height));overview.width=Math.round(sheetCanvas.width*overviewScale);overview.height=Math.round(sheetCanvas.height*overviewScale);overview.getContext('2d').drawImage(sheetCanvas,0,0,overview.width,overview.height);
  const overviewData=(await worker.recognize(overview,{}, {text:true,blocks:true})).data;
  const sheetLines=(overviewData.blocks||[]).flatMap(b=>b.paragraphs||[]).flatMap(p=>p.lines||[]).filter(line=>line.bbox).map(line=>({text:(line.words||[]).map(word=>word.text).join(' '),box:{x:line.bbox.x0/overview.width,y:line.bbox.y0/overview.height,w:(line.bbox.x1-line.bbox.x0)/overview.width,h:(line.bbox.y1-line.bbox.y0)/overview.height}}));
  const declared=declaredLabelSize(sheetLines)||declaredLabelSize(overviewData.text||'');
  const scaleFor=frame=>resolveScale({density:state.density,contour:state.hasContour?{w:frame.w*img.width,h:frame.h*img.height}:null,declared});
  const fitsDeclared=frame=>{
   if(!declared)return false;if(!state.pdf)return scaleFor(frame).level!=='none';
   const sides=[frame.w*state.pageMm.width,frame.h*state.pageMm.height],long=Math.max(...declared),short=Math.min(...declared);
   return Math.abs(Math.max(...sides)-long)<=long*.03&&Math.abs(Math.min(...sides)-short)<=short*.03;
  };
  // A contour of exactly the stated size is the label wherever it stands on the sheet.
  const fitting=frames.filter(fitsDeclared);if(fitting.length)candidates=fitting;
  await worker.setParameters({tessedit_pageseg_mode:'3',preserve_interword_spaces:'1'});
  const makeCanvas=region=>{const c=document.createElement('canvas'),w=region.w*img.width,h=region.h*img.height,f=Math.min(4,2800/Math.max(w,h));c.width=Math.max(1,Math.round(w*f));c.height=Math.max(1,Math.round(h*f));c.getContext('2d').drawImage(img,region.x*img.width,region.y*img.height,w,h,0,0,c.width,c.height);return c;};
  let readPass=0;
  const read=async(region,canvas,rotation,stretch=1.5)=>{
   let input=canvas;
   if(rotation){input=document.createElement('canvas');input.width=rotation%180?canvas.height:canvas.width;input.height=rotation%180?canvas.width:canvas.height;const ctx=input.getContext('2d');ctx.translate(input.width/2,input.height/2);ctx.rotate(rotation*Math.PI/180);ctx.drawImage(canvas,-canvas.width/2,-canvas.height/2);}
   const stretched=document.createElement('canvas');stretched.width=Math.round(input.width*stretch);stretched.height=input.height;stretched.getContext('2d').drawImage(input,0,0,stretched.width,stretched.height); const {data}=await worker.recognize(stretched,{}, {text:true,blocks:true}); for(const b of data.blocks||[])for(const p of b.paragraphs||[])for(const l of p.lines||[])for(const w of l.words||[]){w.bbox.x0/=stretch;w.bbox.x1/=stretch;for(const symbol of w.symbols||[]){symbol.bbox.x0/=stretch;symbol.bbox.x1/=stretch;}}
   const mm=rotation%180?pageUnits.width*region.w/canvas.width:pageUnits.height*region.h/canvas.height;
   const words=wordsFromOcr(data,region,canvas.width,canvas.height,rotation,mm,`ocr-${++readPass}`,input.getContext('2d').getImageData(0,0,input.width,input.height));
   // A picture inside a PDF keeps its own, coarser pixels however large the page is drawn.
   for(const word of words)word.sourcePixelMm=(rotation%180?pageUnits.width/img.width:pageUnits.height/img.height)*Math.max(1,state.pdfRaster?.coarser||1);
   return {text:data.text,words};
  };
  let best=null;
  for(let i=0;i<candidates.length;i++){
   const region=candidates[i],canvas=makeCanvas(region);state.busyMessage=`Распознаём макет ${i+1} из ${candidates.length}`;
   const result=await read(region,canvas,0);const matches=matchRequirements(state.rules,result.words,state.volume,state.margin?state.marginAmount:false,region,state.hasContour);
   const score=Object.values(matches).reduce((n,m)=>n+(m?m.coverage:0),0);
   if(!best||score>best.score)best={region,canvas,result,score};
  }
  if(best.score===0&&frames.length){
   for(const region of candidates){const canvas=makeCanvas(region);for(const rotation of [90,180,270]){
    state.busyMessage=`Определяем ориентацию этикетки: ${rotation}°`;const result=await read(region,canvas,rotation),score=Object.values(matchRequirements(state.rules,result.words,state.volume,state.margin?state.marginAmount:false,region,true)).reduce((n,m)=>n+(m?.coverage||0),0);
    if(score>best.score)best={region,canvas,result,score};if(score>0)break;
   }}
   if(best.score===0){const region={x:0,y:0,w:1,h:1},canvas=makeCanvas(region);best={region,canvas,result:await read(region,canvas,0),score:0};state.hasContour=false;}
  }
  const {region,canvas,result}=best;
  const artworkCanvas=makeCanvas(artwork);
  const wantedBarcode=variantText(state.rules.find(rule=>/штриховой код/i.test(rule.title))||{title:'',text:''},state.volume);
  // Read barcode bars at source resolution within the physical label when its
  // boundary is known; a barcode on an enlarged proof cannot confirm this one.
  const barcodeRegion=state.hasContour?region:artwork,barcodeCanvas=document.createElement('canvas');barcodeCanvas.width=Math.round(barcodeRegion.w*img.width);barcodeCanvas.height=Math.round(barcodeRegion.h*img.height);
  barcodeCanvas.getContext('2d').drawImage(img,barcodeRegion.x*img.width,barcodeRegion.y*img.height,barcodeRegion.w*img.width,barcodeRegion.h*img.height,0,0,barcodeCanvas.width,barcodeCanvas.height);
  const barcode=scanEan13(barcodeCanvas.getContext('2d').getImageData(0,0,barcodeCanvas.width,barcodeCanvas.height),wantedBarcode);
  if(barcode){const box={x:barcodeRegion.x+barcode.box.x*barcodeRegion.w,y:barcodeRegion.y+barcode.box.y*barcodeRegion.h,w:barcode.box.w*barcodeRegion.w,h:barcode.box.h*barcodeRegion.h};result.words.push({text:barcode.text,confidence:100,box,glyphs:[],pass:'barcode'});result.text+='\n'+barcode.text;}
  for(const rotation of [90,180,270]){state.busyMessage=`Проверяем повёрнутый текст: ${rotation}°`;const extra=await read(region,canvas,rotation);if(extra.text.trim()){result.text+='\n'+extra.text;result.words.push(...extra.words);}}
  await worker.setParameters({tessedit_pageseg_mode:'11'});
  const sparse=await read(region,canvas,0);if(sparse.text.trim()){result.text+='\n'+sparse.text;result.words.push(...sparse.words);}
  if(!state.hasContour){
   state.busyMessage='Ищем текст по всему макету';
   const distributed=await read(artwork,artworkCanvas,0);if(distributed.text.trim()){result.text+='\n'+distributed.text;result.words.push(...distributed.words);}
   if(state.rules.some(rule=>rule.text?.length>15&&compareText(rule.text,result.text).coverage<65)){
    for(const rotation of [90,270]){state.busyMessage=`Ищем повёрнутые блоки на листе: ${rotation}°`;const extra=await read(artwork,artworkCanvas,rotation);if(extra.text.trim()){result.text+='\n'+extra.text;result.words.push(...extra.words);}}
   }
  }
  const layout=document.createElement('canvas'),layoutScale=Math.min(1,1400/Math.max(canvas.width,canvas.height));layout.width=Math.round(canvas.width*layoutScale);layout.height=Math.round(canvas.height*layoutScale);layout.getContext('2d').drawImage(canvas,0,0,layout.width,layout.height);
  const blocks=segmentInk(layout.getContext('2d').getImageData(0,0,layout.width,layout.height),region);
  await worker.setParameters({tessedit_pageseg_mode:'6'});
  for(let i=0;i<blocks.length;i++){const block=blocks[i],crop=makeCanvas(block);state.busyMessage=`Уточняем текстовые блоки: ${i+1} из ${blocks.length}`;for(const rotation of crop.height>crop.width*2.5?[90,270,0]:[0]){const extra=await read(block,crop,rotation);if(extra.text.trim()){result.text+='\n'+extra.text;result.words.push(...extra.words);}}}
  if(!state.hasContour){
   const artworkLayout=document.createElement('canvas'),artworkScale=Math.min(1,1200/Math.max(artworkCanvas.width,artworkCanvas.height));artworkLayout.width=Math.round(artworkCanvas.width*artworkScale);artworkLayout.height=Math.round(artworkCanvas.height*artworkScale);artworkLayout.getContext('2d').drawImage(artworkCanvas,0,0,artworkLayout.width,artworkLayout.height);
   const detached=segmentInk(artworkLayout.getContext('2d').getImageData(0,0,artworkLayout.width,artworkLayout.height),artwork).filter(block=>block.w>.08&&block.h>.15).slice(0,6);
   for(let i=0;i<detached.length;i++){state.busyMessage=`Уточняем отдельные части макета: ${i+1} из ${detached.length}`;const extra=await read(detached[i],makeCanvas(detached[i]),0);if(extra.text.trim()){result.text+='\n'+extra.text;result.words.push(...extra.words);}}
  }
  if(state.pdf){
   const page=await state.pdf.getPage(state.page),vp=page.getViewport({scale:1}),content=await page.getTextContent();
   const vector=[];
   for(const item of content.items){if(!item.str?.trim())continue;const tx=pdfjs.Util.transform(vp.transform,item.transform),font=Math.hypot(tx[2],tx[3]),angle=Math.atan2(tx[1],tx[0]),advance=item.width*vp.scale;
    const corners=[[0,0],[advance,0],[0,-font],[advance,-font]].map(([x,y])=>({x:(tx[4]+x*Math.cos(angle)-y*Math.sin(angle))/vp.width,y:(tx[5]+x*Math.sin(angle)+y*Math.cos(angle))/vp.height}));
    const x=Math.min(...corners.map(p=>p.x)),y=Math.min(...corners.map(p=>p.y)),right=Math.max(...corners.map(p=>p.x)),bottom=Math.max(...corners.map(p=>p.y));
    if(x<region.x-.002||y<region.y-.002||right>region.x+region.w+.002||bottom>region.y+region.h+.002)continue;
    vector.push({text:item.str,confidence:100,box:{x,y,w:right-x,h:bottom-y},glyphs:[],pass:'pdf'});
   }
   if(vector.length){result.words.push(...vector);result.text+='\n'+vector.map(w=>w.text).join('\n');}
  }
  const uncertain=matchRequirements(state.rules,result.words,state.volume,state.margin?state.marginAmount:false,region,state.hasContour),areas=refinementAreas(uncertain);
  for(let i=0;i<areas.length;i++){const area=areas[i],crop=makeCanvas(area);
   state.busyMessage=`Повторно читаем неоднозначную фразу: ${i+1} из ${areas.length}`;await worker.setParameters({tessedit_pageseg_mode:area.lineCount===1?'7':'6'});
   const extra=await read(area,crop,area.rotation,2.5);if(extra.text.trim()){result.text+='\n'+extra.text;result.words.push(...extra.words);}
  }
  // Every line of print is read once more by itself. A line is cut out with
  // only its own ink: commas of the line above, accents of the line below and
  // letters of an inscription beside it are left out, as they are what turns
  // into stray signs in a reading. Blocks are found where words were already
  // read; nothing is fixed to a column, a product or an expected inscription.
  const lineShots=[],edgeProbes=[];
  {
   const page={width:img.width,height:img.height},bounds={x0:region.x*img.width,y0:region.y*img.height,x1:(region.x+region.w)*img.width,y1:(region.y+region.h)*img.height};
   const blocks=seedBlocks(result.words.filter(word=>word.pass?.startsWith('ocr-')&&(!state.hasContour||insideLabel(word.box,region))),page);
   // Outlines of a PDF can be drawn again larger; a picture cannot, and a PDF
   // that only wraps a picture is a picture. Enlarging one adds no detail.
   let detail=null,detailScale=1;
   if(state.pdf&&!state.pdfRaster){
    const natural=(await state.pdf.getPage(state.page)).getViewport({scale:1}),pageScale=img.width/natural.width,wanted=Math.min(10/pageScale,6000/Math.max(bounds.x1-bounds.x0,bounds.y1-bounds.y0));
    if(wanted>1.15){state.busyMessage='Перерисовываем этикетку из PDF крупнее';detail=await renderPdfCrop(state.pdf,state.page,region,pageScale*wanted);detailScale=detail.width/(bounds.x1-bounds.x0);}
   }
   const scratch=document.createElement('canvas'),pen=scratch.getContext('2d',{willReadFrequently:true});
   const grab=(box,turn,scale,erase)=>{
    const w=Math.max(1,Math.round((box.x1-box.x0)*scale)),h=Math.max(1,Math.round((box.y1-box.y0)*scale));
    scratch.width=turn%180?h:w;scratch.height=turn%180?w:h;pen.fillStyle='#fff';pen.fillRect(0,0,scratch.width,scratch.height);
    pen.save();pen.translate(scratch.width/2,scratch.height/2);pen.rotate(turn*Math.PI/180);pen.translate(-w/2,-h/2);pen.imageSmoothingEnabled=true;pen.imageSmoothingQuality='high';
    if(detail)pen.drawImage(detail,(box.x0-bounds.x0)*detailScale,(box.y0-bounds.y0)*detailScale,(box.x1-box.x0)*detailScale,(box.y1-box.y0)*detailScale,0,0,w,h);
    else pen.drawImage(img,box.x0,box.y0,box.x1-box.x0,box.y1-box.y0,0,0,w,h);
    for(const row of erase)pen.fillRect((row.x*img.width-box.x0)*scale-1,(row.y*img.height-box.y0)*scale-1,row.w*img.width*scale+2,row.h*img.height*scale+2);
    pen.restore();return pen.getImageData(0,0,scratch.width,scratch.height);
   };
   const picture=image=>{const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').putImageData(new ImageData(image.data,image.width,image.height),0,0);return c;};
   // One isolated line through the text model: `stretch` widens condensed
   // letters, `height` brings the line to the size the model reads best.
   const readLine=async(line,image,pass,id,{stretch=1,height=0,measure=false}={})=>{
    const sy=height?height/image.height:1,sx=sy*stretch,edge=12,input=document.createElement('canvas');input.width=Math.round(image.width*sx)+edge*2;input.height=Math.round(image.height*sy)+edge*2;
    const ctx=input.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,input.width,input.height);ctx.imageSmoothingQuality='high';ctx.drawImage(picture(image),edge,edge,input.width-edge*2,input.height-edge*2);
    const {data}=await worker.recognize(input,{}, {text:true,blocks:true});
    // Boxes back into the pixels of the line image.
    for(const b of data.blocks||[])for(const p of b.paragraphs||[])for(const l of p.lines||[])for(const w of l.words||[])for(const box of [w.bbox,...(w.symbols||[]).map(symbol=>symbol.bbox)]){box.x0=(box.x0-edge)/sx;box.x1=(box.x1-edge)/sx;box.y0=(box.y0-edge)/sy;box.y1=(box.y1-edge)/sy;}
    const turn=line.rotation,width=turn%180?image.height:image.width,height0=turn%180?image.width:image.height,unit=turn%180?pageUnits.width*line.region.w/width:pageUnits.height*line.region.h/height0;
    // Where the line runs out of its window the word at that edge is cut in two and is not kept.
    const near=line.letter*line.scale*1.2,words=wordsFromOcr(data,line.region,width,height0,turn,measure?unit:null,pass,measure?image:null).filter(word=>!(line.cut.left&&word.readingBox.x<near)&&!(line.cut.right&&word.readingBox.x+word.readingBox.w>image.width-near)),pagePixel=turn%180?pageUnits.width/img.width:pageUnits.height/img.height;
    for(const word of words){
     // The step of a measurement is that of the pixels that really exist: a
     // redrawn outline has finer ones, an enlarged picture has not.
     word.sourcePixelMm=detail?pagePixel/Math.min(line.scale,detailScale):pagePixel*Math.max(1,state.pdfRaster?.coarser||1);
     word.line=id;word.readingBox=pageReadingBox(word.box,word.rotation,img.width/img.height);if(!measure)word.glyphs=[];
    }
    if(data.text.trim()){result.text+='\n'+data.text;result.words.push(...words);}
   };
   await worker.setParameters({tessedit_pageseg_mode:'7',thresholding_method:'0'});
   const taken=[];let budget=170;
   for(let i=0;i<blocks.length&&budget>0;i++){
    const lines=blockLines(blocks[i],blocks,page,grab,{bounds,maxScale:detail?detailScale:2.4,taken,limit:budget});budget-=lines.length;
    for(let j=0;j<lines.length;j++){
     state.busyMessage=`Читаем строки по отдельности: блок ${i+1} из ${blocks.length}, строка ${j+1} из ${lines.length}`;
     const line=lines[j],id=`line-${lineShots.length}`;lineShots.push({image:line.gray,region:line.region,rotation:line.rotation,id,cut:line.cut});
     await readLine(line,line.gray,`line-gray:${line.rotation}`,id,{stretch:1.5,measure:true});
     await readLine(line,line.binary,`line-binary:${line.rotation}`,id,{stretch:1.5});
     await readLine(line,line.gray,`line-even:${line.rotation}`,id,{height:48});
    }
   }
   // Words of a requirement missing at the edge of what was read may be
   // absent or merely unread. Exactly the place where they would stand is
   // looked at again, larger: empty paper, other words or the words themselves.
   const edges=Object.values(matchRequirements(state.rules,result.words,state.volume,state.margin?state.marginAmount:false,region,state.hasContour)).flatMap(match=>match&&(match.scope==='label'||!state.hasContour)?edgePlaces(match,page):[]).slice(0,12);
   const same=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y)+Math.abs(a.w-b.w)+Math.abs(a.h-b.h)<1e-6;
   // The same word whatever stray quotes or points a pass attached to it.
   const plainText=text=>text.toLowerCase().replace(/[^\p{L}\p{N}%]/gu,'')||text.trim();
   for(const place of edges)for(const area of place.areas){
    if(edgeProbes.some(probe=>probe.rotation===place.rotation&&same(probe.box,area)))continue;
    state.busyMessage=`Перечитываем крупнее место ненайденных слов: ${edgeProbes.length+1}`;
    // Print already read with confidence in another direction is a different
    // inscription that happens to stand there, not the rest of this phrase.
    const across=result.words.filter(word=>word.box&&(word.rotation||0)!==place.rotation&&(word.confidence??0)>=80&&word.text.trim()&&word.box.x<area.x+area.w&&word.box.x+word.box.w>area.x&&word.box.y<area.y+area.h&&word.box.y+word.box.h>area.y)
     // … and only when two passes read the same word at the same place: one pass alone may have misread turned letters.
     .filter(word=>result.words.some(other=>other!==word&&other.box&&other.pass!==word.pass&&(other.rotation||0)===(word.rotation||0)&&(other.confidence??0)>=50&&plainText(other.text)===plainText(word.text)&&Math.min(other.box.x+other.box.w,word.box.x+word.box.w)-Math.max(other.box.x,word.box.x)>Math.min(other.box.w,word.box.w)*.5&&Math.min(other.box.y+other.box.h,word.box.y+word.box.h)-Math.max(other.box.y,word.box.y)>Math.min(other.box.h,word.box.h)*.5));
    const scale=Math.min(detail?detailScale:3,Math.max(1,34/place.letter)),pixels=printOnly(grab({x0:area.x*img.width,y0:area.y*img.height,x1:(area.x+area.w)*img.width,y1:(area.y+area.h)*img.height},place.rotation,scale,across.map(word=>word.box)),place.letter*scale);
    // No print of this size there: the place is empty, whatever rules, frames or neighbours cross it.
    const probe={box:area,rotation:place.rotation,blank:!pixels&&!across.length,text:'',confidence:0},id=`edge-${edgeProbes.length}`,before=result.words.length;edgeProbes.push(probe);
    if(!pixels){if(across.length){const seen=[...new Set(across.map(word=>word.text.trim()))];probe.text=seen.slice(0,6).join(' ');probe.confidence=across.reduce((n,word)=>n+word.confidence,0)/across.length;}continue;}
    await worker.setParameters({tessedit_pageseg_mode:'6'});
    await readLine({rotation:place.rotation,region:area,scale,letter:place.letter,cut:{left:false,right:false}},pixels,`edge:${place.rotation}`,id,{stretch:1.5});
    const fresh=result.words.slice(before).filter(word=>/[\p{L}\p{N}]/u.test(word.text));
    probe.text=fresh.map(word=>word.text).join(' ');probe.confidence=fresh.length?fresh.reduce((n,word)=>n+word.confidence,0)/fresh.length:0;
    lineShots.push({image:pixels,region:area,rotation:place.rotation,id,cut:{}});
   }
  }
  await worker.setParameters({thresholding_method:'0'});
  if(state.rules.some(isQuantityRule)){
   const quantityAreas=quantityReadAreas(result.words,region,state.hasContour);
   for(let i=0;i<quantityAreas.length;i++){
    const area=quantityAreas[i];state.busyMessage=`Отдельно читаем количество и единицу: ${i+1} из ${quantityAreas.length}`;
    await worker.setParameters({tessedit_pageseg_mode:'7'});
    const extra=await read(area,makeCanvas(area),area.rotation,2);
    if(extra.text.trim()){result.text+='\n'+extra.text;result.words.push(...extra.words);}
   }
  }
  if(state.rules.some(isQuantityRule)){
   const areas=quantityReadAreas(result.words,region,state.hasContour).filter(area=>area.rotation===0).slice(0,4);
   for(const area of areas){
    const units=result.words.filter(w=>w.confidence>=75&&/^(?:л|l|мл|ml|кг|kg|г|g)$/i.test(w.text.trim())&&w.box.x>area.x&&w.box.x<area.x+area.w&&w.box.y>=area.y&&w.box.y+w.box.h<=area.y+area.h+.001);
    const unit=units.sort((a,b)=>b.confidence-a.confidence)[0];if(!unit)continue;
    const numberArea={...area,w:unit.box.x-area.x};if(numberArea.w<=0)continue;
    const c=makeCanvas(numberArea),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height),ink=numericInk(pixels);
    if(!ink.digits.length||ink.digits.length>8)continue;
    state.busyMessage='Проверяем цифры количества и десятичный разделитель';
    await worker.setParameters({tessedit_pageseg_mode:'8',tessedit_char_whitelist:'0123456789.,'});
    const {data}=await worker.recognize(c,{}, {text:true,blocks:true}),raw=(data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>(p.lines||[]).flatMap(l=>l.words||[]))),symbols=raw.flatMap(w=>w.symbols||[]),text=recoverNumericReading(data.text,symbols,ink);
    if(!text)continue;
    const mm=pageUnits.height*numberArea.h/c.height,pass=`quantity-digits-${++readPass}`;
    const numericWord={text,confidence:Math.min(...symbols.filter(s=>/\d/.test(s.text)).map(s=>s.confidence)),box:numberArea,rotation:0,pass,glyphs:ink.digits.map((d,i)=>({text:text.replace(',','')[i],height:mm?d.h*mm:null}))};
    result.words.push(numericWord,{...unit,readingBox:undefined,line:undefined,pass});result.text+='\n'+text+' '+unit.text;
   }
   await worker.setParameters({tessedit_char_whitelist:''});
  }
  // Callouts are read on the whole sheet except the printed label itself. The
  // number comes from a Latin model, the indicated inscription from the text model.
  let calloutReadings=[];
  {
   state.busyMessage='Ищем выноски размеров на техническом листе';
   const source=document.createElement('canvas'),sourceContext=source.getContext('2d',{willReadFrequently:true});
   const crop=(box,pad)=>{const x=Math.max(0,Math.floor(box.x0/sheetScale-pad)),y=Math.max(0,Math.floor(box.y0/sheetScale-pad)),w=Math.max(1,Math.min(img.width,Math.ceil(box.x1/sheetScale+pad))-x),h=Math.max(1,Math.min(img.height,Math.ceil(box.y1/sheetScale+pad))-y);source.width=w;source.height=h;sourceContext.drawImage(img,x,y,w,h,0,0,w,h);return {pixels:sourceContext.getImageData(0,0,w,h),x,y};};
   const picture=image=>{const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').putImageData(new ImageData(image.data,image.width,image.height),0,0);return c;};
   let calloutWorker;
   try{
    calloutWorker=await createWorker('eng',1,{workerPath:new URL('./vendor/worker.min.js',location.href).href,corePath:new URL('./vendor/core/',location.href).href,langPath:new URL('./assets/lang/',location.href).href});
    await calloutWorker.setParameters({tessedit_pageseg_mode:'7'});
    const readLatin=async image=>{const {data}=await calloutWorker.recognize(picture(image));return {text:data.text,confidence:data.confidence};};
    const readWords=async(image,mode)=>{await worker.setParameters({tessedit_pageseg_mode:mode==='word'?'8':'7'});const {data}=await worker.recognize(picture(image));return {text:data.text,confidence:data.confidence};};
    calloutReadings=await readCallouts({sheet,scale:sheetScale,crop,readLatin,readWords,avoid:state.hasContour?[region]:[],progress:(stage,i,n)=>{state.busyMessage=stage==='callout'?`Читаем выноски размеров: ${i+1} из ${n}`:`Определяем, на что указывает выноска: ${i+1} из ${n}`;}});
   }catch(error){console.warn('Callout OCR unavailable',error);}finally{await calloutWorker?.terminate();}
  }
  // Finish the primary OCR worker before starting the independent engine.
  // This also frees its WASM image buffers after the supplementary callouts.
  await worker.terminate();worker=null;workerLanguage='';
  let secondaryWords=[],secondaryIssue='';
  if(state.hasContour){
   const primary=matchRequirements(state.rules,result.words,state.volume,state.margin?state.marginAmount:false,region,true);
   const uncertain=Object.values(primary).filter(match=>match&&!match.exact&&match.coverage>=70&&match.method!=='manual');
   if(uncertain.length){
    const rotations=[0,...new Set(uncertain.map(match=>match.rotation).filter(rotation=>rotation===90||rotation===270))];
    state.busyMessage='Проверяем спорные фразы независимым OCR';render();
    try{const {readWithSecondaryOcr}=await import('./secondary-ocr.js');secondaryWords=await readWithSecondaryOcr(canvas,region,rotations);}
    catch(error){secondaryIssue=' Дополнительное чтение не удалось; результаты основного OCR сохранены.';console.warn('Secondary OCR unavailable',error);}
   }
   // Every isolated line goes to the second engine as well, not only disputed phrases.
   if(lineShots.length){
    state.busyMessage='Читаем каждую строку независимым OCR';render();
    try{const {readLinesWithSecondaryOcr}=await import('./secondary-ocr.js');secondaryWords.push(...await readLinesWithSecondaryOcr(lineShots,img.width/img.height));}
    catch(error){secondaryIssue=' Построчное независимое чтение не удалось; результаты основного OCR сохранены.';console.warn('Secondary line OCR unavailable',error);}
   }
  }
  // Settle the physical scale. A PDF has it by construction; an image gets it
  // only when the stated label size agrees with the found contour.
  const scale=state.pdf?{source:'pdf',level:'high',mmPerPixel:state.pageMm.width/img.width,declared,label:{width:state.pageMm.width*region.w,height:state.pageMm.height*region.h},fits:state.hasContour&&declared?fitsDeclared(region):null}:scaleFor(region);
  if(!state.pdf){
   const factor=scale.mmPerPixel;
   for(const word of result.words){
    for(const glyph of word.glyphs||[])glyph.height=factor&&Number.isFinite(glyph.height)?glyph.height*factor:null;
    word.mmPerPixel=factor&&word.mmPerPixel?word.mmPerPixel*factor:null;word.sourcePixelMm=factor&&word.sourcePixelMm?word.sourcePixelMm*factor:null;
   }
   state.pageMm=factor?{width:img.width*factor,height:img.height*factor}:null;state.geometryConfirmed=scale.level==='high';
   state.contourStep=factor?factor/sheetScale:null;
  }
  Object.assign(state,{edgeProbes,scale,label:region,width:state.pageMm?state.pageMm.width*region.w:0,height:state.pageMm?state.pageMm.height*region.h:0,full:false,words:result.words,secondaryWords,calloutReadings,actual:result.text,origin:'Автоматическое OCR · порядок по координатам',analysisNote:(state.hasContour?'Текст сверяется внутри найденного контура этикетки. Увеличенные образцы вне контура не подтверждают наличие текста на этикетке.':'Текст проверен по расположению на листе. Контур не определён уверенно.')+(calloutReadings.length?' Размеры из выносок техлиста сверяются отдельно как заявление типографии.':'')+(secondaryWords.length?' Спорные фразы дополнительно прочитаны независимым OCR.':'')+secondaryIssue,busy:false,edited:false,progress:1});
  rematch();state.previewFocus=true;if(!state.actual.trim())state.error='Текст не распознан. Загрузите более чёткий PDF или изображение.';render();toast('Автоматическая сверка завершена. Выберите требование, чтобы увидеть найденный блок.');
 }catch(error){if(worker){try{await worker.terminate();}catch{}worker=null;}fail('Не удалось завершить автоматическую проверку: '+error.message+'. Попробуйте другой PDF или повторите проверку.');}
}
function exportReport(){const result=rows();const done=result.length>0&&result.every(r=>['pass','na'].includes(r.status))&&state.geometryConfirmed;const stamp=new Date().toLocaleString('ru-RU',{timeZone:'Europe/Minsk'});const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отчёт проверки маркировки</title><style>body{font:15px/1.5 Arial,sans-serif;max-width:1200px;margin:40px auto;color:#172033}h1{font-size:26px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:12px;border:1px solid #ccd3dd;text-align:left;vertical-align:top}.pass{color:#137a4b}.error,.issue{color:#b42318}.pending{color:#765900}pre{white-space:pre-wrap;font-family:inherit}small{color:#526175}@media print{body{margin:10mm}tr{break-inside:avoid}}</style><h1>Отчёт проверки контрэтикетки</h1><p><strong>${esc(state.product||state.category)} · ${esc(state.volume)} л</strong><br>Дата: ${esc(stamp)} (Минск)<br>Требования: ${esc(state.sourceName)}<br>Макет: ${esc(state.fileName)} · страница ${state.page}<br>Режим: ${state.margin?'Минимумы + запас '+format(state.marginAmount)+' мм':'Минимумы из Word'}<br>Масштаб: ${esc(scaleText())}</p><h2>${done?'Все разделы подтверждены специалистом':'Проверка НЕ ЗАВЕРШЕНА'}</h2><p>Это отчёт сверки с предоставленным Word. Автоматическое распознавание не является подтверждением соответствия. Читаемость на фоне и юридическая актуальность требований сайтом не устанавливаются.</p><table><thead><tr><th>Раздел</th><th>Ожидаемый текст</th><th>Размеры и условия</th><th>Результат</th><th>Комментарий</th></tr></thead><tbody>${result.map(r=>`<tr><td>${esc(r.title)}</td><td>${esc(r.expected).replace(/\n/g,'<br>')}</td><td>${esc(r.constraint)}<br>${r.quantity?esc('Количество из Word: '+(r.quantity.expected?format(r.quantity.expected.value)+' '+r.quantity.expected.unit:'не выбран вариант')+'; OCR: '+(r.quantity.actual?format(r.quantity.actual.value)+' '+r.quantity.actual.unit:'не прочитано'))+'<br>':''}${r.dimensions.map(d=>`${esc(d.label)}: ${d.value==null?'не измерено':(d.meta?.method==='declared'?'заявлено выноской ':d.estimated?'≈ по растру ':'')+format(d.value)+' '+d.unit}; минимум ${format(d.min)} ${d.unit}${d.formula?'; '+esc(formulaText(d.formula)):''}${(d.declared||[]).length&&d.meta?.method!=='declared'?'; выноски техлиста: '+d.declared.map(item=>format(item.value)+' '+d.unit+' ('+levelNames[item.level]+' уверенность'+(item.raster?item.raster.agrees?', согласуется с растром':', расходится с растром':'')+')').join(', '):''}${d.reason?'; '+esc(d.reason):''}${d.meta?.pixelStep?'; шаг растра '+format(d.meta.pixelStep)+' мм/пиксель (не полная погрешность)':''}${d.meta?.method==='rectangle'?'; отношение площадей охватывающих прямоугольников, не площадь чернил':''}${d.borderline?'; пограничный замер':''}${d.target==='quantity'&&r.quantity?'; цифры ≈ '+(Number.isFinite(r.quantity.numberHeight)?format(r.quantity.numberHeight):'не измерены')+' мм; единица ≈ '+(Number.isFinite(r.quantity.unitHeight)?format(r.quantity.unitHeight):'не измерена')+' мм':''}`).join('<br>')}</td><td class="${r.comparison.status==='uncertain'?'pending':r.status}">${r.statusLabel||statuses[r.status][0]}<br>${comparisonNames[r.comparison.status]}${state.matches[r.id]?.recognizedText?"<br>Найденная фраза: "+esc(state.matches[r.id].recognizedText):""}${state.matches[r.id]?.ocrEvidence?"<br>Основное OCR: "+esc(state.matches[r.id].ocrEvidence.primary)+"<br>Независимое OCR: "+esc(state.matches[r.id].ocrEvidence.secondary):""}${(state.matches[r.id]?.diff||[]).map(d=>(r.comparison.status==='uncertain'?"<br>Неуверенное чтение OCR — Word: ":"<br>Word: ")+esc(d.expected||"нет в требовании")+" → OCR: "+esc(d.actual||(d.anchored?(d.edge?(d.edge.blank?"нет на макете (место перечитано крупнее: пусто)":"нет на макете (на этом месте напечатано другое)"):"нет на макете (соседние слова прочитаны)"):"не найдено: нет на макете либо не прочитано"))).join("")}<br>Текст подтверждён: ${r.state.textConfirmed?'да':'нет'}<br>Условия столбца 2: ${r.state.constraintsConfirmed?'подтверждены':'не подтверждены'}${/окно.*дат/i.test(r.title)?'<br>Окно и цифры даты подтверждены: '+(r.state.windowConfirmed?'да':'нет'):''}</td><td>${esc(r.state.note||'')}</td></tr>`).join('')}</tbody></table>${annotationReport()}${state.sourceDiagnostics?.length?'<h2>Разбор документа требует проверки</h2><p>'+state.sourceDiagnostics.map(esc).join('<br>')+'</p>':''}${state.globalConditions?.length?'<h2>Общие условия документа</h2><p>'+state.globalConditions.map(esc).join('<br>')+'</p>':''}<h2>Извлечённый текст макета</h2><small>Источник: ${esc(state.origin||'Не извлечён')}${state.edited?' · отредактирован вручную':''}</small><pre>${esc(state.actual||'Распознавание не выполнено')}</pre></html>`;const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='Проверка маркировки_'+(state.product||state.category).replace(/[^\p{L}\p{N} ._-]/gu,'')+'.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Отчёт скачан. Его можно открыть и распечатать в PDF.');}
// Read-only handle for scripted audits of a real browser run (?audit in the URL).
if(new URLSearchParams(location.search).has('audit'))window.__labelCheckState=state;
render();
window.addEventListener('resize',()=>drawPreview());
