import test from 'node:test';
import assert from 'node:assert/strict';
import {locatePhrase,phraseTokens,refinementAreas,orderedTextCandidates} from '../src/phrase.js';
import {evaluate} from '../src/engine.js';
import {matchRequirements} from '../src/automatic.js';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';

const line=(text,x=.1,y=.1,pass='one')=>text.split(' ').map((text,i)=>({text,confidence:96,pass,box:{x:x+i*.07,y,w:.065,h:.025}}));

test('spatial order restores a sentence even if OCR returns words in a different order',()=>{
 const words=line('Хранить плотно закрытым');
 const match=locatePhrase('ХРАНИТЬ ПЛОТНО ЗАКРЫТЫМ',[words[2],words[0],words[1]]);
 assert.equal(match.exact,true);assert.equal(match.recognizedText,'Хранить плотно закрытым');
});
test('line wrapping and hyphenation preserve the phrase and both word boxes',()=>{
 const words=[...line('Вода подготовленная ИСПРАВ-',.1,.1),...line('ЛЕННАЯ сахар белый',.1,.14)];
 const match=locatePhrase('Вода подготовленная исправленная сахар белый',words.reverse());
 assert.equal(match.exact,true);assert.equal(match.words.length,6);
});
test('words in unrelated columns never form an exact sentence',()=>{
 const words=[...line('Хранить',.05,.1),...line('плотно',.55,.1),...line('закрытым',.8,.7)];
 const match=locatePhrase('Хранить плотно закрытым',words);
 assert.equal(match.exact,false);assert.equal(match.distributed,true);
});
test('complete sentences can be verified independently in separate panels',()=>{
 const words=[...line('Хранить плотно закрытым.',.1,.1),...line('После вскрытия употребить сразу.',.5,.6)];
 const match=locatePhrase('Хранить плотно закрытым.\nПосле вскрытия употребить сразу.',words);
 assert.equal(match.exact,true);assert.equal(match.method,'fragments');assert.equal(match.fragments,2);
});
test('several OCR attempts can corroborate adjacent words at their physical positions',()=>{
 const words=[...line('Крепость',.1,.1,'a'),...line('40 %',.17,.1,'b')];
 assert.equal(locatePhrase('Крепость 40 %',words).exact,true);
 assert.equal(locatePhrase('Крепость 40 %',[...line('Крепость',.1,.1,'a'),...line('40 %',.6,.7,'b')]).exact,false);
});
test('changed numeric values produce a specific substitution',()=>{
 const match=locatePhrase('Крепость 40 %',line('Крепость 45 %'));
 assert.equal(match.exact,false);assert.deepEqual(match.diff,[{kind:'replace',expected:'40',actual:'45',confidence:96}]);
});
test('high-confidence changed digits remain a possible real mismatch',()=>{
 const rule={id:'code',title:'Регламент',text:'ТР ТС 021/2011',original:'ТР ТС 021/2011',constraint:''};
 const match=locatePhrase(rule.text,line('ТР ТС 022/2011'));
 assert.equal(match.diff[0].confidence,96);
 assert.equal(evaluate([rule],'ТР ТС 022/2011',{automatic:{code:match}})[0].comparison.status,'partial');
});
test('a weak adjacent replacement does not hide a confidently different numeric value',()=>{
 const rule={id:'date',title:'Дата',text:'Дата розлива партии 01 2025 года',original:'Дата розлива партии 01 2025 года',constraint:''};
 const actual=line('Дата розлива партии 02 2026 года');actual[4].confidence=20;
 const match=locatePhrase(rule.text,actual,orderedTextCandidates(actual,false));
 assert.equal(match.diff[0].confidence,96);
 assert.equal(evaluate([rule],actual.map(word=>word.text).join(' '),{automatic:{date:match}})[0].comparison.status,'partial');
});
test('sample maker, warning and supplemental text do not report weak OCR glyphs as printed differences',()=>{
 const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/sample-ocr.json.gz',import.meta.url))));
 const rules=fixture.rules.filter(rule=>['r3','r7','r16'].includes(rule.id));
 const matches=matchRequirements(rules,fixture.words,'0,7',false,fixture.label,true);
 const rows=evaluate(rules,fixture.words.map(w=>w.text).join(' '),{automatic:matches});
 for(const row of rows){assert.equal(row.comparison.status,'uncertain',row.title);assert.equal(row.statusLabel,'Неуверенное OCR');assert.equal(row.status,'issue');}
 assert.equal(matches.r3.method,'sections');
 assert.ok(matches.r3.recognizedText.startsWith('СТРАНА ПРОИСХОЖДЕНИЯ'));
 assert.doesNotMatch(matches.r3.recognizedText.slice(0,60),/КДЖ|ККАЛ|930/);
 assert.ok(matches.r16.diff.every(d=>d.confidence<75));
 assert.ok(refinementAreas(matches).every(area=>area.h<.15));
});
test('missing percent and an extra negation cannot become exact matches',()=>{
 assert.deepEqual(locatePhrase('Крепость 40 %',line('Крепость 40')).diff,[{kind:'missing',expected:'%',actual:'',confidence:0}]);
 const match=locatePhrase('Хранить в холодильнике',line('Хранить не в холодильнике'));
 assert.equal(match.exact,false);assert.ok(match.diff.some(d=>d.actual==='не'));
});
test('one-letter words and repeated occurrences are necessary',()=>{
 assert.equal(locatePhrase('Вода и сахар',line('Вода сахар')).exact,false);
 assert.equal(locatePhrase('Хранить плотно плотно закрытым',line('Хранить плотно закрытым')).exact,false);
});
test('repeated fragments cannot reuse one physical occurrence across OCR passes',()=>{
 const words=[...line('Хранить плотно закрытым.',.1,.1,'one'),...line('Хранить плотно закрытым.',.1,.1,'two')];
 assert.equal(locatePhrase('Хранить плотно закрытым.\nХранить плотно закрытым.',words).exact,false);
});
test('rotated OCR uses its reading coordinates while highlighting original coordinates',()=>{
 const words=line('Алкоголь вредит здоровью').map((w,i)=>({...w,rotation:90,readingBox:{x:i*50,y:10,w:45,h:15},box:{x:.2,y:.7-i*.1,w:.03,h:.09}}));
 const match=locatePhrase('Алкоголь вредит здоровью',words.reverse());assert.equal(match.exact,true);assert.equal(match.rotation,90);
});
test('numbers and visually equivalent temperature units normalize without changing values',()=>{
 assert.deepEqual(phraseTokens('0.7 л 30 °C'),phraseTokens('0,7 л 30 °С'));
 assert.equal(locatePhrase('Объем 0,7 л',line('ОБЪЕМ 0.7 Л')).exact,true);
});
test('a typographic separator in nutrition is not a negative number',()=>{
 assert.deepEqual(phraseTokens('Углеводы – 0,1 г'),phraseTokens('Углеводы 0,1 г'));
 assert.notDeepEqual(phraseTokens('-15 °С'),phraseTokens('15 °С'));
});
test('conflicting strong numeric readings stay uncertain instead of choosing the expected value',()=>{
 const words=[...line('Крепость 40 %',.1,.1,'a'),...line('Крепость 45 %',.1,.1,'b')];
 const match=locatePhrase('Крепость 40 %',words);assert.equal(match.exact,false);assert.ok(match.diff.some(d=>d.kind==='uncertain'&&d.actual.includes('45')));
});
test('one weak alternative cannot correct a spelling just because it appears in Word',()=>{
 const words=[...line('Хранить плотна закрытым',.1,.1,'a'),...line('Хранить плотно закрытым',.1,.1,'b').map(w=>({...w,confidence:31}))];
 const candidates=words.filter(w=>w.pass==='a'||w.text==='плотно');
 assert.equal(locatePhrase('Хранить плотно закрытым',candidates).exact,false);
});
test('a flattened text match cannot override a spatially unsupported phrase',()=>{
 const rule={id:'r0',title:'Условия хранения',text:'Хранить плотно закрытым',original:'Хранить плотно закрытым',constraint:''};
 const automatic={r0:locatePhrase(rule.text,[...line('Хранить',.05,.1),...line('плотно',.55,.1),...line('закрытым',.8,.7)])};
 assert.equal(evaluate([rule],rule.text,{automatic})[0].comparison.status,'all_words');
});
test('ambiguous local phrases request one bounded reread and exact phrases request none',()=>{
 const match=locatePhrase('Хранить в холодильнике',line('Хранить не в холодильнике'));
 assert.equal(refinementAreas({a:match,b:match}).length,1);
 assert.equal(refinementAreas({a:locatePhrase('Хранить плотно закрытым',line('Хранить плотно закрытым'))}).length,0);
});
test('extra words lower phrase similarity even when every expected word has been read',()=>{
 const rule={id:'r0',title:'Условия хранения',original:'Хранить в холодильнике',text:'Хранить в холодильнике',constraint:''};
 const match=locatePhrase(rule.text,line('Хранить не в холодильнике'));assert.equal(match.coverage,100);
 const result=evaluate([rule],rule.text,{automatic:{r0:match}})[0];assert.equal(result.comparison.status,'partial');assert.ok(result.comparison.coverage<100);
});

