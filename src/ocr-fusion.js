function bounds(boxes){
 if(!boxes?.length)return null;
 const x=Math.min(...boxes.map(box=>box.x)),y=Math.min(...boxes.map(box=>box.y));
 return {x,y,w:Math.max(...boxes.map(box=>box.x+box.w))-x,h:Math.max(...boxes.map(box=>box.y+box.h))-y};
}
const shared=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
function overlap(a,b){
 const intersection=shared(a,b);
 return intersection/(a.w*a.h+b.w*b.h-intersection);
}
// Requirement tokens in order, and words read where the requirement has none.
function tokenMap(ops){
 const tokens=[],extras=new Map();
 for(const op of ops){if(op.kind==='extra'){const at=tokens.length-1;extras.set(at,[...(extras.get(at)||[]),op]);}else tokens.push(op);}
 return {tokens,extras};
}
// A different word or number that the first engine itself is sure of.
const strong=op=>op.kind==='replace'&&(op.confidence>=75||op.confidence>=50&&/\d/.test(op.expected)&&/\d/.test(op.actual));
const sure=op=>op?.kind==='same'&&op.words?.length>0&&op.words.every(word=>(word.confidence??0)>=80);

// The second engine can resolve a weak first reading only where it
// independently reads the required token on the same printed place. Guesses
// from separate locations are never blended, and OCR confidence never
// overrides a strong contradiction. The requirement text is not a reading:
// a token counts only when one of the engines read it from the pixels.
export function fuseOcrMatches(primary,secondary){
 return Object.fromEntries(Object.entries(primary).map(([id,first])=>[id,fuse(first,secondary?.[id])]));
}
function fuse(first,second){
 if(!first||first.exact||!second||first.scope!=='label'||second.scope!=='label'||first.quantity||first.date||first.method==='manual'||!first.diff?.length)return first;
 const a=bounds(first.boxes),b=bounds(second.boxes);
 if(!a||!b)return first;
 const evidence={primary:first.recognizedText,secondary:second.recognizedText,firstDifferences:first.diff};
 // The whole phrase read by the second engine where the first read it weakly.
 if(second.exact&&first.coverage>=90&&!first.diff.some(change=>change.confidence>=75)&&overlap(a,b)>=.5)
  return {...first,exact:true,coverage:100,method:'independent-ocr',diff:[],recognizedText:second.recognizedText,ocrEvidence:evidence};
 // Otherwise token by token: each engine errs in its own places.
 if(!first.ops?.length||!second.ops?.length||shared(a,b)<Math.min(a.w*a.h,b.w*b.h)*.5)return first;
 const mine=tokenMap(first.ops),other=tokenMap(second.ops);
 if(mine.tokens.length!==other.tokens.length)return first;
 const ops=first.ops,resolved=new Array(ops.length).fill(false),contradicted=new Set(),disputed=new Set(),settled=[];
 const letter=words=>{const sizes=words.map(word=>Math.min(word.box.w,word.box.h)).sort((x,y)=>x-y);return sizes[Math.floor(sizes.length/2)]||0;};
 // Where on the print the first engine has this token: between its nearest read neighbours.
 const place=index=>{
  let before=index-1,after=index+1;while(before>=0&&ops[before].kind!=='same')before--;while(after<ops.length&&ops[after].kind!=='same')after++;
  const words=[...(ops[before]?.words||[]),...(ops[after]?.words||[]),...(ops[index].kind!=='missing'?ops[index].words||[]:[])].filter(word=>word.box);
  if(!words.length)return null;const box=bounds(words.map(word=>word.box)),pad=letter(words)*1.5;
  return {x:box.x-pad,y:box.y-pad,w:box.w+pad*2,h:box.h+pad*2};
 };
 const there=(op,index)=>{const area=place(index);return !!area&&op.words.some(word=>word.box&&shared(word.box,area)>0);};
 // Whether a gap is still held to be empty print is known from the settled differences.
 const absent=new Set();for(const change of first.diff)if(change.anchored&&change.span)for(let i=change.span[0];i<=change.span[1];i++)absent.add(i);
 let token=-1;
 ops.forEach((op,index)=>{
  if(op.kind==='same'){token++;resolved[index]=true;return;}
  if(op.kind==='extra'){
   // A weak stray sign where the second engine reads both neighbours with nothing between them.
   const left=other.tokens[token],right=other.tokens[token+1];
   resolved[index]=op.confidence<75&&sure(left)&&sure(right)&&!other.extras.get(token)?.length&&there(left,index);
   return;
  }
  token++;const read=other.tokens[token];
  if(!sure(read)||!there(read,index))return;
  // "No such word on the print" and a reading of that word contradict each other: neither is asserted.
  if(absent.has(index)){contradicted.add(index);return;}
  // Two engines sure of different readings: the difference is not established either.
  if(strong(op)){disputed.add(index);return;}
  resolved[index]=true;settled.push({expected:op.expected,primary:op.actual||'',secondary:read.words.map(word=>word.text).join(' ')});
 });
 const range=span=>{const list=[];for(let i=span[0];i<=span[1];i++)list.push(i);return list;};
 let changed=false;
 const diff=first.diff.flatMap(change=>{
  if(!change.span)return [change];
  const covered=range(change.span);
  if(covered.every(index=>resolved[index])){changed=true;return [];}
  if(change.anchored&&covered.some(index=>contradicted.has(index))){changed=true;const {anchored,...rest}=change;return [rest];}
  if(change.kind==='replace'&&covered.some(index=>disputed.has(index))){changed=true;return [{...change,kind:'uncertain',confidence:0}];}
  return [change];
 });
 if(!changed)return first;
 if(!diff.length)return {...first,exact:true,coverage:100,method:'independent-ocr',diff:[],recognizedText:second.exact?second.recognizedText:first.recognizedText,ocrEvidence:{...evidence,settled}};
 return {...first,diff,ocrEvidence:{...evidence,settled,partial:true}};
}
