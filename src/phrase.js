import {normalize,dehyphenate,fold,alike} from './engine.js';

export function phraseTokens(text){
 const tokens=normalize(dehyphenate(text)).match(/-?\d+(?:[,.]\d+)?|[\p{L}]+|[%°]/gu)||[];
 return tokens.map((token,i)=>/^[-]?\d+\.\d+$/.test(token)?token.replace('.',','):tokens[i-1]==='°'&&/^[cс]$/i.test(token)?'с':token);
}
const bounds=words=>{const boxes=words.map(w=>w.box);const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};};
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]||1;
const rect=word=>word.readingBox||word.box;
const uniqueWords=tokens=>[...new Set(tokens.flatMap(t=>t.words))];
function tokensForWords(words){
 const tokens=[];let wrap=false;
 for(const word of words){
  const next=phraseTokens(word.text).map(value=>({value,words:[word],options:word.alternatives||[{value,words:[word]}]}));
  if(wrap&&next.length&&/^\p{L}+$/u.test(next[0].value)&&tokens.length){const tail=tokens.at(-1);tail.value+=next.shift().value;tail.words.push(word);tail.options=[{value:tail.value,words:tail.words}];}
  tokens.push(...next);if(next.length||phraseTokens(word.text).length)wrap=/\p{L}-\s*$/u.test(word.text);
 }
 return tokens;
}

// Keep OCR passes separate: the same physical word can be read many times.
// Within each pass, whitespace and line baselines establish reading order.
export function orderedTextCandidates(words,combine=true){
 const passes=new Map();
 for(const word of words){if(!word.box||!phraseTokens(word.text).length)continue;const key=word.pass??`legacy:${word.rotation||0}`;if(!passes.has(key))passes.set(key,[]);passes.get(key).push(word);}
 const candidates=[];
 for(const [pass,items] of passes){
  let source=[],sourceLeft=Infinity;const saveSource=()=>{if(source.length)candidates.push({words:source,tokens:tokensForWords(source),pass,rotation:source[0].rotation||0});source=[];sourceLeft=Infinity;};
  for(const word of items){const previous=source.at(-1);if(previous){const a=rect(previous),b=rect(word),height=Math.max(a.h,b.h),dy=b.y+b.h/2-a.y-a.h/2,sameRow=Math.abs(dy)<height*.65&&b.x>=a.x-height*.3&&b.x-a.x-a.w<height*6,nextRow=dy>0&&b.y-a.y-a.h<height*2.5&&b.x<a.x+a.w+height*3&&b.x>=sourceLeft-height*3;if(!sameRow&&!nextRow)saveSource();}source.push(word);sourceLeft=Math.min(sourceLeft,rect(word).x);}saveSource();
  const lines=[];
  const knownLines=new Map();
  for(const word of [...items].sort((a,b)=>rect(a).y-rect(b).y||rect(a).x-rect(b).x)){
   const b=rect(word);let best=null,score=-1;
   if(word.line!=null)best=knownLines.get(word.line);
   else for(const line of lines.slice(-12)){const overlap=Math.min(b.y+b.h,line.y+line.h)-Math.max(b.y,line.y),ratio=overlap/Math.min(b.h,line.h);if(ratio>.45&&ratio>score&&Math.max(b.h,line.h)/Math.min(b.h,line.h)<3.5){best=line;score=ratio;}}
   if(best){best.words.push(word);const bottom=Math.max(best.y+best.h,b.y+b.h);best.y=Math.min(best.y,b.y);best.h=bottom-best.y;}
   else {const line={y:b.y,h:b.h,words:[word]};lines.push(line);if(word.line!=null)knownLines.set(word.line,line);}
  }
  const fragments=[];
  for(const line of lines){
   const sorted=line.words.sort((a,b)=>rect(a).x-rect(b).x),height=median(sorted.map(w=>rect(w).h));let part=[];
   const save=()=>{if(!part.length)return;const boxes=part.map(rect),x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));fragments.push({words:part,x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y,height});part=[];};
   for(const word of sorted){const previous=part.at(-1);if(previous&&rect(word).x-(rect(previous).x+rect(previous).w)>height*3.5)save();part.push(word);}save();
  }
  const chains=[];
  for(const line of fragments.sort((a,b)=>a.y-b.y||a.x-b.x)){
   let chain=null,score=Infinity;
   for(const candidate of chains){const previous=candidate.at(-1),gap=line.y-(previous.y+previous.h),height=Math.max(previous.height,line.height),overlap=Math.min(line.x+line.w,previous.x+previous.w)-Math.max(line.x,previous.x),aligned=overlap/Math.min(line.w,previous.w)>.25||Math.abs(line.x-previous.x)<height*1.4;
    if(gap<-.2*Math.min(line.height,previous.height)||gap>height*2.2||!aligned||Math.max(line.height,previous.height)/Math.min(line.height,previous.height)>3.5)continue;
    const distance=Math.max(0,gap)/height+Math.abs(line.x-previous.x)/(height*8);if(distance<score){score=distance;chain=candidate;}
   }
   if(chain)chain.push(line);else chains.push([line]);
  }
  for(const chain of chains){const ordered=chain.flatMap(line=>line.words);candidates.push({words:ordered,tokens:tokensForWords(ordered),pass,rotation:ordered[0].rotation||0,lineCount:chain.length});}
 }
 if(!combine)return candidates;
 const combined=consensusWords(words),conflicts=combined.filter(w=>w.numericConflict),all=[...orderedTextCandidates(combined,false),...candidates];
 for(const candidate of all)for(const token of candidate.tokens){if(!/^-?\d/.test(token.value)||token.words.some(w=>w.pass==='barcode'))continue;const conflict=conflicts.find(c=>token.words.some(w=>sameLocation(c.box,w.box)));if(conflict)token.uncertainValues=conflict.numericConflict;}
 return all;
}

