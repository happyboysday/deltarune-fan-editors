import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {args,data,openBrowserTest,Skip,workDir} from './test-env.mjs';
const [origin,work=workDir('verify-chapter-ending'),battle=data.battleRoot,chapter]=args;
if(!origin)throw new Skip('章节结尾验收需要显式指定隔离测试服务器');
if(!chapter)throw new Skip('章节结尾验收需要指定章节编号');
const room=chapter==='5'?'room_schooldoor':'room_town_krisyard_dark';
const {edge}=await openBrowserTest(origin,battle,{profileDir:path.resolve(work,'ending-edge-'+chapter),windowSize:'1280,920'});
const c=edge.cdp,sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ev(expression){const r=await c.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value}
async function until(expr,ms=60000){const end=Date.now()+ms;do{if(await ev(expr))return;await sleep(160)}while(Date.now()<end);throw Error(expr+' '+await ev("document.querySelector('#status').textContent"))}
const route=async()=>(await (await fetch(origin+'/api/studio/chapters/'+chapter+'/route')).json());
async function tap(){for(const type of ['keyDown','keyUp']){await c.send('Input.dispatchKeyEvent',{type,code:'KeyZ',key:'z',windowsVirtualKeyCode:90,nativeVirtualKeyCode:90});await sleep(type==='keyDown'?100:190)}}
let launched=false;
try{
 assert.equal((await route()).running,false,'使用独立验收工作台，已有试玩正在运行');
 await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Page.navigate',{url:origin+'/studio/chapters.html'});
 await until("document.querySelector('#rooms')?.options.length===252");
 if(chapter==='4'){await ev("document.querySelector('#chapter').value='4';document.querySelector('#chapter').dispatchEvent(new Event('change'))");await until("document.querySelector('#rooms').options.length===328")}
 await ev("document.querySelector('#rooms').value="+JSON.stringify(room)+";document.querySelector('#rooms').dispatchEvent(new Event('change'));document.querySelector('#preview').click()");
 await until("!document.getElementById('gamePanel').hidden");launched=true;
 let started=false,complete=false,record,base=0;
 for(let i=0;i<1100;i++){
   if(i%5===0){
     record=await route();assert.equal(record.preview,room);
     const rows=record.log.trim().split('\n');
     if(!started&&rows.at(-1)?.includes(room)){started=true;base=rows.length-1}
     if(started&&rows.slice(base).some(x=>x.includes('room_ed'))){complete=true;break}
     if(!record.running)throw Error('Native preview closed: '+JSON.stringify(record).slice(-500));
     if(i===55)await fs.writeFile(path.join(work,'ending-scene-'+chapter+'.png'),Buffer.from((await ev("document.getElementById('gameView').toDataURL()")).split(',')[1],'base64'));
   }
   await tap();
 }
 assert.ok(started&&complete,JSON.stringify(record).slice(-800));
 await sleep(2200);
 await fs.writeFile(path.join(work,'credits-'+chapter+'.png'),Buffer.from((await ev("document.getElementById('gameView').toDataURL()")).split(',')[1],'base64'));
 console.log(JSON.stringify({chapter,isolatedPreview:true,start:room,route:record.log.trim().split('\n').slice(base)}));
 }finally{
   if(launched){
     const base=origin+'/api/studio/chapters/'+chapter+'/';
     const run=await (await fetch(base+'route')).json();
     if(run.running&&run.pid)await fetch(base+'close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pid:run.pid})});
   }
   await edge.close();
 }

