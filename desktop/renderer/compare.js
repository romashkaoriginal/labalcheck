// What two methods say about one section, put side by side. No DOM here: the
// window and the scoring script (bench/score.mjs) both use these functions.
import {phraseTokens} from '../../src/phrase.js';

// What a method claims about the TEXT of a section — taken from the rows the
// existing comparison (src/engine.js `evaluate`) produces, criteria untouched:
//   match       the text of Word was found on the label
//   difference  a difference is asserted (other words, another number or unit)
//   unsure      read, but not settled either way
//   not-found   the text was not located
//   skip        nothing to compare (no text in Word, graphics, not applicable)
// Sizes are a separate question and do not enter here.
export function textVerdict(row,match){
 const status=row?.comparison?.status;
 if(!row||status==='na'||status==='manual')return 'skip';
 if(row.quantity&&row.quantity.status!=='match')return ['unreadable','ambiguous'].includes(row.quantity.status)?'unsure':'difference';
 if(match?.exact&&match.notation)return 'difference';
 if(row.comparison.confident)return 'difference';
 if(status==='found')return 'match';
 if(status==='uncertain'||status==='all_words')return 'unsure';
 return 'not-found';
}
export const verdictNames={match:'Совпадает',difference:'Отличие',unsure:'Спорно','not-found':'Не найдено',skip:'—'};

// Tokens of two readings with the ones the other reading lacks marked.
export function tokenDiff(left,right){
 const a=phraseTokens(left||''),b=phraseTokens(right||''),table=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i][j]=a[i]===b[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
 const first=[],second=[];let i=0,j=0;
 while(i<a.length&&j<b.length){
  if(a[i]===b[j]){first.push({token:a[i],same:true});second.push({token:b[j],same:true});i++;j++;}
  else if(table[i+1][j]>=table[i][j+1])first.push({token:a[i++],same:false});
  else second.push({token:b[j++],same:false});
 }
 while(i<a.length)first.push({token:a[i++],same:false});
 while(j<b.length)second.push({token:b[j++],same:false});
 return {left:first,right:second,different:first.some(item=>!item.same)||second.some(item=>!item.same)};
}
export const numbersOf=text=>phraseTokens(text||'').filter(token=>/\d/.test(token));

export function boundsOf(boxes){
 if(!boxes?.length)return null;
 const x=Math.min(...boxes.map(box=>box.x)),y=Math.min(...boxes.map(box=>box.y));
 return {x,y,w:Math.max(...boxes.map(box=>box.x+box.w))-x,h:Math.max(...boxes.map(box=>box.y+box.h))-y};
}

// One line per section: both verdicts, both readings, and whether they differ.
export function compareSections(rules,baseline,local){
 return rules.map(rule=>{
  const one=baseline?.rows.find(row=>row.id===rule.id),two=local?.rows.find(row=>row.id===rule.id),oneMatch=baseline?.matches[rule.id],twoMatch=local?.matches[rule.id];
  const base=one?textVerdict(one,oneMatch):null,loc=two?textVerdict(two,twoMatch):null,diff=oneMatch&&twoMatch?tokenDiff(oneMatch.recognizedText,twoMatch.recognizedText):null;
  const leftNumbers=numbersOf(oneMatch?.recognizedText),rightNumbers=numbersOf(twoMatch?.recognizedText);
  return {id:rule.id,title:rule.title,expected:one?.expected??two?.expected??rule.text,baseline:base,local:loc,verdictsDiffer:!!base&&!!loc&&base!==loc,readingsDiffer:!!diff?.different,
   numbersDiffer:!!oneMatch&&!!twoMatch&&leftNumbers.join(' ')!==rightNumbers.join(' '),diff,baselineMatch:oneMatch,localMatch:twoMatch,baselineRow:one,localRow:two};
 });
}
