import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {args,data,openBrowserTest,requireData,workDir} from './test-env.mjs';

const [address,cache=workDir('verify-chapter5-browser'),evidence=path.join(cache,'evidence'),battle=data.battleRoot]=args;
if(!address)requireData('assets/chapter5/chapter5.scene.json','assets/chapter5/layouts','officialRoot');
await fs.mkdir(evidence,{recursive:true});
const {origin:url,edge}=await openBrowserTest(address,battle,{profileDir:path.join(cache,'chapter5-final-edge'),windowSize:'1550,1040'});
const c=edge.cdp;
const errors=[];
c.on('Runtime.exceptionThrown',p=>errors.push(p.exceptionDetails.exception?.description??p.exceptionDetails.text));
const evaluate=async expression=>{
 const r=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
 if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
 return r.result.value;
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const label="document.querySelector('#sceneLabel').textContent";
const status="document.querySelector('#status').textContent";
async function wait(expr,ms=15000){
 for(let i=0;i<ms;i+=100){if(await evaluate(expr))return;await sleep(100);}
 throw Error('Timed out: '+expr+' · '+await evaluate(status));
}
function click(id){return evaluate("document.getElementById("+JSON.stringify(id)+").click()");}
async function screenshot(name){
 const shot=await c.send('Page.captureScreenshot',{format:'png'});
 await fs.writeFile(path.join(evidence,name+'.png'),Buffer.from(shot.data,'base64'));
}
async function navigate(addr){
 const loaded=c.waitForEvent('Page.loadEventFired',30000);
 await c.send('Page.navigate',{url:addr});await loaded;
}
const summary=[];
try{
 await c.send('Page.enable');await c.send('Runtime.enable');
 await navigate(url);
 await wait("document.body.dataset.ready==='true' && !document.querySelector('#embedLayout').hidden");
 assert.equal(await evaluate("document.querySelector('#rooms').length"),196);
 await screenshot('01-第5章工作台');
 await click('play');await wait(status+".includes('试玩中')");
 await c.send('Input.dispatchKeyEvent',{type:'keyDown',code:'ArrowDown',key:'ArrowDown',windowsVirtualKeyCode:40,nativeVirtualKeyCode:40});
 await sleep(180);
 await c.send('Input.dispatchKeyEvent',{type:'keyUp',code:'ArrowDown',key:'ArrowDown',windowsVirtualKeyCode:40,nativeVirtualKeyCode:40});
 await wait(label+".includes('Krishallway') && "+label+".includes('试玩')");
 await screenshot('02-走过实际门到走廊');
 summary.push('opened chapter project, pressed play, walked through the source door, lazily loaded the destination art');
 await click('editMode');await wait(label+".includes('编辑')");
 await evaluate("(()=>{const el=document.querySelector('#sceneSearch');el.value='fcastle_entrance';el.dispatchEvent(new Event('input'));const r=document.querySelector('#rooms');r.value='room_dw_fcastle_entrance';r.dispatchEvent(new Event('change'));})()");
 await wait(label+".includes('Flower Castle Entrance')");
 await click('embedLayout');
 await wait("document.querySelector('#layers').textContent.includes('左：可见')");
 assert.match(await evaluate("document.querySelector('#status').textContent"),/布景已内嵌/);
 await screenshot('03-花城原图层');
 summary.push('searched a room by source ID, selected it, embedded the source layout for editable layers');
 await click('example');
 await wait("document.querySelector('#dialog').open");
 await evaluate("document.querySelector('#dialog button[value=ok]').click()");
 await wait("document.querySelector('#title').value.includes('回声工坊')");
 await wait("document.body.dataset.ready==='true'");
 assert.match(await evaluate("document.querySelector('#title').value"),/回声工坊/);
 assert.equal(errors.length,0,errors.join('\n'));
 summary.push('old V0.5 project opens on V1.0');
 const result={browser:edge.browser,checks:summary,errors};
 await fs.writeFile(path.join(evidence,'浏览器验收.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{await edge.close();}