test('a long incomplete vertical warning is reread even when a short nearby phrase already has an area',()=>{
 const word=(text,y)=>({text,rotation:90,confidence:65,box:{x:.45,y,w:.02,h:.035}});
 const short={words:[word('Срок',.54),word('годности',.58)],exact:false,coverage:90,rotation:90,method:'layout'};
 const warning={words:[word('Чрезмерное',.57),word('вашему',.4),word('здоровью',.35)],exact:false,distributed:true,coverage:50,method:'words'};
 const areas=refinementAreas({short,warning});
 assert.equal(areas.length,2);assert.equal(areas[0].rotation,90);assert.ok(areas[0].h>.2);
});

// ---- words inserted on the print, words beside the phrase, readings that disagree ----
const placed=(text,x,y,{pass='one',confidence=96,step=.04,w=.036,h=.02,rotation=0}={})=>text.split(' ').map((text,i)=>({text,confidence,pass,rotation,box:{x:x+i*step,y,w,h}}));
test('a clause inserted on the label does not cost the phrase its beginning',()=>{
 // The label prints six more words after the fifth; the line then wraps.
 const words=[...placed('Состав: виноматериал виноградный натуральный белый из сортов винограда европейской группы',.05,.10),...placed('(содержит пищевую добавку антиокислитель), вода питьевая, сахар.',.05,.13)];
 const match=locatePhrase('Состав: виноматериал виноградный натуральный белый (содержит пищевую добавку антиокислитель), вода питьевая, сахар.',words);
 assert.equal(match.exact,false);assert.equal(match.coverage,100,'every word of the requirement is found');
 assert.deepEqual(match.diff.map(d=>[d.kind,d.actual]),[['extra','из сортов винограда европейской группы']]);
 // A reread that stopped half-way down the first line has fewer extra words and must not be preferred.
 const cut=[...placed('Состав: виноматериал виноградный',.05,.10,{pass:'cut'}),...placed('(содержит пищевую добавку антиокислитель), вода питьевая, сахар.',.05,.13,{pass:'cut'})];
 const both=locatePhrase('Состав: виноматериал виноградный натуральный белый (содержит пищевую добавку антиокислитель), вода питьевая, сахар.',[...words,...cut]);
 assert.equal(both.coverage,100);assert.ok(both.diff.some(d=>d.kind==='extra'&&/сортов/.test(d.actual)),'the inserted clause is shown');
 assert.ok(!both.diff.some(d=>d.kind==='missing'));
});
test('a repetition of the phrase further on does not pull a badly read part of it away',()=>{
 const words=[...placed('Уровни установленные ТРО ОТ 021/2011 пищевой продукщиий',.05,.1),...placed('Соответствует требованиям ТР ТС 021/2011 пищевой продукции',.05,.13)];
 const match=locatePhrase('Уровни установленные ТР ТС 021/2011 пищевой продукции',words);
 assert.ok(!match.diff.some(d=>d.kind==='extra'&&/соответствует/i.test(d.actual)),'the reading stays in its own sentence');
 assert.ok(match.diff.every(d=>d.kind!=='extra'||d.confidence<75||!/требованиям/.test(d.actual)));
});
test('a line of a neighbouring column threaded through a phrase is beside it, not inserted into it',()=>{
 // Reading order of one pass: first line, a line of the column to the left, second line.
 const first=placed('Место нахождения: Республика Беларусь,',.40,.10),aside=placed('с цветочными оттенками',.05,.10),second=placed('Гомельская обл., Гомельский район.',.40,.13);
 const words=[...first,...aside,...second].map((word,i)=>({...word,line:i<first.length?'a':i<first.length+aside.length?'a':'b'}));
 const match=locatePhrase('Место нахождения: Республика Беларусь, Гомельская обл., Гомельский район.',words);
 assert.equal(match.exact,true);assert.ok(!match.words.some(word=>/цветочными/.test(word.text)),'the words beside are not part of the found phrase');
 // A word on the line above is not between the two words either.
 const above=[...placed('Крепость',.05,.30),{text:'СТБ',confidence:90,pass:'one',box:{x:.13,y:.27,w:.03,h:.02},line:'t'},...placed('40 %',.09,.30)];
 assert.equal(locatePhrase('Крепость 40 %',above.map(word=>({...word,line:word.line||'t'}))).exact,true);
 // A word really printed between them stays a difference.
 assert.equal(locatePhrase('Хранить в холодильнике',line('Хранить не в холодильнике')).exact,false);
});
test('one word read twice at one place is not a repetition on the print',()=>{
 const one=placed('тел. 93-64-93.',.1,.1,{pass:'one',step:.09,w:.08}),two=placed('тел. 93-64-93.',.1,.1,{pass:'two',step:.09,w:.074});
 const match=locatePhrase('тел. 93-64-93.',[...one,...two]);
 assert.equal(match.exact,true);
});
test('passes that disagree at one place give an uncertain reading, not a difference',()=>{
 const rule={id:'n',title:'Пищевая ценность',text:'Пищевая ценность на 100 мл продукта',original:'Пищевая ценность на 100 мл продукта',constraint:''};
 const good=placed('Пищевая ценность на 100 мл продукта',.1,.1,{pass:'one',confidence:70}),bad=placed('Пищевая ценность на 190 мл продукта',.1,.1,{pass:'two',confidence:88});
 good[3].confidence=90;                                    // one pass reads the required number with confidence
 const match=locatePhrase(rule.text,[...bad,good[3]]);
 assert.ok(match.exact||match.diff.every(d=>d.kind==='uncertain'),'not a confident difference');
 assert.notEqual(evaluate([rule],'',{automatic:{n:{...match,scope:'label'}}})[0].statusLabel,'Проверить число');
 // Without a second witness the confident different number stays a difference.
 assert.deepEqual(locatePhrase(rule.text,bad).diff.map(d=>[d.kind,d.actual]),[['replace','190']]);
});

