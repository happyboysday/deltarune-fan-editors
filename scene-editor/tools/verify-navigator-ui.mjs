import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {args,data,openBrowserTest,Skip,workDir} from './test-env.mjs';
const [origin,working=workDir('verify-navigator-ui'),battle=data.battleRoot,shot]=args;
if(!origin)throw new Skip('原生导航验收需要显式指定隔离测试服务器');
const {edge}=await openBrowserTest(origin,battle,{profileDir:path.resolve(working,'edge'),windowSize:'1280,1050'});
const c=edge.cdp, sleep=ms=>new Promise(r=>setTimeout(r,ms)), exceptions=[];
c.on('Runtime.exceptionThrown',p=>exceptions.push(p.exceptionDetails.exception?.description??p.exceptionDetails.text));
async function ev(expression){const v=await c.send('Runtime.evaluate',{expression,userGesture:true,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(v.exceptionDetails.exception?.description??v.exceptionDetails.text);return v.result.value}
async function until(e,ms=50000){let to=Date.now()+ms;do{if(await ev(e))return;await sleep(150)}while(Date.now()<to);throw Error(e+' : '+await ev("document.getElementById('navInfo').textContent+' '+document.getElementById('status').textContent"))}
const api=async(route,data)=>{const r=await fetch(origin+'/api/studio/chapters/5/'+route,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});return r.json()};
let pid;
try{
 await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Page.navigate',{url:origin+'/studio/chapters.html'});
 await until("document.getElementById('navGoal').options.length>250");
 await ev("document.getElementById('rooms').value='room_krisroom';document.getElementById('rooms').dispatchEvent(new Event('change'));document.getElementById('preview').click()");
 await until("document.getElementById('gamePanel').hidden===false");
 pid=(await api('route')).pid;assert.ok(pid);
 // Wait for the rehearsal (3-6 sec startup); issue the actual UI action.
 await until("fetch('/api/studio/chapters/5/route').then(r=>r.json()).then(v=>v.log.includes('room_krisroom'))");
 const select=(id,val)=>"document.getElementById("+JSON.stringify(id)+").value="+JSON.stringify(val)+";document.getElementById("+JSON.stringify(id)+").dispatchEvent(new Event('change'));";
 await ev(select('navGoal','room_town_north')+"document.getElementById('navStart').click()");
 await until("document.getElementById('navInfo').textContent.includes('已抵达 room_town_north')");
 const run=await api('record');assert.equal(run.navigation.state,'arrived');assert.deepEqual(run.navigation.visited,['room_krisroom','room_krishallway','room_torhouse','room_town_krisyard','room_town_north']);assert.deepEqual([...new Set(run.inputSources)],['ai']);
 if(shot){
    await ev("document.getElementById('autonav').scrollIntoView({block:'end'})");
    const rect=await ev("(()=>{const a=document.querySelector('#gameView').getBoundingClientRect(),b=document.querySelector('#autonav').getBoundingClientRect();return {x:Math.min(a.x,b.x)+scrollX,y:a.y+scrollY,width:Math.max(a.right,b.right)-Math.min(a.x,b.x),height:b.bottom-a.top,scale:1}})()");
    const image=await c.send('Page.captureScreenshot',{format:'png',clip:rect,captureBeyondViewport:true});await fs.writeFile(shot,Buffer.from(image.data,'base64'));
 }
 await ev(select('navMode','explore')+"document.getElementById('navStart').click()");
 await until("!document.getElementById('navStop').disabled");
 const key={code:'ArrowLeft',key:'ArrowLeft',windowsVirtualKeyCode:37,nativeVirtualKeyCode:37};
 await c.send('Input.dispatchKeyEvent',{type:'keyDown',...key});await sleep(120);await c.send('Input.dispatchKeyEvent',{type:'keyUp',...key});
 await until("document.getElementById('navInfo').textContent.includes('手动接管')");
 assert.equal((await api('record')).inputSources.at(-1),'manual');
 await ev("document.getElementById('navResume').click()");
 await until("!document.getElementById('navStop').disabled");
 await ev("document.getElementById('navStop').click()");
 await until("document.getElementById('navInfo').textContent.includes('已暂停')");
 assert.equal((await api('navigator')).active,false);
 await api('close',{pid});pid=null;
 await c.send('Page.navigate',{url:origin+'/?blank=1'});
 await until("!!document.getElementById('document')?.value");
 const demo={format:'deltarune-scene/1',id:'ai-walk',title:'验收场景',viewport:{w:320,h:200},player:{radius:5,speed:3},start:{room:'hall',entry:'start'},events:{},rooms:{
 hall:{title:'走廊',w:320,h:200,entries:{start:{x:20,y:65,face:'right'}},entities:[{id:'shelf',kind:'wall',x:75,y:0,w:15,h:132},{id:'door',kind:'door',auto:true,room:'garden',entry:'start',x:180,y:60,w:20,h:30}]},
 garden:{title:'花园',w:320,h:200,entries:{start:{x:90,y:90}},entities:[]}}};
 await ev("document.getElementById('document').value="+JSON.stringify(JSON.stringify(demo))+";document.getElementById('applyJson').click()");
 await until("document.getElementById('title').value==='验收场景'");
 await ev("document.getElementById('play').click()");
 await until("!document.getElementById('sceneNav').hidden && document.getElementById('sceneNavTarget').options.length===3");
 await ev("document.getElementById('sceneNav').open=true;document.getElementById('sceneNavTarget').value='garden';document.getElementById('sceneNavStart').click()");
 await until("document.getElementById('sceneNavInfo').textContent==='已抵达 花园'");
 assert.deepEqual(exceptions,[]);
 console.log('Browser: destination reached; all walking inputs came from AI; manual takeover, resume, pause and regular scene editor navigation passed.');
}finally{if(pid)await api('close',{pid});await edge.close()}
