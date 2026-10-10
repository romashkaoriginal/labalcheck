// The only bridge between the window and the rest of the app. The page gets
// no Node, no file system and no generic IPC: only these calls.
const {contextBridge,ipcRenderer}=require('electron');

const listeners=new Set();
ipcRenderer.on('ocr:progress',(_event,state)=>{for(const listener of listeners)listener(state);});

contextBridge.exposeInMainWorld('desktop',{
 // Pixels in, read lines out. Rejects with {code,message,stage,retryable}.
 recognize:async job=>{const reply=await ipcRenderer.invoke('ocr:recognize',job);if(reply.error)throw Object.assign(new Error(reply.error.message),reply.error);return reply;},
 // The same for lines the page has already cut out: {id, images:[{data,width,height}], options:{allow}}.
 lines:async job=>{const reply=await ipcRenderer.invoke('ocr:lines',job);if(reply.error)throw Object.assign(new Error(reply.error.message),reply.error);return reply;},
 cancel:id=>ipcRenderer.send('ocr:cancel',id),
 onProgress:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
 info:()=>ipcRenderer.invoke('app:info'),
 memory:()=>ipcRenderer.invoke('app:memory'),
 // Scripted comparison (electron . --bench): files of the corpus and a place for results.
 bench:{
  plan:()=>ipcRenderer.invoke('bench:plan'),
  file:name=>ipcRenderer.invoke('bench:file',name),
  phase:name=>ipcRenderer.invoke('bench:phase',name),
  save:(name,data)=>ipcRenderer.invoke('bench:save',name,data),
  done:summary=>ipcRenderer.send('bench:done',summary),
  shot:name=>ipcRenderer.invoke('bench:shot',name),
 },
});
