export function nativePlayer(panel,api,status,onClose,nav){
 const canvas=panel.querySelector('canvas'),ctx=canvas.getContext('2d');
 const mapping={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',KeyZ:'act',KeyX:'cancel',KeyC:'menu',Enter:'enter',Escape:'escape',ShiftLeft:'shift',ShiftRight:'shift',Space:'space'};
 let pid=0,run=0,serial=0,currentChapter=null,order=Promise.resolve();
 const held=new Map();
 function dispatch(){
   if(!pid)return;
   const message={pid,serial:++serial,keys:[...new Set(held.values())]};
   order=order.then(()=>api('keys',message)).catch(e=>{if(message.pid===pid)status(e.message)});
 }
 function clear(){if(held.size){held.clear();dispatch()}}
 function release(code){if(held.delete(code))dispatch()}
 function down(code,key){if(!held.has(code)){held.set(code,key);dispatch()}}
 function stop(){
   clear();nav.detach();pid=0;run++;panel.hidden=true;onClose();
 }
 function key(e){
   if(!pid||!mapping[e.code]||e.altKey||e.metaKey||e.ctrlKey)return;
   if(e.type==='keydown'&&document.activeElement!==canvas)return;
   e.preventDefault();if(e.type==='keydown')down(e.code,mapping[e.code]);else release(e.code);
 }
 window.addEventListener('keydown',key);window.addEventListener('keyup',key);
 window.addEventListener('blur',clear);canvas.addEventListener('blur',clear);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)clear()});
 window.addEventListener('pagehide',()=>{
   if(!pid)return;
   const body=new Blob([JSON.stringify({pid,serial:++serial,keys:[]})],{type:'application/json'});
   navigator.sendBeacon('/api/studio/chapters/'+currentChapter+'/keys',body);
 });
 panel.querySelectorAll('[data-native]').forEach(b=>{
   b.onpointerdown=e=>{e.preventDefault();canvas.focus();b.setPointerCapture(e.pointerId);down(e.pointerId,b.dataset.native)};
   b.onpointerup=b.onpointercancel=b.onlostpointercapture=e=>release(e.pointerId);
 });
 panel.querySelector('#endGame').onclick=async()=>{
    if(!pid||!confirm('结束本次试玩？已写入的游戏存档可以继续使用。'))return;
    clear();await order;
    try{await api('close',{pid});status('已请求关闭试玩。')}catch(e){status(e.message)}
 };
 return async function play(chapter,id){
   pid=id;currentChapter=chapter;serial=Date.now()*1000;held.clear();dispatch();const token=++run;panel.hidden=false;canvas.focus();nav.attach(chapter,pid,api,()=>canvas.focus());
   let failures=0;
   while(token===run){
     const start=performance.now();
     try{
       const result=await fetch('/api/studio/chapters/'+chapter+'/frame',{cache:'no-store'});
       if(!result.ok)throw Error((await result.json()).error);
       const bitmap=await createImageBitmap(await result.blob());
       if(token!==run){bitmap.close();return}
       if(canvas.width!==bitmap.width||canvas.height!==bitmap.height){canvas.width=bitmap.width;canvas.height=bitmap.height}
       ctx.drawImage(bitmap,0,0);bitmap.close();failures=0;
     }catch(e){
       if(++failures%5===0){
         try{
           const route=await api('route');
           if(!route.running){stop();status(route.nextChapter===5?'第 4 章已返回工作台。可选择第 5 章继续。':'本次试玩已结束。');return}
           status(e.message);
         }catch(err){status(err.message)}
       }
     }
     await new Promise(r=>setTimeout(r,Math.max(failures?180:1,33-(performance.now()-start))));
   }
 };
}
