
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {battleControls,battleMovement} from './verify-battle.mjs';
const [html,out,battleRoot,qa]=process.argv.slice(2);
const {launchEdge}=await import(pathToFileURL(path.join(battleRoot,'tools/agent/render.mjs')));
const profile=await fs.mkdtemp(path.join(qa,'录像缓存-'));
const edge=await launchEdge({profileDir:profile,keepProfile:true});
const {cdp}=edge;
const ffmpeg=path.join(battleRoot,'runtime/ffmpeg/ffmpeg.exe');
const ff=spawn(ffmpeg,['-y','-loglevel','error','-f','image2pipe','-framerate','30','-c:v','png','-i','pipe:0','-vf','scale=960:756:flags=neighbor',
  '-c:v','libx264','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',out],{stdio:['pipe','inherit','inherit'],windowsHide:true});
const complete=new Promise((resolve,reject)=>{ff.on('error',reject);ff.on('close',code=>code===0?resolve():reject(new Error('FFmpeg exit '+code)));});
complete.catch(()=>{});
const send=b=>new Promise((res,rej)=>ff.stdin.write(b,e=>e?rej(e):res()));
async function evaluate(expression){
  const {result,exceptionDetails}=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(exceptionDetails)throw new Error(exceptionDetails.exception?.description??exceptionDetails.text);
  return result.value;
}
function screenWriter(){
  const canvas=document.createElement('canvas');
  canvas.width=640;canvas.height=504;
  const c=canvas.getContext('2d');
  window.recordFrame=(input,n,title)=>{
    sceneGame.advance(input,n);
    const view=document.querySelector('.scene-battle-stage.in-battle canvas')??document.querySelector('.screen>canvas');
    c.imageSmoothingEnabled=false;c.fillStyle='#0c0b14';c.fillRect(0,0,640,504);
    c.drawImage(view,(640-view.width)/2,(480-view.height)/2);
    c.fillStyle='#211832';c.fillRect(0,480,640,24);
    c.fillStyle='#ead9ff';c.font='13px "Microsoft YaHei UI",sans-serif';c.textBaseline='middle';
    c.fillText(title,12,493);
    return canvas.toDataURL().split(',')[1];
  };
}
let count=0;
async function frame(title,hold=[],press=[],n=1,repeat=1){
  const data=await evaluate('recordFrame('+JSON.stringify({hold,press})+','+n+','+JSON.stringify(title)+')');
  const bytes=Buffer.from(data,'base64');
  for(let i=0;i<repeat;i++){await send(bytes);count++;}
}
async function finishDialogue(title){
  for(let i=0;i<10&&await evaluate('!!sceneGame.world.state.dialogue');i++){
    await frame(title,[],[],18,17);await frame(title,['act'],['act'],1,5);
  }
}
try{
  await cdp.send('Page.enable');await cdp.send('Network.enable');await cdp.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
  await cdp.send('Page.navigate',{url:pathToFileURL(path.resolve(html)).href+'?manual=1'});
  for(let i=0;i<150;i++){
    if(await evaluate("document.body?.dataset.ready==='true'"))break;
    if(i===149)throw new Error('离线文件无法启动');
    await new Promise(r=>setTimeout(r,70));
  }
  await evaluate('('+screenWriter.toString()+')()');
  for(const route of ['spared','victory']){
    await evaluate('sceneGame.reset()');
    const title=route==='spared'?'路线 1：对话后开战':'路线 2：接触敌人开战';
    await frame(title,[],[],0,28);
    if(route==='spared'){
      for(let i=0;i<9;i++)await frame(title,['up']);
      await frame(title,['act'],['act']);
      await finishDialogue(title);
      await frame(title,[],[],0,30);
      await frame(title,['act'],['act']);
    }else{
      for(let i=0;i<62;i++)await frame(title,['right']);
    }
    await evaluate('sceneGame.battleReady.then(()=>true)');
    for(let i=0;i<10;i++)await frame(title);
    const battleTitle=route==='spared'?'ACT 盖章 → 躲开纸弹 → SPARE':'FIGHT · 在判定点出手';
    for(let i=0;i<550;i++){
      const state=await evaluate('sceneGame.battle?.getState()');
      if(!state)break;
      const press=battleControls(state,route).map(k=>k==='confirm'?'act':k);
      await frame(battleTitle,battleMovement(state,route),press,1,state.textbox&&state.phase!=='menu'?7:1);
    }
    assert.equal(await evaluate('sceneGame.world.state.lastBattle.result'),route);
    const ending=route==='spared'?'饶恕 · 同一地点返回，取得盖章值班单':'击败 · 同一地点返回，拾起通行纸';
    await frame(ending,[],[],18,58);
    await finishDialogue(ending);
    if(route==='spared'){
      for(let i=0;i<108;i++)await frame('饶恕后 · 档案室门已解锁',['right']);
      assert.equal(await evaluate('sceneGame.world.state.prompt?.id'),'exit_gate');
      await frame('进入档案室',['act'],['act']);
      for(let i=0;i<28;i++)await frame('进入档案室');
      assert.equal(await evaluate('sceneGame.world.state.room'),'archive');
      await frame('档案室保存了本次结算',[],[],22,68);
    }
  }
  ff.stdin.end();await complete;
  console.log(JSON.stringify({frames:count,seconds:count/30,offline:true,out}));
}finally{
  if(!ff.stdin.writableEnded)ff.stdin.end();
  await edge.close();
}
