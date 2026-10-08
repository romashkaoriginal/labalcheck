function bounds(boxes){
 if(!boxes?.length)return null;
 const x=Math.min(...boxes.map(box=>box.x)),y=Math.min(...boxes.map(box=>box.y));
 return {x,y,w:Math.max(...boxes.map(box=>box.x+box.w))-x,h:Math.max(...boxes.map(box=>box.y+box.h))-y};
}

function overlap(a,b){
 const intersection=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
 return intersection/(a.w*a.h+b.w*b.h-intersection);
}

// The second engine can resolve a weak first reading only when it independently
// finds the complete phrase on the same printed area. Never blend guesses from
// separate locations or let OCR confidence override a strong contradiction.
export function fuseOcrMatches(primary,secondary){
 return Object.fromEntries(Object.entries(primary).map(([id,first])=>{
  const second=secondary?.[id];
  if(!first||first.exact||!second?.exact||first.scope!=='label'||second.scope!=='label'||first.quantity||first.date||first.method==='manual'||first.coverage<90)return [id,first];
  if(!first.diff?.length||first.diff.some(change=>change.confidence>=75))return [id,first];
  const a=bounds(first.boxes),b=bounds(second.boxes);
  if(!a||!b||overlap(a,b)<.5)return [id,first];
  return [id,{...first,exact:true,coverage:100,method:'independent-ocr',diff:[],
   recognizedText:second.recognizedText,
   ocrEvidence:{primary:first.recognizedText,secondary:second.recognizedText,firstDifferences:first.diff}}];
 }));
}
