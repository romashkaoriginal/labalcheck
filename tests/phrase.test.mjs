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