export function pageReadingBox(box,rotation,aspect){
 const {x,y,w,h}=box;
 if(rotation===90)return {x:1-y-h,y:x*aspect,w:h,h:w*aspect};
 if(rotation===180)return {x:(1-x-w)*aspect,y:1-y-h,w:w*aspect,h};
 if(rotation===270)return {x:y,y:(1-x-w)*aspect,w:h,h:w*aspect};
 return {x:x*aspect,y,w:w*aspect,h};
}
// Combine alternate readings only at the same physical token position. Each
// alternative must have strong confidence or be corroborated by another pass.
function consensusWords(words){
 const clusters=[],buckets=new Map();
 for(const word of words){
  // Very weak readings still count when several passes repeat them identically.
  if(!word.box||(word.confidence??100)<20)continue;
  const rotation=word.rotation||0,aspect=word.pageAspect||1,text=normalize(word.text),pieces=[...text.matchAll(/-?\d+(?:[,.]\d+)?|[\p{L}]+|[%°]/gu)];
  for(const piece of pieces){const start=piece.index/text.length,end=(piece.index+piece[0].length)/text.length,b=word.box,span=end-start;
   const box=rotation===90?{x:b.x,y:b.y+b.h*(1-end),w:b.w,h:b.h*span}:rotation===270?{x:b.x,y:b.y+b.h*start,w:b.w,h:b.h*span}:rotation===180?{x:b.x+b.w*(1-end),y:b.y,w:b.w*span,h:b.h}:{x:b.x+b.w*start,y:b.y,w:b.w*span,h:b.h};
   const value=phraseTokens(piece[0])[0],token={...word,text:piece[0]+(piece===pieces.at(-1)&&/\p{L}-\s*$/u.test(word.text)?'-':''),box,readingBox:pageReadingBox(box,rotation,aspect),line:undefined};
   const cx=box.x+box.w/2,cy=box.y+box.h/2,bx=Math.floor(cx*100),by=Math.floor(cy*100);let cluster=null,overlap=0;
   for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const c of buckets.get(`${rotation}:${bx+dx}:${by+dy}`)||[]){const r=c.box,intersection=Math.max(0,Math.min(r.x+r.w,box.x+box.w)-Math.max(r.x,box.x))*Math.max(0,Math.min(r.y+r.h,box.y+box.h)-Math.max(r.y,box.y)),fraction=intersection/Math.min(r.w*r.h,box.w*box.h);
    // Pieces of a word are placed by counting its characters, so the same piece
    // read in two passes may stand a little apart: the same value overlapping
    // at all is the same piece, not a second one.
    if((fraction>.6||fraction>.2&&c.readings.some(reading=>reading.value===value))&&fraction>overlap&&Math.max(r.w,box.w)/Math.min(r.w,box.w)<2.5&&Math.max(r.h,box.h)/Math.min(r.h,box.h)<2.5){cluster=c;overlap=fraction;}
   }
   if(!cluster){cluster={box,rotation,readings:[]};clusters.push(cluster);const key=`${rotation}:${bx}:${by}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(cluster);}
   cluster.readings.push({value,word:token});
  }
 }
 const result=[];
 for(const cluster of clusters){const values=new Map();for(const reading of cluster.readings){if(!values.has(reading.value))values.set(reading.value,[]);values.get(reading.value).push(reading.word);}
  const options=[];for(const [value,readings] of values){const best=[...readings].sort((a,b)=>(b.confidence??100)-(a.confidence??100))[0],passes=new Set(readings.map(w=>w.pass));
   if((best.confidence??100)>=75||passes.size>=2)options.push({value,words:[best],support:passes.size});
  }
  if(!options.length)continue;options.sort((a,b)=>(b.words[0].confidence??100)+Math.min(3,b.support)*4-((a.words[0].confidence??100)+Math.min(3,a.support)*4));const best=options[0].words[0];
  const credibleNumbers=options.filter(o=>/^-?\d/.test(o.value)&&(o.words[0].confidence??100)>=85).map(o=>o.value);
  result.push({...best,pass:`consensus:${cluster.rotation}`,alternatives:options,numericConflict:credibleNumbers.length>1?credibleNumbers:null});
 }
 return result;
}
const tokenOption=(token,value)=>!token.uncertainValues&&token.options?.find(option=>option.value===value&&(!/^-?\d/.test(value)||option.support>=2||option.words.every(w=>(w.confidence??100)>=75)));

function exactIn(target,candidate,excluded=[]){
 for(let start=0;start<=candidate.tokens.length-target.length;start++){
  if(!target.every((token,i)=>tokenOption(candidate.tokens[start+i],token)))continue;
  const words=uniqueWords(candidate.tokens.slice(start,start+target.length).map((token,i)=>tokenOption(token,target[i])));
  if(words.some(w=>excluded.some(used=>sameLocation(used.box,w.box))))continue;
  const ops=target.map((token,i)=>({kind:'same',expected:token,actual:token,confidence:100,words:tokenOption(candidate.tokens[start+i],token).words}));
  return {words,ops,exact:true,distributed:false,coverage:100,method:candidate.pass.startsWith('consensus:')?'consensus':candidate.pass==='barcode'?'barcode':'layout',rotation:candidate.rotation,lineCount:candidate.lineCount,recognizedText:dehyphenate(words.map(w=>w.text).join(' ')),diff:[]};
 }
 return null;
}
function exactMatch(target,candidates,label,excluded=[]){
 let best=null,score=-Infinity;
 for(const candidate of candidates){const match=exactIn(target,candidate,excluded);if(!match)continue;const inside=label&&match.words.every(w=>w.box.x>=label.x-.003&&w.box.y>=label.y-.003&&w.box.x+w.box.w<=label.x+label.w+.003&&w.box.y+w.box.h<=label.y+label.h+.003),confidence=match.words.reduce((n,w)=>n+(w.confidence??80),0)/match.words.length;
  const value=confidence+(inside?200:0)+(match.method==='barcode'?1:match.method==='consensus'?0:.1);if(value>score){score=value;best=match;}
 }
 return best;
}

// Semi-global alignment searches a phrase inside a larger paragraph and keeps
// substitutions, omitted tokens and additional tokens visible to the operator.
const confusionGroups=['оo0','ий','дл','аa','еe','сc','рp'];
// "40" read as "0", "0,1" as "1": a digit lost at the edge of a large or
// faint number is an OCR slip far more often than a different print.
const truncated=(a,b)=>{const x=a.replace(/\D/g,''),y=b.replace(/\D/g,'');return /\d/.test(a)&&y.length>0&&y.length<x.length&&(x.endsWith(y)||x.startsWith(y));};
const lookalike=(a,b)=>a.length===b.length&&a!==b&&[...a].every((x,i)=>x===b[i]||confusionGroups.some(group=>group.includes(x)&&group.includes(b[i])));
// Which tokens of the requirement a difference covers: kept beside the
// difference, out of sight of reports and comparisons of its content.
const spanned=(change,span)=>Object.defineProperty(change,'span',{value:span,enumerable:false,writable:true});
// Narrow type loses word spaces in a reading ("СРОКГОДНОСТИ") and gains
// them inside words ("ИСПРАВ ЛЕННАЯ"). The letters are the same and in the
// same order, so such a reading is taken as the words it spells: a read word
// that is two or three required words run together is those words, and read
// pieces that together spell one required word are that word. Numbers are
// never joined or parted: their digits are their value.
function respaced(target,tokens){
 const letters=value=>/^\p{L}+$/u.test(value),known=new Set(target),joins=new Map();
 for(let i=0;i<target.length-1;i++)for(let n=2;n<=3&&i+n<=target.length;n++){const part=target.slice(i,i+n);if(part.every(letters)&&!known.has(part.join('')))joins.set(part.join(''),part);}
 const out=[];
 for(let j=0;j<tokens.length;j++){
  const token=tokens[j],values=(token.options||[token]).map(option=>option.value);
  if(token.uncertainValues||values.some(value=>known.has(value))){out.push(token);continue;}
  const run=values.map(value=>joins.get(value)).find(Boolean);
  if(run){for(const value of run)out.push({value,words:token.words,options:[{value,words:token.words,support:1}]});continue;}
  // Two or three pieces in a row that spell one required word.
  let joined=false;
  for(let n=3;n>=2&&!joined;n--){
   const pieces=tokens.slice(j,j+n);if(pieces.length<n||!pieces.every(piece=>!piece.uncertainValues&&letters(piece.value)&&!known.has(piece.value)))continue;
   const value=pieces.map(piece=>piece.value).join('');
   if(known.has(value)){const words=[...new Set(pieces.flatMap(piece=>piece.words))];out.push({value,words,options:[{value,words,support:1}]});j+=n-1;joined=true;}
  }
  if(!joined)out.push(token);
 }
 return out;
}
function align(target,candidate,pool=null){
 const actual=respaced(target,candidate.tokens),m=target.length,n=actual.length,stride=n+1,size=(m+1)*stride;
 // Costs in units of a quarter of one edit. A word of the requirement that is
 // not found costs a whole edit, as does a word read differently. Words that
 // stand on the print and not in the requirement cost one edit to begin and a
 // quarter for each further word: a clause inserted on the label is one
 // difference, and the phrase around it must still be found whole instead of
 // losing its beginning to save a few edits. Only words foreign to the
 // requirement are skipped that cheaply: a run that holds its own words, read
 // well or badly, is the phrase itself and not an insertion, or the reading
 // would leap to a repetition of the phrase further on. An unrelated word in
 // place of a required one counts as that word missing and another one
 // printed. A small reward for exact tokens breaks ties in favour of the
 // fuller reading.
 const unit=m+n+2,MISS=4*unit,OPEN=4*unit,MORE=unit,FAR=1<<29,kept=new Int32Array(size),loose=new Int32Array(size).fill(FAR);
 const own=new Set(target.map(fold)),stems=new Set(target.filter(token=>token.length>=4).map(token=>fold(token).slice(0,4))),numbered=target.some(token=>/\d/.test(token));
 const foreign=value=>{const folded=fold(value);return !own.has(folded)&&!(numbered&&/\d/.test(value))&&!(folded.length>=4&&stems.has(folded.slice(0,4)));};
 const further=actual.map(read=>(read.options||[read]).every(option=>foreign(option.value))?MORE:OPEN);
 const related=(token,read)=>(read.options||[read]).some(option=>/\d/.test(token)?/\d/.test(option.value):alike(token,option.value));
 const swap=(i,j)=>tokenOption(actual[j-1],target[i-1])?-1:related(target[i-1],actual[j-1])?MISS:MISS+OPEN;
 // kept: the last step consumed a token of the requirement; loose: it skipped a printed word.
 for(let i=1;i<=m;i++){kept[i*stride]=i*MISS;for(let j=1;j<=n;j++){const at=i*stride+j;
  kept[at]=Math.min(Math.min(kept[at-stride-1],loose[at-stride-1])+swap(i,j),Math.min(kept[at-stride],loose[at-stride])+MISS);
  loose[at]=Math.min(kept[at-1]+OPEN,loose[at-1]+further[j-1]);}}
 let end=0;for(let j=1;j<=n;j++)if(kept[m*stride+j]<kept[m*stride+end])end=j;
 let i=m,j=end,same=0,skipping=false;const operations=[],chosen=new Map();
 while(i>0){const at=i*stride+j;
  if(skipping){skipping=loose[at]!==kept[at-1]+OPEN;{const read=actual[j-1];operations.push({kind:'extra',expected:'',actual:read.value,words:read.words,uncertainValues:read.uncertainValues,confidence:Math.max(0,...read.words.map(w=>w.confidence??0))});j--;}}
  else if(j>0&&kept[at]===Math.min(kept[at-stride-1],loose[at-stride-1])+swap(i,j)){skipping=loose[at-stride-1]<kept[at-stride-1];{const option=tokenOption(actual[j-1],target[i-1]),equal=!!option,read=actual[j-1];if(option)chosen.set(j-1,option);operations.push({words:equal?option.words:read.words,kind:equal?'same':read.uncertainValues||lookalike(target[i-1],read.value)||truncated(target[i-1],read.value)?'uncertain':'replace',expected:target[i-1],actual:equal?target[i-1]:read.uncertainValues?.join(' / ')||read.value,confidence:equal?100:read.uncertainValues||lookalike(target[i-1],read.value)||truncated(target[i-1],read.value)?0:Math.max(0,...read.words.map(w=>w.confidence??0))});same+=Number(equal);i--;j--;}}
  else{skipping=loose[at-stride]<kept[at-stride];operations.push({kind:'missing',expected:target[i-1],actual:'',confidence:0});i--;}
 }
 operations.reverse();
 // The same word read twice at one place is one word, not a repetition on the print.
 for(let k=operations.length-1;k>=0;k--){
  const op=operations[k];if(op.kind!=='extra'||!op.words?.length)continue;
  const twin=[operations[k-1],operations[k+1]].find(other=>other?.kind==='same'&&other.expected===op.actual&&other.words.some(word=>op.words.some(own=>own!==word&&own.box&&word.box&&Math.max(0,Math.min(own.box.x+own.box.w,word.box.x+word.box.w)-Math.max(own.box.x,word.box.x))*Math.max(0,Math.min(own.box.y+own.box.h,word.box.y+word.box.h)-Math.max(own.box.y,word.box.y))>0)));
  if(twin)operations.splice(k,1);
 }
 // Reading order may thread a line of a neighbouring column, or a line
 // standing just above, through a phrase. Words inserted into a phrase stand
 // in its flow: on the line of the word before them and after it, on the line
 // of the word that follows and before it, or on lines between the two. Words
 // outside the area the phrase occupies, or out of that flow, are beside the
 // phrase and are no difference of it.
 const found=operations.filter(op=>op.kind==='same').flatMap(op=>op.words),aside=new Set();
 if(found.length){
  const area=bounds(found),letter=median(found.map(w=>Math.min(w.box.w,w.box.h)))*.5,within=w=>{const x=w.box.x+w.box.w/2,y=w.box.y+w.box.h/2;return x>=area.x-letter&&x<=area.x+area.w+letter&&y>=area.y-letter&&y<=area.y+area.h+letter;};
  // Position of a word in reading terms: `c` across the lines, `a` along them.
  const turn=found[0].rotation||0,span=w=>{const b=w.box;return turn===90?{c0:b.x,c1:b.x+b.w,a0:-(b.y+b.h),a1:-b.y}:turn===270?{c0:-(b.x+b.w),c1:-b.x,a0:b.y,a1:b.y+b.h}:turn===180?{c0:-(b.y+b.h),c1:-b.y,a0:-(b.x+b.w),a1:-b.x}:{c0:b.y,c1:b.y+b.h,a0:b.x,a1:b.x+b.w};};
  const sameLine=(p,q)=>Math.min(p.c1,q.c1)-Math.max(p.c0,q.c0)>=Math.min(p.c1-p.c0,q.c1-q.c0)*.4;
  const flowing=(word,before,after)=>{
   const w=span(word),p=before&&span(before),n=after&&span(after);
   if(p&&sameLine(w,p)&&w.a0>=p.a0)return !n||!sameLine(w,n)||w.a1<=n.a1;
   if(n&&sameLine(w,n)&&w.a1<=n.a1)return true;
   return !!p&&!!n&&w.c0>=p.c0&&w.c1<=n.c1&&!sameLine(p,n);
  };
  // A caption of a sign standing beside a column ("FOR", "GL" under a
  // recycling loop) is on the baseline of a line of the phrase and is read
  // with it. It is no insertion: it stands outside the column the phrase is
  // set in — beyond the end of its longest line, or before the start of its
  // lines — and apart from the line by more than a word space. A word really
  // added to a line follows at a word space, and stays a difference.
  const column={from:Math.min(...found.map(w=>span(w).a0)),to:Math.max(...found.map(w=>span(w).a1))};
  const captionBeside=(parts,before,after)=>{
   // A reading that gives a whole line as one word has no place of its own for a word inside it.
   // Only what was read with confidence: a weak stray reading is already no
   // more than an uncertain place and must not change which reading is chosen.
   if(!parts.length||parts.some(word=>found.includes(word)||(word.confidence??0)<75))return false;
   const spans=parts.map(span),first=Math.min(...spans.map(s=>s.a0)),last=Math.max(...spans.map(s=>s.a1)),p=before&&span(before),n=after&&span(after);
   // After the last word of a line, the phrase going on below.
   if(p&&spans.every(s=>sameLine(s,p))&&(!n||!sameLine(n,p))){const height=p.c1-p.c0;if(first>column.to+height*.5&&first-p.a1>height*1.2)return true;}
   // Before the first word of a line, the phrase having come from above.
   if(n&&spans.every(s=>sameLine(s,n))&&(!p||!sameLine(p,n))){const height=n.c1-n.c0;if(last<column.from-height*.5&&n.a0-last>height*1.2)return true;}
   return false;
  };
  for(let from=0;from<operations.length;from++){
   if(operations[from].kind!=='extra')continue;let to=from;while(operations[to+1]?.kind==='extra')to++;
   let b=from-1,a=to+1;while(b>=0&&operations[b].kind!=='same')b--;while(a<operations.length&&operations[a].kind!=='same')a++;
   const run=operations.slice(from,to+1),parts=uniqueWords(run),before=operations[b]?.words.at(-1),after=operations[a]?.words[0];
   // Words that follow the word before them at ordinary spacing, or lead up
   // to the word after them, belong to the line wherever it ends.
   const chained=(start,direction)=>{if(!start)return 0;let last=span(start),n=0;for(const word of [...parts].sort((p,q)=>direction*(span(p).a0-span(q).a0))){const w=span(word),gap=direction>0?w.a0-last.a1:last.a0-w.a1;if(!sameLine(w,last)||gap>(last.c1-last.c0)*3||gap<-(w.a1-w.a0))break;last=w;n++;}return n;};
   const inFlow=Math.max(chained(before,1),chained(after,-1),parts.filter(w=>within(w)&&flowing(w,before,after)).length);
   if(inFlow<parts.length*.5||captionBeside(parts,before,after)){parts.forEach(w=>aside.add(w));operations.splice(from,run.length);from--;}else from=to;
  }
 }
 // A required word unread and another word printed in its place are one
 // substitution, as a reader sees it.
 for(let from=0;from<operations.length;from++){
  if(!['missing','extra'].includes(operations[from].kind))continue;let to=from;while(['missing','extra'].includes(operations[to+1]?.kind))to++;
  const block=operations.slice(from,to+1),lost=block.filter(op=>op.kind==='missing'),added=block.filter(op=>op.kind==='extra'),pairs=Math.min(lost.length,added.length);
  if(pairs){
   const joined=[];let l=0,a=0;
   for(const op of block){
    if(op.kind==='missing'&&l++<pairs){const read=added[l-1],unsure=read.uncertainValues||lookalike(op.expected,read.actual)||truncated(op.expected,read.actual);joined.push({words:read.words,kind:unsure?'uncertain':'replace',expected:op.expected,actual:read.uncertainValues?.join(' / ')||read.actual,confidence:unsure?0:read.confidence});}
    else if(op.kind==='extra'&&a++<pairs)continue;
    else joined.push(op);
   }
   operations.splice(from,block.length,...joined);to=from+joined.length-1;
  }
  from=to;
 }
 for(const op of operations)delete op.uncertainValues;
 // One pass reading another word where a second pass reads the required one
 // with confidence is a disagreement of readings, not a difference of the print.
 if(pool)for(const op of operations){
  if(op.kind!=='replace'||!op.words?.length)continue;const place=bounds(op.words);
  if(pool.some(word=>word.box&&(word.confidence??0)>=75&&!op.words.includes(word)&&(word.rotation||0)===(op.words[0].rotation||0)&&sameLocation(word.box,place)&&phraseTokens(word.text).includes(op.expected))){op.kind='uncertain';op.confidence=0;}
 }
 const selected=uniqueWords(actual.slice(j,end).map((token,index)=>chosen.get(index+j)||token)).filter(word=>!aside.has(word));if(!selected.length)return null;
 // A word missing between two words that were both read is absent from the
 // print; a word missing at the edge of the reading may simply be unread.
 operations.forEach((op,index)=>{if(op.kind!=='missing')return;let before=index-1,after=index+1;while(operations[before]?.kind==='missing')before--;while(operations[after]?.kind==='missing')after++;if(operations[before]?.kind==='same'&&operations[after]?.kind==='same'){op.anchored=true;op.between=[operations[before].words.at(-1),operations[after].words[0]];}});
 // Every token of the requirement with what was read in its place, kept for
 // comparison with an independent reading of the same print.
 const ops=operations.map(op=>({...op}));
 for(const op of operations)if(op.kind!=='missing')delete op.words;
 const diff=[];operations.forEach((op,index)=>{if(op.kind==='same')return;const previous=diff.at(-1);if(previous?.kind===op.kind&&!!previous.anchored===!!op.anchored&&previous.span[1]===index-1){previous.expected=[previous.expected,op.expected].filter(Boolean).join(' ');previous.actual=[previous.actual,op.actual].filter(Boolean).join(' ');previous.confidence=Math.max(previous.confidence,op.confidence);previous.span[1]=index;}else diff.push(spanned({...op},[index,index]));});
 // "Е330" read as "ЕЗЗО": the same shapes in other characters. Such a pair is
 // an uncertain reading, never a difference of the artwork.
 const squeezed=text=>fold(String(text).replace(/\s+/g,''));
 for(let i=0;i<diff.length;i++){
  const item=diff[i],next=diff[i+1];
  if(item.kind==='replace'&&squeezed(item.expected)===squeezed(item.actual)){item.kind='uncertain';item.confidence=0;continue;}
  // The split may fall anywhere: "Е330" → "ЕЗЗ 0" or "Е ЗЗО".
  if(!next||![item,next].every(change=>['missing','replace','uncertain'].includes(change.kind))||![item,next].some(change=>change.actual))continue;
  if(squeezed(item.expected+next.expected)===squeezed(item.actual+next.actual))diff.splice(i,2,spanned({kind:'uncertain',expected:[item.expected,next.expected].join(' '),actual:[item.actual,next.actual].filter(Boolean).join(' '),confidence:0},[item.span[0],next.span[1]]));
 }
 let weighed=0;operations.forEach((op,index)=>{if(op.kind!=='same')weighed+=op.kind==='extra'&&operations[index-1]?.kind==='extra'&&foreign(op.actual)?.25:1;});
 const ordered=operations,cost=ordered.filter(op=>op.kind!=='same').length,leading=ordered.findIndex(op=>op.kind!=='missing'),trailing=[...ordered].reverse().findIndex(op=>op.kind!=='missing');
 if(same===m&&!diff.length)return {words:selected,ops,exact:true,distributed:false,coverage:100,method:'layout',rotation:candidate.rotation,lineCount:candidate.lineCount,recognizedText:dehyphenate(selected.map(w=>w.text).join(' ')),diff:[]};
 return {words:selected,ops,same,quality:1-weighed/m,exact:false,distributed:false,coverage:Math.round(same/m*100),similarity:1-cost/m,method:'layout',rotation:candidate.rotation,lineCount:candidate.lineCount,missingEdges:Math.max(0,leading,trailing),recognizedText:dehyphenate(selected.map(w=>w.text).join(' ')),diff};
}

export function fragmentsOf(expected){
 const raw=expected.split(/\n+|(?<=[.!?;])\s+(?=[А-ЯЁA-Z])/u).map(s=>s.trim()).filter(Boolean),parts=[];
 for(const piece of raw){if(phraseTokens(piece).length<3&&parts.length)parts[parts.length-1]+=' '+piece;else parts.push(piece);}
 return parts.length>1&&parts.every(p=>phraseTokens(p).length>=3)?parts:[];
}
const sameLocation=(a,b)=>{const overlap=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));return overlap/Math.min(a.w*a.h,b.w*b.h)>.65;};

// Is the print empty where words of the requirement are absent from a reading?
// Only then are they absent from the artwork. If any OCR pass read anything
// between the two neighbouring words, the missing words may stand there unread.
function blankBetween(words,[before,after]){
 if(!before?.box||!after?.box)return false;
 const turn=before.rotation||0,flat=turn%180===0,size=flat?before.box.h:before.box.w;
 const row=b=>flat?b.y+b.h/2:b.x+b.w/2,start=b=>turn===0?b.x:turn===180?-(b.x+b.w):turn===270?b.y:-(b.y+b.h),end=b=>turn===0?b.x+b.w:turn===180?-b.x:turn===270?b.y+b.h:-b.y;
 const sameRow=(a,b)=>Math.abs(row(a)-row(b))<size*.6,wrapped=!sameRow(before.box,after.box);
 return !words.some(word=>{
  const b=word.box;if(!b||word===before||word===after||(word.rotation||0)!==turn||(word.confidence??100)<30||!/[\p{L}\p{N}]/u.test(word.text||''))return false;
  if(Math.min(end(b),end(before.box))-Math.max(start(b),start(before.box))>(end(b)-start(b))*.5&&sameRow(b,before.box))return false; // another reading of the same word
  if(Math.min(end(b),end(after.box))-Math.max(start(b),start(after.box))>(end(b)-start(b))*.5&&sameRow(b,after.box))return false;
  const afterBefore=sameRow(b,before.box)&&start(b)>=end(before.box)-size*.3,beforeAfter=sameRow(b,after.box)&&end(b)<=start(after.box)+size*.3;
  return wrapped?afterBefore||beforeAfter:afterBefore&&beforeAfter;
 });
}
function settleGaps(match,words){
 const visit=item=>{if(item?.parts)item.parts.forEach(visit);for(const change of item?.diff||[]){if(change.between&&!blankBetween(words,change.between))delete change.anchored;delete change.between;}};
 visit(match);return match;
}
export function locatePhrase(expected,words,candidates=orderedTextCandidates(words),label=null,part=false){
 return settleGaps(findPhrase(expected,words,candidates,label,part),words);
}
function findPhrase(expected,words,candidates,label,part){
 const target=phraseTokens(expected);if(!target.length||expected.trim()==='-')return null;
 const exact=exactMatch(target,candidates,label);if(exact)return exact;
 const fragments=fragmentsOf(expected),matches=[];
 for(const fragment of fragments){const match=exactMatch(phraseTokens(fragment),candidates,label,matches.flatMap(m=>m.words));if(!match){matches.length=0;break;}matches.push(match);}
 if(matches.length)return {words:matches.flatMap(m=>m.words),ops:matches.flatMap(m=>m.ops),exact:true,distributed:true,coverage:100,method:'fragments',fragments:matches.length,recognizedText:matches.map(m=>m.recognizedText).join('\n'),diff:[]};
 if(!part&&fragments.length>1){
  const parts=fragments.map(fragment=>findPhrase(fragment,words,candidates,label,true));
  if(parts.every(m=>m&&!m.distributed&&m.coverage>=55)){
   const lengths=fragments.map(fragment=>phraseTokens(fragment).length),total=lengths.reduce((n,x)=>n+x,0);
   // Every sentence read whole, each at its own place: the text is found.
   if(parts.every(m=>m.exact)&&!parts.some((m,i)=>parts.slice(i+1).some(other=>m.words.some(w=>other.words.some(v=>sameLocation(v.box,w.box))))))return {words:parts.flatMap(m=>m.words),ops:parts.flatMap(m=>m.ops),exact:true,distributed:true,coverage:100,method:'fragments',fragments:parts.length,recognizedText:parts.map(m=>m.recognizedText).join('\n'),diff:[]};
   // Differences of each sentence keep their place in the joined token list.
   let offset=0;const ops=[],diff=[];
   for(const part of parts){if(!part.ops){offset=-1;break;}for(const change of part.diff||[])diff.push(change.span?spanned({...change},[change.span[0]+offset,change.span[1]+offset]):{...change});ops.push(...part.ops);offset+=part.ops.length;}
   return {words:[...new Set(parts.flatMap(m=>m.words))],...(offset<0?{}:{ops}),exact:false,distributed:true,coverage:Math.round(parts.reduce((n,m,i)=>n+m.coverage*lengths[i],0)/total),similarity:parts.reduce((n,m,i)=>n+(m.similarity??m.coverage/100)*lengths[i],0)/total,method:'sections',parts,recognizedText:parts.map(m=>m.recognizedText).join('\n'),diff:offset<0?parts.flatMap(m=>m.diff||[]):diff};
  }
 }
 const ranked=candidates.map(candidate=>{const values=new Set(candidate.tokens.flatMap(t=>t.options.map(o=>o.value)));return {candidate,overlap:target.filter(t=>values.has(t)).length};}).filter(c=>c.overlap>=Math.min(2,target.length)).sort((a,b)=>b.overlap-a.overlap).slice(0,10);
 let best=null;
 // The reading that found more words of the requirement is the better witness.
 // A re-read that stopped half-way down a line has fewer extra words than the
 // full line and would otherwise hide words that are printed there.
 for(const {candidate} of ranked){const match=align(target,candidate,words);if(match?.exact)return match;if(match&&match.quality>=.5&&(!best||match.same>best.same||match.same===best.same&&match.quality>best.quality))best=match;}
 if(best)return best;
 const selected=[],used=new Set();let found=0;
 for(const token of target){const index=words.findIndex((word,i)=>!used.has(i)&&phraseTokens(word.text).includes(token));if(index>=0){used.add(index);selected.push(words[index]);found++;}}
 return found?{words:[...new Set(selected)],exact:false,distributed:true,coverage:Math.round(found/target.length*100),method:'words',recognizedText:'',diff:[]}:null;
}

export function refinementAreas(matches){
 const areas=[];
 for(let match of Object.values(matches)){
  if(match?.parts){areas.push(...refinementAreas(Object.fromEntries(match.parts.map((part,i)=>[i,part]))));continue;}
  if(!match||match.exact||match.distributed&&match.method!=='words'||match.coverage<45||match.words.length<2)continue;
  if(match.method==='words'){
   const rotation=match.words[0].rotation||0,b=bounds(match.words),vertical=rotation%180;
   if(match.words.some(word=>(word.rotation||0)!==rotation)||(vertical?b.w>median(match.words.map(word=>word.box.w))*2:b.h>median(match.words.map(word=>word.box.h))*2))continue;
   match={...match,rotation,lineCount:rotation%180?undefined:1};
  }
  let b=bounds(match.words);const height=median(match.words.map(w=>w.box.h)),width=median(match.words.map(w=>w.box.w));let padX=Math.max(.002,median(match.words.map(w=>w.box.w/Math.max(1,w.text.length)))*3),padY=Math.max(.002,height*.7);
  if(match.method==='words'&&match.rotation%180){const stripeWidth=Math.min(...match.words.map(word=>word.box.w));b={...b,x:median(match.words.map(word=>word.box.x+word.box.w))-stripeWidth,w:stripeWidth};padX=.002;padY=Math.max(.002,median(match.words.map(word=>word.box.h/Math.max(1,word.text.length)))*2);}
  if(match.missingEdges){if(match.rotation%180)padY+=Math.min(.08,match.missingEdges*height);else if(b.h<height*1.8)padX+=Math.min(.08,match.missingEdges*width);else padY+=Math.min(.08,Math.ceil(match.missingEdges/Math.max(2,match.words.length*height/b.h))*height*1.6);}
  const x=Math.max(0,b.x-padX),y=Math.max(0,b.y-padY),area={x,y,w:Math.min(1,b.x+b.w+padX)-x,h:Math.min(1,b.y+b.h+padY)-y,rotation:match.rotation||0};
  if(areas.some(a=>sameLocation(a,area)&&a.rotation===area.rotation&&Math.min(a.w*a.h,area.w*area.h)/Math.max(a.w*a.h,area.w*area.h)>.65))continue;
  areas.push({...area,lineCount:match.lineCount,priority:match.method==='words'?2:match.rotation%180?1:0});
 }
 return areas.sort((a,b)=>(b.priority||0)-(a.priority||0)).slice(0,8).map(({priority,...area})=>area);
}

// OCR coordinates supply baselines when a neighbouring vertical inscription
// prevents an ink projection from finding whitespace between paragraph rows.
export function refinementLines(matches){
 const areas=[];
 const visit=match=>{
  if(match?.parts){match.parts.forEach(visit);return;}
  if(!match||match.exact||match.coverage<45||match.words.length<2)return;
  const rotation=match.rotation??match.words[0].rotation??0,items=match.words.filter(w=>(w.rotation||0)===rotation&&(w.confidence??0)>=35),height=median(items.map(w=>rotation%180?w.box.w:w.box.h));
  const lines=[];
  for(const word of items){const b=word.box,h=rotation%180?b.w:b.h,center=rotation%180?b.x+b.w/2:b.y+b.h/2;
   if(h>height*2||h<height*.45)continue;
   let line=lines.find(l=>Math.abs(l.center-center)<height*.6);
   if(!line){line={center,words:[]};lines.push(line);}line.words.push(word);
  }
  for(const line of lines){if(line.words.length<2)continue;const b=bounds(line.words),char=median(line.words.map(w=>(rotation%180?w.box.h:w.box.w)/Math.max(1,w.text.length))),px=rotation%180?height*.22:char*1.2,py=rotation%180?char*1.2:height*.22,x=Math.max(0,b.x-px),y=Math.max(0,b.y-py);
   const area={x,y,w:Math.min(1,b.x+b.w+px)-x,h:Math.min(1,b.y+b.h+py)-y,rotation,lineCount:1};
   if(!areas.some(a=>a.rotation===rotation&&sameLocation(a,area)))areas.push(area);
  }
 };
 Object.values(matches).forEach(visit);return areas.slice(0,120);
}

// ---- words missing at the edge of a reading -----------------------------------
// Words of the requirement that come before the first read word or after the
// last one may be absent from the print or merely unread. Where they would
// stand is known: further along the line of the nearest read word, or on the
// line before or after it. `edgePlaces` names those places so that exactly
// they can be looked at again, larger.
const frame=(box,turn,page)=>{const x0=box.x*page.width,x1=(box.x+box.w)*page.width,y0=box.y*page.height,y1=(box.y+box.h)*page.height;return turn===90?{a0:-y1,a1:-y0,c0:x0,c1:x1}:turn===270?{a0:y0,a1:y1,c0:-x1,c1:-x0}:turn===180?{a0:-x1,a1:-x0,c0:-y1,c1:-y0}:{a0:x0,a1:x1,c0:y0,c1:y1};};
const unframe=(r,turn,page)=>{const [x0,x1,y0,y1]=turn===90?[r.c0,r.c1,-r.a1,-r.a0]:turn===270?[-r.c1,-r.c0,r.a0,r.a1]:turn===180?[-r.a1,-r.a0,-r.c1,-r.c0]:[r.a0,r.a1,r.c0,r.c1];const x=Math.max(0,x0),y=Math.max(0,y0);return {x:x/page.width,y:y/page.height,w:(Math.min(page.width,x1)-x)/page.width,h:(Math.min(page.height,y1)-y)/page.height};};
// `page`: the page size in pixels. Each place: the missing words, the side of
// the phrase they belong to, the quarter-turn of the text, the letter height
// in page pixels and two areas in page fractions: the rest of the line, and
// the neighbouring line.
export function edgePlaces(match,page){
 const places=[];
 const visit=item=>{
  if(item?.parts){item.parts.forEach(visit);return;}
  const ops=item?.ops;if(!ops||item.exact)return;
  const first=ops.findIndex(op=>op.kind==='same'),last=ops.findLastIndex(op=>op.kind==='same');if(first<0)return;
  const read=ops.filter(op=>op.kind==='same').flatMap(op=>op.words).filter(word=>word.box),turn=ops[first].words[0].rotation||0,spans=read.map(word=>frame(word.box,turn,page));
  for(const side of ['leading','trailing']){
   const beyond=side==='leading'?ops.slice(0,first):ops.slice(last+1);
   // Something read there, however badly, is a reading to compare, not a gap.
   if(!beyond.length||beyond.some(op=>op.kind!=='missing'))continue;
   // The letter height of the phrase, not of the one box beside the gap: boxes of single words vary.
   const word=side==='leading'?ops[first].words[0]:ops[last].words.at(-1),box=frame(word.box,turn,page),s=median(spans.map(r=>r.c1-r.c0)),middle=(box.c0+box.c1)/2,anchor={a0:box.a0,a1:box.a1,c0:middle-s/2,c1:middle+s/2},char=(anchor.a1-anchor.a0)/Math.max(1,String(word.text).trim().length);
   const length=Math.max(s*4,beyond.reduce((n,op)=>n+op.expected.length+1,0)*char*1.6),start=Math.min(...spans.map(r=>r.a0)),end=Math.max(...spans.map(r=>r.a1));
   const areas=side==='trailing'?[{a0:anchor.a1+s*.2,a1:anchor.a1+s*.2+length,c0:anchor.c0-s*.15,c1:anchor.c1+s*.15},{a0:start,a1:start+length,c0:anchor.c1+s*.1,c1:anchor.c1+s*2.6}]
    :[{a0:anchor.a0-s*.2-length,a1:anchor.a0-s*.2,c0:anchor.c0-s*.15,c1:anchor.c1+s*.15},{a0:end-length,a1:end,c0:anchor.c0-s*2.6,c1:anchor.c0-s*.1}];
   places.push({side,expected:beyond.map(op=>op.expected),beside:String(word.text).trim(),rotation:turn,letter:s,areas:areas.map(r=>unframe(r,turn,page)).filter(box=>box.w>0&&box.h>0)});
  }
 };
 visit(match);return places;
}
// What the second look found: `probes` are {box,rotation,blank,text,confidence}
// for areas that were examined. Words missing at an edge are absent from the
// print when every place they could stand in is empty or confidently holds
// other words, and the words are not printed anywhere else on the label. Then
// the difference is marked `anchored`, with `edge` telling what was seen.
// Otherwise nothing is asserted: the words stay "absent or unread".
export function settleEdges(match,probes,page,words=[]){
 if(!match||match.exact||!probes?.length)return match;
 const shared=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
 const own=new Set(match.words||[]);
 for(const place of edgePlaces(match,page)){
  if(!place.areas.length)continue;
  const reread=[],wanted=place.expected.join(' '),note=item=>{if(item?.parts)item.parts.forEach(note);for(const change of item?.diff||[])if(change.kind==='missing'&&!change.anchored&&change.expected===wanted)change.edge={side:place.side,beside:place.beside,reread};};
  const seen=place.areas.map(area=>{
   const probe=probes.find(item=>item.rotation===place.rotation&&shared(item.box,area)>=area.w*area.h*.6);if(!probe)return null;
   if(probe.blank)return {blank:true};
   const tokens=phraseTokens(probe.text||'');
   // The words themselves read there: nothing is absent. Where the reading did
   // not join the phrase, it is still told what the second look read.
   if(place.expected.some(token=>tokens.includes(token))){reread.push(String(probe.text).replace(/\s+/g,' ').trim());return null;}
   return probe.confidence>=80&&tokens.some(token=>token.length>=3)?{text:String(probe.text).replace(/\s+/g,' ').trim()}:null;
  });
  if(seen.some(item=>!item)){if(reread.length)note(match);continue;}
  const telling=place.expected.filter(token=>token.length>=4);
  if(telling.length&&telling.every(token=>words.some(word=>!own.has(word)&&(word.confidence??0)>=75&&phraseTokens(word.text).includes(token))))continue;
  const edge={side:place.side,beside:place.beside,blank:seen.every(item=>item.blank),seen:seen.filter(item=>item.text).map(item=>item.text)};
  const mark=item=>{if(item?.parts)item.parts.forEach(mark);for(const change of item?.diff||[])if(change.kind==='missing'&&!change.anchored&&change.expected===wanted){change.anchored=true;change.edge=edge;}};
  mark(match);
 }
 return match;
}

// A phrase is looked for inside everything printed on the label, so what is
// printed around it is not compared: "не" set right before a required phrase
// would go unnoticed. After all phrases are found, the word standing right
// before the first word of each and right after its last word is looked at —
// on the same line at a word space, or, where the phrase begins or ends a line
// of its own column, at the end of the line above or the start of the line
// below. If that word belongs to no requirement, continues the same sentence
// and was read with confidence, the phrase is no longer taken as found whole:
// the word is shown beside it for a person to judge. Nothing is asserted about
// the print — the section becomes uncertain, not different.
// `signs`: captions of signs the requirements name ("ЕАС", "GL") — graphics the
// comparison of texts leaves to a person; such a caption beside a phrase is
// accounted for.
export function settleNeighbours(matches,words,page,signs=[]){
 const named=new Set(signs.map(fold));
 const frame=(word,turn)=>{const b={x:word.box.x*page.width,y:word.box.y*page.height,w:word.box.w*page.width,h:word.box.h*page.height};return turn===90?{c0:b.x,c1:b.x+b.w,a0:-(b.y+b.h),a1:-b.y}:turn===270?{c0:-(b.x+b.w),c1:-b.x,a0:b.y,a1:b.y+b.h}:turn===180?{c0:-(b.y+b.h),c1:-b.y,a0:-(b.x+b.w),a1:-b.x}:{c0:b.y,c1:b.y+b.h,a0:b.x,a1:b.x+b.w};};
 const sameLine=(p,q)=>Math.min(p.c1,q.c1)-Math.max(p.c0,q.c0)>=Math.min(p.c1-p.c0,q.c1-q.c0)*.4;
 const shared=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
 const worded=word=>phraseTokens(word.text).some(token=>token.length>=2||/\d/.test(token));
 const readable=words.filter(word=>word.box&&word.pass!=='barcode'&&word.text?.trim());
 const taken=Object.values(matches).flatMap(match=>[...(match?.words||[]),...(match?.ops||[]).flatMap(op=>op.words||[])]).filter(word=>word?.box);
 const closes=/[.;:!?]["»”)]*$/u;
 for(const match of Object.values(matches)){
  if(!match?.exact||!match.ops?.length||['quantity','barcode','manual'].includes(match.method))continue;
  const same=match.ops.filter(op=>op.kind==='same'&&op.words?.length&&op.words.every(word=>word.box));if(!same.length)continue;
  const first=same[0].words[0],last=same.at(-1).words.at(-1),turn=first.rotation||0,own=same.flatMap(op=>op.words),spans=own.map(word=>frame(word,turn));
  const column={from:Math.min(...spans.map(s=>s.a0)),to:Math.max(...spans.map(s=>s.a1))},lines=spans.some(s=>!sameLine(s,spans[0]));
  for(const [side,anchor] of [['before',first],['after',last]]){
   const A=frame(anchor,turn),h=A.c1-A.c0;
   const pool=readable.filter(word=>(word.rotation||0)===turn&&(word.confidence??0)>=75&&worded(word)&&!own.includes(word)).map(word=>({word,f:frame(word,turn)})).filter(({f})=>f.c1-f.c0>h*.5&&f.c1-f.c0<h*1.6);
   const along=pool.filter(({f})=>sameLine(f,A)&&(side==='before'?f.a1<=A.a0+h*.3:f.a0>=A.a1-h*.3));
   // Where the phrase runs over several lines, its column is known: a word on
   // the same line but outside the column (a neighbouring column of text, a
   // sign) is no neighbour of the phrase.
   const outside=lines&&(side==='before'?A.a0<=column.from+h:A.a1>=column.to-h);
   // At a word space on the same line.
   let near=outside?null:along.filter(({f})=>(side==='before'?A.a0-f.a1:f.a0-A.a1)<h).sort((p,q)=>side==='before'?q.f.a1-p.f.a1:p.f.a0-q.f.a0)[0];
   // Nothing else on that side of the line within the column, and the phrase runs over several lines: the neighbouring line of the column.
   if(!near&&lines&&(outside||!along.length)&&(side==='before'?A.a0<=column.from+h:true)){
    const beside=pool.filter(({f})=>(side==='before'?f.c1<=A.c0+h*.3&&A.c0-f.c1<h*1.2:f.c0>=A.c1-h*.3&&f.c0-A.c1<h*1.2)&&f.a0>=column.from-h&&f.a1<=column.to+h);
    near=beside.sort((p,q)=>side==='before'?q.f.a1-p.f.a1:p.f.a0-q.f.a0)[0];
    if(near&&side==='after'&&near.f.a0>column.from+h)near=null; // the line below must begin at the start of the column
   }
   if(!near)continue;
   const box=near.word.box,area=box.w*box.h;
   // Accounted for: part of this or another requirement, or another reading of the phrase's own words.
   if(taken.some(word=>shared(word.box,box)>Math.min(area,word.box.w*word.box.h)*.3))continue;
   if(phraseTokens(near.word.text).every(token=>named.has(fold(token))))continue;
   // Another sentence: a full stop, colon or semicolon read between the two.
   const edge=side==='before'?box:anchor.box;
   if(readable.some(word=>(word.rotation||0)===turn&&closes.test(word.text.trim())&&shared(word.box,edge)>Math.min(edge.w*edge.h,word.box.w*word.box.h)*.5&&frame(word,turn).a1<=frame({box:edge},turn).a1+h*.5))continue;
   // Read surely: by one pass with high confidence, or the same by two.
   const tokens=phraseTokens(near.word.text).map(fold).join(' ');
   if(!((near.word.confidence??0)>=90||readable.some(word=>word.pass!==near.word.pass&&(word.rotation||0)===turn&&shared(word.box,box)>Math.min(area,word.box.w*word.box.h)*.5&&phraseTokens(word.text).map(fold).join(' ')===tokens)))continue;
   match.exact=false;match.beside=[...(match.beside||[]),{side,text:near.word.text.trim(),box}];
   match.diff=[...(match.diff||[]),{kind:'uncertain',expected:'',actual:`${side==='before'?'перед фразой':'после фразы'} напечатано: ${near.word.text.trim()}`,confidence:0,beside:side}];
  }
 }
 return matches;
}
