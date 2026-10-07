const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const copy=r=>r?{x:r.x,y:r.y,w:r.w,h:r.h}:null;

export function openAreaEditor({image,mode,initial,label,onApply}){
  const dialog=document.createElement('dialog');
  dialog.className='area-dialog';
  const title={crop:'Границы этикетки',ocr:'Область текста',measure:'Измерение на макете'}[mode];
  const hint={crop:'Обведите только печатную этикетку. Перетащите рамку или её углы для точной настройки.',ocr:'Выделите текстовый блок. Узкие и повёрнутые надписи удобнее распознавать по частям.',measure:'Выделите видимую высоту буквы или весь блок предупреждения.'}[mode];
  dialog.innerHTML=`<div class="area-shell"><header class="area-header"><div><h2>${title}</h2><p>${hint}</p></div><button class="area-close" type="button" aria-label="Закрыть">×</button></header><div class="area-tools"><div class="area-segments"><button type="button" data-fit="page">Лист целиком</button><button type="button" data-fit="label" ${!label?'disabled':''}>Этикетка</button></div><div class="area-zoom"><button type="button" data-zoom="out" aria-label="Уменьшить">−</button><span class="zoom-label">100%</span><button type="button" data-zoom="in" aria-label="Увеличить">+</button></div><span class="area-tip">Колесо мыши — прокрутка · Ctrl + колесо — масштаб · стрелки — сдвиг рамки</span></div><div class="area-viewport" tabindex="0" aria-label="Макет для выбора области"><div class="area-stage"><div class="area-shade"></div><div class="area-rect" tabindex="0" role="img" aria-label="Выбранная область">${['nw','n','ne','e','se','s','sw','w'].map(h=>`<span class="area-handle ${h}" data-handle="${h}"></span>`).join('')}</div></div></div><footer class="area-footer"><span class="area-size" role="status">Выделите область на макете</span><div><button type="button" class="area-undo" disabled>Шаг назад</button><button type="button" class="area-cancel">Закрыть</button><button type="button" class="area-apply" disabled>Использовать область</button></div></footer></div>`;
  document.body.append(dialog);
  const viewport=dialog.querySelector('.area-viewport'),stage=dialog.querySelector('.area-stage'),rectEl=dialog.querySelector('.area-rect'),shade=dialog.querySelector('.area-shade');
  const img=image.cloneNode();img.className='area-image';img.alt='';img.draggable=false;stage.prepend(img);
  const target=mode==='crop'?label:mode==='ocr'?initial:(initial||null);
  let rect=target?{x:target.x*image.width,y:target.y*image.height,w:target.w*image.width,h:target.h*image.height}:null;
  let zoom=1,fitScale=1,drag=null,history=[],focusMode=mode==='crop'?'page':'label';
  const remember=()=>{history.push(copy(rect));if(history.length>30)history.shift();dialog.querySelector('.area-undo').disabled=false;};
  const update=()=>{
    const width=image.width*fitScale*zoom,height=image.height*fitScale*zoom;
    stage.style.width=img.style.width=width+'px';stage.style.height=img.style.height=height+'px';
    dialog.querySelector('.zoom-label').textContent=Math.round(zoom*100)+'%';
    const visible=!!rect&&rect.w>=3&&rect.h>=3;
    rectEl.hidden=!visible;shade.hidden=true;dialog.querySelector('.area-apply').disabled=!visible;
    if(visible){const f=fitScale*zoom;Object.assign(rectEl.style,{left:rect.x*f+'px',top:rect.y*f+'px',width:rect.w*f+'px',height:rect.h*f+'px'});shade.style.clipPath=`polygon(0 0,100% 0,100% 100%,0 100%,0 0,${rect.x*f}px ${rect.y*f}px,${rect.x*f}px ${(rect.y+rect.h)*f}px,${(rect.x+rect.w)*f}px ${(rect.y+rect.h)*f}px,${(rect.x+rect.w)*f}px ${rect.y*f}px,${rect.x*f}px ${rect.y*f}px)`;}
    dialog.querySelector('.area-size').textContent=visible?`Выделено: ${Math.round(rect.w)} × ${Math.round(rect.h)} пикселей`:'Потяните по изображению, чтобы выделить область';
  };
  const setZoom=(next,point)=>{const old=fitScale*zoom;const cx=point?.x??viewport.clientWidth/2,cy=point?.y??viewport.clientHeight/2;const sourceX=(viewport.scrollLeft+cx)/old,sourceY=(viewport.scrollTop+cy)/old;zoom=clamp(next,.5,8);update();const scale=fitScale*zoom;viewport.scrollLeft=sourceX*scale-cx;viewport.scrollTop=sourceY*scale-cy;};
  const focus=(kind)=>{if(kind==='label'&&!label)return;const target=kind==='label'?label:{x:0,y:0,w:1,h:1};const desired=Math.min((viewport.clientWidth-64)/(target.w*image.width),(viewport.clientHeight-64)/(target.h*image.height));zoom=clamp(desired/fitScale,.5,8);update();const scale=fitScale*zoom;viewport.scrollLeft=(target.x+target.w/2)*image.width*scale-viewport.clientWidth/2;viewport.scrollTop=(target.y+target.h/2)*image.height*scale-viewport.clientHeight/2;focusMode=kind;dialog.querySelectorAll('[data-fit]').forEach(b=>b.classList.toggle('active',b.dataset.fit===kind));};
  const at=e=>{const box=stage.getBoundingClientRect(),factor=fitScale*zoom;return{x:clamp((e.clientX-box.left)/factor,0,image.width),y:clamp((e.clientY-box.top)/factor,0,image.height)};};
  const normalize=r=>({x:clamp(r.x,0,image.width-3),y:clamp(r.y,0,image.height-3),w:clamp(r.w,3,image.width-r.x),h:clamp(r.h,3,image.height-r.y)});
  const cancel=()=>{dialog.close();dialog.remove();};
  stage.onpointerdown=e=>{
    if(e.button!==0)return;
    const p=at(e),handle=e.target.closest('[data-handle]')?.dataset.handle,move=e.target.closest('.area-rect')&&rect;
    remember();drag={kind:handle|| (move?'move':'new'),start:p,base:copy(rect)};
    if(drag.kind==='new')rect={x:p.x,y:p.y,w:3,h:3};
    stage.setPointerCapture(e.pointerId);e.preventDefault();update();
  };
  stage.onpointermove=e=>{
    if(!drag)return;const p=at(e),dx=p.x-drag.start.x,dy=p.y-drag.start.y,b=drag.base;
    if(drag.kind==='new'){rect={x:Math.min(p.x,drag.start.x),y:Math.min(p.y,drag.start.y),w:Math.max(3,Math.abs(dx)),h:Math.max(3,Math.abs(dy))};}
    else if(drag.kind==='move'){rect=normalize({...b,x:clamp(b.x+dx,0,image.width-b.w),y:clamp(b.y+dy,0,image.height-b.h)});}
    else{const left=drag.kind.includes('w')?clamp(b.x+dx,0,b.x+b.w-3):b.x,top=drag.kind.includes('n')?clamp(b.y+dy,0,b.y+b.h-3):b.y;
      const right=drag.kind.includes('e')?clamp(b.x+b.w+dx,left+3,image.width):b.x+b.w,bottom=drag.kind.includes('s')?clamp(b.y+b.h+dy,top+3,image.height):b.y+b.h;
      rect={x:left,y:top,w:right-left,h:bottom-top};}
    update();
  };
  stage.onpointerup=()=>{if(!drag)return;if(drag.kind==='new'&&rect.w<5&&rect.h<5)rect=history.pop()||null;drag=null;update();};
  stage.onpointercancel=()=>{if(drag){rect=history.pop()||null;drag=null;update();}};
  viewport.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();const r=viewport.getBoundingClientRect();setZoom(zoom*(e.deltaY<0?1.2:1/1.2),{x:e.clientX-r.left,y:e.clientY-r.top});},{passive:false});
  dialog.querySelector('[data-zoom="in"]').onclick=()=>setZoom(zoom*1.25);
  dialog.querySelector('[data-zoom="out"]').onclick=()=>setZoom(zoom/1.25);
  dialog.querySelectorAll('[data-fit]').forEach(b=>b.onclick=()=>focus(b.dataset.fit));
  dialog.querySelector('.area-undo').onclick=()=>{rect=history.pop()||null;dialog.querySelector('.area-undo').disabled=!history.length;update();};
  dialog.querySelector('.area-cancel').onclick=cancel;
  dialog.querySelector('.area-close').onclick=cancel;
  dialog.querySelector('.area-apply').onclick=()=>{const result={x:rect.x/image.width,y:rect.y/image.height,w:rect.w/image.width,h:rect.h/image.height};cancel();onApply(result);};
  rectEl.onkeydown=e=>{if(!rect||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();remember();const amount=e.shiftKey?10:1;rect=normalize({...rect,x:clamp(rect.x+(e.key==='ArrowRight'?amount:e.key==='ArrowLeft'?-amount:0),0,image.width-rect.w),y:clamp(rect.y+(e.key==='ArrowDown'?amount:e.key==='ArrowUp'?-amount:0),0,image.height-rect.h)});update();};
  dialog.addEventListener('cancel',e=>{e.preventDefault();cancel();});
  dialog.showModal();
  fitScale=Math.min((viewport.clientWidth-36)/image.width,(viewport.clientHeight-36)/image.height);
  focus(focusMode);
  return dialog;
}
