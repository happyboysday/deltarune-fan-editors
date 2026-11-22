import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {args,data,openBrowserTest,Skip,workDir} from './test-env.mjs';
const [origin,work=workDir('check-native-window'),battle=data.battleRoot,chapter='5']=args;
if(!origin)throw new Skip('原生窗口验收需要显式指定隔离测试服务器');
const {edge}=await openBrowserTest(origin,battle,{profileDir:path.resolve(work,'native-edge-'+chapter),windowSize:'1280,900'});
const c=edge.cdp,sleep=ms=>new Promise(r=>setTimeout(r,ms)),errors=[];
c.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.exception?.description??e.exceptionDetails.text));
async function ev(expression){const v=await c.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(v.exceptionDetails)throw Error(v.exceptionDetails.exception?.description??v.exceptionDetails.text);return v.result.value}
async function until(expr,max=50000){for(let t=0;t<max;t+=150){if(await ev(expr))return;await sleep(150)}throw Error('timeout '+expr+' '+await ev("document.querySelector('#status').textContent"))}
async function key(code,vk,key=code){const data={code,key,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk};await c.send('Input.dispatchKeyEvent',{type:'keyDown',...data});await sleep(100);await c.send('Input.dispatchKeyEvent',{type:'keyUp',...data});await sleep(230)}
let launched=false;
try{
 assert.equal((await (await fetch(origin+'/api/studio/chapters/'+chapter+'/route')).json()).running,false,'使用独立验收工作台，已有试玩正在运行');
 await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Page.navigate',{url:origin+'/studio/chapters.html'});
 await until("document.querySelector('#rooms')?.options.length===252");
 if(chapter==='4'){
  await ev("document.querySelector('#chapter').value='4';document.querySelector('#chapter').dispatchEvent(new Event('change'))");
  await until("document.querySelector('#rooms').options.length===328");
 }
 const start=(await (await fetch(origin+'/api/studio/chapters/'+chapter+'/route')).json()).log.length;
 await ev("document.getElementById('play').click()");
 await until("document.getElementById('gamePanel').hidden===false");launched=true;
 const pixels="(()=>{const c=document.getElementById('gameView'),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return a.some((v,i)=>i%4===0&&v>120)})()";
 await until(pixels);
 const log=async()=>(await (await fetch(origin+'/api/studio/chapters/'+chapter+'/route')).json()).log.slice(start);
 let read='';
 for(let i=0;i<260;i++){read=await log();if(read.includes('PLACE_MENU'))break;await key('KeyZ',90,'z')}
 assert.ok(read.includes('PLACE_MENU'),read);
 await sleep(800);
 await fs.writeFile(path.join(work,'native-filemenu-'+chapter+'.png'),Buffer.from((await ev("document.getElementById('gameView').toDataURL('image/png')")).split(',')[1],'base64'));
 // Choose a blank slot and start a game in the isolated chapter save directory.
 for(let i=0;i<4;i++)await key('KeyZ',90,'z');
 await key('ArrowUp',38,'ArrowUp');await key('ArrowLeft',37,'ArrowLeft');await key('KeyZ',90,'z');
 await sleep(1100);await key('ArrowRight',39,'ArrowRight');await key('KeyZ',90,'z');
 const dest=chapter==='5'?'room_krisroom':'room_cc_fountain';
 for(let i=0;i<80;i++){read=await log();if(read.includes(dest))break;await sleep(180)}
 assert.ok(read.includes(dest),read);
 await sleep(2600);
 await fs.writeFile(path.join(work,'native-newgame-'+chapter+'.png'),Buffer.from((await ev("document.getElementById('gameView').toDataURL('image/png')")).split(',')[1],'base64'));
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({chapter,route:read.trim().split('\n'),browserInput:true}));
 }finally{
   if(launched){
     const base=origin+'/api/studio/chapters/'+chapter+'/';
     const run=await (await fetch(base+'route')).json();
     if(run.running&&run.pid)await fetch(base+'close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pid:run.pid})});
   }
   await edge.close();
 }

