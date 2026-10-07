import {normalize,dehyphenate} from './engine.js';

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

function pageReadingBox(box,rotation,aspect){
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
  if(!word.box||(word.confidence??100)<30)continue;
  const rotation=word.rotation||0,aspect=word.pageAspect||1,text=normalize(word.text),pieces=[...text.matchAll(/-?\d+(?:[,.]\d+)?|[\p{L}]+|[%°]/gu)];
  for(const piece of pieces){const start=piece.index/text.length,end=(piece.index+piece[0].length)/text.length,b=word.box,span=end-start;
   const box=rotation===90?{x:b.x,y:b.y+b.h*(1-end),w:b.w,h:b.h*span}:rotation===270?{x:b.x,y:b.y+b.h*start,w:b.w,h:b.h*span}:rotation===180?{x:b.x+b.w*(1-end),y:b.y,w:b.w*span,h:b.h}:{x:b.x+b.w*start,y:b.y,w:b.w*span,h:b.h};
   const value=phraseTokens(piece[0])[0],token={...word,text:piece[0]+(piece===pieces.at(-1)&&/\p{L}-\s*$/u.test(word.text)?'-':''),box,readingBox:pageReadingBox(box,rotation,aspect),line:undefined};
   const cx=box.x+box.w/2,cy=box.y+box.h/2,bx=Math.floor(cx*100),by=Math.floor(cy*100);let cluster=null,overlap=0;
   for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const c of buckets.get(`${rotation}:${bx+dx}:${by+dy}`)||[]){const r=c.box,intersection=Math.max(0,Math.min(r.x+r.w,box.x+box.w)-Math.max(r.x,box.x))*Math.max(0,Math.min(r.y+r.h,box.y+box.h)-Math.max(r.y,box.y)),fraction=intersection/Math.min(r.w*r.h,box.w*box.h);
    if(fraction>.6&&fraction>overlap&&Math.max(r.w,box.w)/Math.min(r.w,box.w)<2.5&&Math.max(r.h,box.h)/Math.min(r.h,box.h)<2.5){cluster=c;overlap=fraction;}
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
const tokenOption=(token,value)=>!token.uncertainValues&&token.options?.find(option=>option.value===value);

function exactIn(target,candidate,excluded=[]){
 for(let start=0;start<=candidate.tokens.length-target.length;start++){
  if(!target.every((token,i)=>tokenOption(candidate.tokens[start+i],token)))continue;
  const words=uniqueWords(candidate.tokens.slice(start,start+target.length).map((token,i)=>tokenOption(token,target[i])));
  if(words.some(w=>excluded.some(used=>sameLocation(used.box,w.box))))continue;
  return {words,exact:true,distributed:false,coverage:100,method:candidate.pass.startsWith('consensus:')?'consensus':candidate.pass==='barcode'?'barcode':'layout',rotation:candidate.rotation,lineCount:candidate.lineCount,recognizedText:dehyphenate(words.map(w=>w.text).join(' ')),diff:[]};
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
function align(target,candidate){
 const actual=candidate.tokens,m=target.length,n=actual.length,stride=n+1,step=m+1,grid=new Int32Array((m+1)*stride);
 // A secondary reward for exact tokens breaks edit-distance ties in favour of
 // the complete phrase with an extra token over a truncated substituted phrase.
 for(let i=1;i<=m;i++){grid[i*stride]=i*step;for(let j=1;j<=n;j++)grid[i*stride+j]=Math.min(grid[(i-1)*stride+j-1]+(tokenOption(actual[j-1],target[i-1])?-1:step),grid[(i-1)*stride+j]+step,grid[i*stride+j-1]+step);}
 let end=0;for(let j=1;j<=n;j++)if(grid[m*stride+j]<grid[m*stride+end])end=j;
 let i=m,j=end,same=0;const operations=[],chosen=new Map();
 while(i>0){const value=grid[i*stride+j];if(j>0&&value===grid[(i-1)*stride+j-1]+(tokenOption(actual[j-1],target[i-1])?-1:step)){const option=tokenOption(actual[j-1],target[i-1]),equal=!!option;if(option)chosen.set(j-1,option);operations.push({kind:equal?'same':actual[j-1].uncertainValues?'uncertain':'replace',expected:target[i-1],actual:equal?target[i-1]:actual[j-1].uncertainValues?.join(' / ')||actual[j-1].value});same+=Number(equal);i--;j--;}
  else if(value===grid[(i-1)*stride+j]+step){operations.push({kind:'missing',expected:target[i-1],actual:''});i--;}
  else{operations.push({kind:'extra',expected:'',actual:actual[j-1].value});j--;}
 }
 const selected=uniqueWords(actual.slice(j,end).map((token,index)=>chosen.get(index+j)||token));if(!selected.length)return null;
 const diff=[];for(const op of operations.reverse()){if(op.kind==='same')continue;const previous=diff.at(-1);if(previous?.kind===op.kind){previous.expected=[previous.expected,op.expected].filter(Boolean).join(' ');previous.actual=[previous.actual,op.actual].filter(Boolean).join(' ');}else diff.push({...op});}
 const ordered=operations,cost=ordered.filter(op=>op.kind!=='same').length,leading=ordered.findIndex(op=>op.kind!=='missing'),trailing=[...ordered].reverse().findIndex(op=>op.kind!=='missing');
 return {words:selected,exact:false,distributed:false,coverage:Math.round(same/m*100),similarity:1-cost/m,method:'layout',rotation:candidate.rotation,lineCount:candidate.lineCount,missingEdges:Math.max(0,leading,trailing),recognizedText:dehyphenate(selected.map(w=>w.text).join(' ')),diff};
}

function fragmentsOf(expected){
 const raw=expected.split(/\n+|(?<=[.!?;])\s+(?=[А-ЯЁA-Z])/u).map(s=>s.trim()).filter(Boolean),parts=[];
 for(const piece of raw){if(phraseTokens(piece).length<3&&parts.length)parts[parts.length-1]+=' '+piece;else parts.push(piece);}
 return parts.length>1&&parts.every(p=>phraseTokens(p).length>=3)?parts:[];
}
const sameLocation=(a,b)=>{const overlap=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));return overlap/Math.min(a.w*a.h,b.w*b.h)>.65;};

export function locatePhrase(expected,words,candidates=orderedTextCandidates(words),label=null){
 const target=phraseTokens(expected);if(!target.length||expected.trim()==='-')return null;
 const exact=exactMatch(target,candidates,label);if(exact)return exact;
 const fragments=fragmentsOf(expected),matches=[];
 for(const fragment of fragments){const match=exactMatch(phraseTokens(fragment),candidates,label,matches.flatMap(m=>m.words));if(!match){matches.length=0;break;}matches.push(match);}
 if(matches.length)return {words:matches.flatMap(m=>m.words),exact:true,distributed:true,coverage:100,method:'fragments',fragments:matches.length,recognizedText:matches.map(m=>m.recognizedText).join('\n'),diff:[]};
 const ranked=candidates.map(candidate=>{const values=new Set(candidate.tokens.flatMap(t=>t.options.map(o=>o.value)));return {candidate,overlap:target.filter(t=>values.has(t)).length};}).filter(c=>c.overlap>=Math.min(2,target.length)).sort((a,b)=>b.overlap-a.overlap).slice(0,10);
 let best=null;
 for(const {candidate} of ranked){const match=align(target,candidate);if(match&&match.similarity>=.5&&(!best||match.similarity>best.similarity))best=match;}
 if(best)return best;
 const selected=[],used=new Set();let found=0;
 for(const token of target){const index=words.findIndex((word,i)=>!used.has(i)&&phraseTokens(word.text).includes(token));if(index>=0){used.add(index);selected.push(words[index]);found++;}}
 return found?{words:[...new Set(selected)],exact:false,distributed:true,coverage:Math.round(found/target.length*100),method:'words',recognizedText:'',diff:[]}:null;
}

export function refinementAreas(matches){
 const areas=[];
 for(const match of Object.values(matches)){
  if(!match||match.exact||match.distributed||match.coverage<45||match.words.length<2)continue;
  const b=bounds(match.words),height=median(match.words.map(w=>w.box.h)),width=median(match.words.map(w=>w.box.w));let padX=Math.max(.002,median(match.words.map(w=>w.box.w/Math.max(1,w.text.length)))*3),padY=Math.max(.002,height*.7);
  if(match.missingEdges){if(match.rotation%180)padY+=Math.min(.08,match.missingEdges*height);else if(b.h<height*1.8)padX+=Math.min(.08,match.missingEdges*width);else padY+=Math.min(.08,Math.ceil(match.missingEdges/Math.max(2,match.words.length*height/b.h))*height*1.6);}
  const x=Math.max(0,b.x-padX),y=Math.max(0,b.y-padY),area={x,y,w:Math.min(1,b.x+b.w+padX)-x,h:Math.min(1,b.y+b.h+padY)-y,rotation:match.rotation||0};
  if(areas.some(a=>sameLocation(a,area)&&a.rotation===area.rotation))continue;
  areas.push({...area,lineCount:match.lineCount});if(areas.length===8)break;
 }
 return areas;
}
