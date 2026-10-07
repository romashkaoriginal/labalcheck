import test from 'node:test';
import assert from 'node:assert/strict';
import {locatePhrase,phraseTokens,refinementAreas} from '../src/phrase.js';
import {evaluate} from '../src/engine.js';

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
 assert.equal(match.exact,false);assert.deepEqual(match.diff,[{kind:'replace',expected:'40',actual:'45'}]);
});
test('missing percent and an extra negation cannot become exact matches',()=>{
 assert.deepEqual(locatePhrase('Крепость 40 %',line('Крепость 40')).diff,[{kind:'missing',expected:'%',actual:''}]);
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