test('lost and spurious word spaces are the same letters in the same order',()=>{
 assert.equal(locatePhrase('Срок годности не ограничен',placed('СРОКГОДНОСТИ НЕ ОГРАНИЧЕН',.1,.1,{step:.12,w:.11})).exact,true);
 assert.equal(locatePhrase('Вода исправленная, спирт',placed('Вода исправ ленная, спирт',.1,.1)).exact,true);
 // Digits are never run together or parted: their grouping is their value.
 assert.equal(locatePhrase('Партия 12 5 штук',placed('Партия 125 штук',.1,.1)).exact,false);
 // Another letter is another word: "СРОКТОДНОСТИ" is not "срок годности".
 assert.equal(locatePhrase('Срок годности не ограничен',placed('СРОКТОДНОСТИ НЕ ОГРАНИЧЕН',.1,.1,{step:.12,w:.11})).exact,false);
});

// ---- words missing at the edge of a phrase -----------------------------------
import {edgePlaces,settleEdges} from '../src/phrase.js';
test('words missing at the edge are absent only when their place was looked at and holds no such words',()=>{
 const sheet={width:1000,height:1000},caption=placed('Дата розлива',.30,.80,{step:.06,w:.055,h:.02});
 const find=()=>locatePhrase('Дата розлива номер партии',caption);
 const places=edgePlaces(find(),sheet);
 assert.equal(places.length,1);assert.equal(places[0].side,'trailing');assert.deepEqual(places[0].expected,['номер','партии']);assert.equal(places[0].beside,'розлива');
 const [rest,next]=places[0].areas;
 assert.ok(rest.x>=.415&&Math.abs(rest.y-.8)<.01&&rest.w>=.08,'the rest of the line after the last read word');
 assert.ok(next.y>.82&&next.x<=.31,'the line below, from where the phrase begins');
 const probe=(box,more)=>({box,rotation:0,blank:false,text:'',confidence:0,...more});
 // Not looked at: nothing is asserted.
 assert.equal(settleEdges(find(),[],sheet).diff[0].anchored,undefined);
 // Both places empty: the words are not on the print.
 const empty=settleEdges(find(),[probe(rest,{blank:true}),probe(next,{blank:true})],sheet);
 assert.equal(empty.diff[0].anchored,true);assert.deepEqual([empty.diff[0].edge.blank,empty.diff[0].edge.beside],[true,'розлива']);
 const rule={id:'d',title:'Подпись',text:'Дата розлива номер партии',original:'',constraint:''};
 assert.equal(evaluate([rule],'Дата розлива',{automatic:{d:{...empty,scope:'label'}}})[0].statusLabel,'Отличие текста');
 // Other words printed there, read with confidence: the words are not there either, and what stands there is told.
 const other=settleEdges(find(),[probe(rest,{blank:true}),probe(next,{text:'СТБ 1122 РЦ',confidence:93})],sheet);
 assert.equal(other.diff[0].anchored,true);assert.deepEqual(other.diff[0].edge.seen,['СТБ 1122 РЦ']);
 // Print that could not be read, or only one of the two places examined: nothing is asserted.
 assert.equal(settleEdges(find(),[probe(rest,{blank:true}),probe(next,{text:'нмр прт',confidence:35})],sheet).diff[0].anchored,undefined);
 assert.equal(settleEdges(find(),[probe(rest,{blank:true})],sheet).diff[0].anchored,undefined);
 // The words themselves read there: no absence; the matching takes them from the reading.
 assert.equal(settleEdges(find(),[probe(rest,{text:'номер партии',confidence:90}),probe(next,{blank:true})],sheet).diff[0].anchored,undefined);
 // The same words printed elsewhere on the label: not absent, only not here.
 const elsewhere=placed('номер партии',.6,.2);
 assert.equal(settleEdges(find(),[probe(rest,{blank:true}),probe(next,{blank:true})],sheet,[...caption,...elsewhere]).diff[0].anchored,undefined);
 // Turned text: the place is further up the page for text read after a quarter turn clockwise.
 const turned=['Дата','розлива'].map((text,i)=>({text,confidence:96,pass:'one',rotation:90,box:{x:.5,y:.8-i*.07,w:.02,h:.06}}));
 const place=edgePlaces(locatePhrase('Дата розлива номер партии',turned),sheet)[0];
 assert.equal(place.rotation,90);assert.ok(place.areas[0].y+place.areas[0].h<=.731&&Math.abs(place.areas[0].x-.5)<.01,'above the last word, in its column');
 assert.ok(place.areas[1].x>.52,'the next line stands to the right');
});
