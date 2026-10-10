// Accuracy of a reading against the hand-made transcription of a label.
// Nothing here knows which method produced the reading: it gets the truth
// lines and the texts a method read, and counts.
import {orderedTextCandidates,phraseTokens} from '../../src/phrase.js';
import {insideLabel} from '../../src/quantity.js';

// Strict text: only differences no reader could be blamed for are removed —
// the several dashes, degree signs and quotation marks of typography, and runs
// of spaces. Case, punctuation and spaces count.
export const strict=text=>String(text??'').normalize('NFC').replace(/[–—−‐‑]/g,'-').replace(/[º˚⁰]/g,'°').replace(/[«»“”„‟]/g,'"').replace(/\s+/g,' ').trim();
// Letters and digits only, the way the comparison with Word sees a text: case
// folded, letters of one shape in Latin and Cyrillic (and 0 / О) taken as one,
// spaces and punctuation left out.
const twins={a:'а',e:'е',o:'о',c:'с',p:'р',x:'х',y:'у',k:'к',m:'м',t:'т',h:'н',b:'в','0':'о'};
export const letters=text=>strict(text).toLowerCase().replace(/ё/g,'е').replace(/[aeocpxykmthb0]/g,char=>twins[char]).replace(/[^\p{L}\p{N}]/gu,'');

// The stretch of `hypothesis` closest to `reference` (both arrays), by edit
// distance: the start and the end inside the hypothesis are free, so a line is
// looked for inside a whole column of read text.
function distanceWithin(reference,hypothesis){
 const m=reference.length,n=hypothesis.length;let previous=new Uint16Array(n+1),current=new Uint16Array(n+1);
 for(let i=1;i<=m;i++){
  current[0]=i;const item=reference[i-1];
  for(let j=1;j<=n;j++){const a=previous[j-1]+(item===hypothesis[j-1]?0:1),b=previous[j]+1,c=current[j-1]+1;current[j]=a<b?(a<c?a:c):(b<c?b:c);}
  [previous,current]=[current,previous];
 }
 let best=m;for(let j=0;j<=n;j++)if(previous[j]<best)best=previous[j];
 return best;
}
// The same alignment written out: what happened to every item of the
// reference, and what was read between them.
function alignWithin(reference,hypothesis){
 const m=reference.length,n=hypothesis.length,width=n+1,table=new Uint16Array((m+1)*width);
 for(let i=1;i<=m;i++){
  table[i*width]=i;const item=reference[i-1];
  for(let j=1;j<=n;j++){const a=table[(i-1)*width+j-1]+(item===hypothesis[j-1]?0:1),b=table[(i-1)*width+j]+1,c=table[i*width+j-1]+1;table[i*width+j]=a<b?(a<c?a:c):(b<c?b:c);}
 }
 let end=0;for(let j=1;j<=n;j++)if(table[m*width+j]<table[m*width+end])end=j;
 const status=new Array(m).fill('missing'),inserted=Array.from({length:m+1},()=>[]),at=new Array(m).fill(-1);let i=m,j=end;
 while(i>0){
  const here=table[i*width+j];
  if(j>0&&here===table[(i-1)*width+j-1]+(reference[i-1]===hypothesis[j-1]?0:1)){status[i-1]=reference[i-1]===hypothesis[j-1]?'same':'other';at[i-1]=j-1;i--;j--;}
  else if(here===table[(i-1)*width+j]+1){status[i-1]='missing';i--;}
  else{inserted[i].unshift(hypothesis[j-1]);j--;}
 }
 // `at`: where in the hypothesis each item of the reference was read.
 return {distance:table[m*width+end],status,inserted,at,hypothesis};
}
export function closest(reference,hypotheses){
 let best=null,score=Infinity;
 for(const hypothesis of hypotheses){if(!hypothesis.length)continue;const distance=distanceWithin(reference,hypothesis);if(distance<score){score=distance;best=hypothesis;if(!distance)break;}}
 return best?alignWithin(reference,best):{distance:reference.length,status:new Array(reference.length).fill('missing'),inserted:Array.from({length:reference.length+1},()=>[]),at:new Array(reference.length).fill(-1),hypothesis:[]};
}

