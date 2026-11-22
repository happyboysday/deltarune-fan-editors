import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {args,data,openBrowserTest,requireData,workDir} from './test-env.mjs';
const [address,work=workDir('verify-chapter-ui'),battle=data.battleRoot]=args;
if(!address)requireData(...[4,5].flatMap(n=>['index.json','scripts.zip','previews.json'].map(file=>`chapters/ch${n}/${file}`)));
const {origin:url,edge}=await openBrowserTest(address,battle,{profileDir:path.resolve(work,'chapter-ui-edge'),windowSize:'1600,1000'});
const c=edge.cdp,errors=[];
c.on('Runtime.exceptionThrown',p=>errors.push(p.exceptionDetails.exception?.description??p.exceptionDetails.text));
async function evaluate(expression){
 const r=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
 if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);
 return r.result.value;
}
async function wait(expr){
 for(let i=0;i<150;i++){if(await evaluate(expr))return;await new Promise(r=>setTimeout(r,120))}
 throw Error(expr+' · '+await evaluate('status.textContent'));
}
try{
 await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Page.navigate',{url:url+'/studio/chapters.html'});
 for(const [n,room,idx] of [[5,'room_krisroom',1],[4,'room_dw_church_ripplepuzzle',8]]){
  await wait("document.querySelector('#milestones button')!=null");
  if(n===4)await evaluate("const ch=document.querySelector('#chapter');ch.value='4';ch.dispatchEvent(new Event('change'))");
  await wait("document.querySelector('#rooms').options.length==="+(n===4?328:252));
  await evaluate("document.querySelectorAll('#milestones button')["+idx+"].click()");
  await wait("document.querySelector('#rooms').value==="+JSON.stringify(room)+" && document.querySelector('#source').value.length>15");
  const data=await evaluate("({room:document.querySelector('#rooms').value,script:document.querySelector('#events').value,source:document.querySelector('#source').value.length})");
  assert.ok(data.script&&data.source>15);
  await wait("(()=>{const c=document.querySelector('#plan'),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let v=new Set();for(let i=0;i<a.length;i+=160)v.add(a[i]+':'+a[i+1]+':'+a[i+2]);return v.size>15})()");
  const shot=await c.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(work,'chapter-ui-'+n+'.png'),Buffer.from(shot.data,'base64'));
  console.log(JSON.stringify(data));
 }
 assert.deepEqual(errors,[]);
}finally{await edge.close()}