const numberToken=/[^\s]*\d[^\s]*/g;
// One truth line against everything a method read.
//   characters  strict characters and their errors (other, missing, extra)
//   letters     the same on letters and digits only
//   words       strict words
//   numbers     tokens with a digit (0,75 · Е220 · 190239501.9-21.200): right
//               only when every character is right and no digit was added
//   marks       punctuation and signs of the truth line
//   tokens      words and numbers as the comparison with Word splits them
//               (src/phrase.js): case, punctuation and letter twins do not
//               count there; numberTokens are those with a digit
export function scoreLine(text,hypotheses){
 const reference=strict(text),chars=[...reference],strictTexts=hypotheses.map(strict);
 const byChar=closest(chars,strictTexts.map(value=>[...value]));
 const letterReference=[...letters(text)],byLetter=closest(letterReference,hypotheses.map(value=>[...letters(value)]));
 const wordReference=reference.split(' '),byWord=closest(wordReference,strictTexts.map(value=>value.split(' ')));
 let numbers=0,numberErrors=0;const wrongNumbers=[];
 for(const match of reference.matchAll(numberToken)){
  // Brackets, quotes and the full stop of the sentence are not part of the number.
  const lead=match[0].match(/^["(]+/)?.[0].length||0,tail=match[0].match(/[")\].,;:]+$/)?.[0].length||0,from=match.index+lead,to=match.index+match[0].length-tail;
  if(to<=from)continue;numbers++;
  let right=true;for(let i=from;i<to;i++)if(byChar.status[i]!=='same'||i>from&&byChar.inserted[i].length)right=false;
  // A digit read right before or right after it makes it another number ("10,75" for "0,75").
  if(right&&(/\d/.test(byChar.hypothesis[byChar.at[from]-1]||'')||/\d/.test(byChar.hypothesis[byChar.at[to-1]+1]||'')))right=false;
  if(!right){numberErrors++;wrongNumbers.push(reference.slice(from,to));}
 }
 let marks=0,markErrors=0;
 chars.forEach((char,i)=>{if(!/[.,:;()%\/+\-°"!?]/.test(char))return;marks++;if(byChar.status[i]!=='same')markErrors++;});
 const tokenReference=phraseTokens(text),byToken=closest(tokenReference,hypotheses.map(value=>phraseTokens(value)));
 let numberTokens=0,numberTokenErrors=0;const wrongNumberTokens=[];
 tokenReference.forEach((token,i)=>{if(!/\d/.test(token))return;numberTokens++;if(byToken.status[i]!=='same'){numberTokenErrors++;wrongNumberTokens.push(token);}});
 return {text:reference,tokens:tokenReference.length,tokenErrors:byToken.distance,numberTokens,numberTokenErrors,wrongNumberTokens,characters:chars.length,characterErrors:byChar.distance,letters:letterReference.length,letterErrors:byLetter.distance,words:wordReference.length,wordErrors:byWord.distance,numbers,numberErrors,wrongNumbers,marks,markErrors,missed:byChar.status.every(value=>value==='missing')};
}

const fields=['characters','characterErrors','letters','letterErrors','words','wordErrors','numbers','numberErrors','marks','markErrors','tokens','tokenErrors','numberTokens','numberTokenErrors'];
const empty=()=>Object.fromEntries([...fields.map(name=>[name,0]),['lines',0],['linesMissed',0]]);
const add=(sum,line)=>{for(const name of fields)sum[name]+=line[name];sum.lines++;if(line.missed)sum.linesMissed++;return sum;};
export function scoreSheet(truth,hypotheses){
 const lines=truth.lines.map(line=>({...scoreLine(line.text,hypotheses),tags:line.tags||[],rotation:line.rotation||0})),total=empty(),byTag={};
 for(const line of lines){add(total,line);for(const tag of line.tags)add(byTag[tag]??=empty(),line);}
 return {lines,total,byTag};
}
export const sum=parts=>parts.reduce((all,part)=>{for(const name of Object.keys(all))all[name]+=part[name]||0;return all;},empty());
export const percent=(errors,total)=>total?Math.round(errors/total*1000)/10:null;

// Texts a method read on the label, in reading order, the way the comparison
// itself orders words (src/phrase.js). `fused` keeps only the one reading the
// site makes of all its passes; otherwise every pass is a text of its own.
export function readingTexts(words,{label=null,fused=false}={}){
 const inside=label?words.filter(word=>word.box&&insideLabel(word.box,label)):words;
 return orderedTextCandidates(inside).filter(candidate=>!fused||String(candidate.pass).startsWith('consensus:')).map(candidate=>candidate.words.map(word=>word.text).join(' ')).filter(text=>text.trim());
}
