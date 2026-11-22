import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {relayInput} from './verify-campaign.mjs';

const [html,out,battleRoot,qa]=process.argv.slice(2);
const fromBattle=rel=>import(pathToFileURL(path.join(battleRoot,rel)));
const [{launchEdge},{buildMixPlan,buildWavCommand,planBgmSegments,planSfxEvents,dedupeSfx},{runFfmpeg,probeMedia}]=await Promise.all([
  fromBattle('tools/agent/render.mjs'),fromBattle('tools/record/audio.js'),fromBattle('tools/record/media.js')
]);
await fs.mkdir(qa,{recursive:true});
const work=await fs.mkdtemp(path.join(qa,'replay-'));
const edge=await launchEdge({profileDir:path.join(work,'profile'),keepProfile:true,windowSize:'1024,864'});
const {cdp}=edge;
const fps=30,ffmpeg=path.join(battleRoot,'runtime/ffmpeg/ffmpeg.exe'),ffprobe=path.join(battleRoot,'runtime/ffmpeg/ffprobe.exe');
const raw=path.join(work,'video.mp4'),wav=path.join(work,'mix.wav'),graph=path.join(work,'mix.ffgraph');
const ff=spawn(ffmpeg,['-y','-loglevel','error','-f','image2pipe','-framerate',String(fps),'-c:v','png','-i','pipe:0',
  '-vf','scale=960:696:flags=neighbor','-c:v','libx264','-crf','17','-pix_fmt','yuv420p',raw],{stdio:['pipe','inherit','inherit'],windowsHide:true});
const complete=new Promise((resolve,reject)=>{
  ff.on('error',reject);
  ff.on('close',code=>code===0?resolve():reject(new Error('FFmpeg exit '+code)));
});
complete.catch(()=>{});
const send=bytes=>new Promise((res,rej)=>ff.stdin.write(bytes,error=>error?rej(error):res()));
const chapters=[],net=[];
let count=0;
let section=['余火接力','按 Z 使用余火灯，保存当前队伍和道具。'];
function chapter(title,caption){
  section=[title,caption];
  chapters.push({frame:count,seconds:count/fps,title});
}
async function evaluate(expression){
  const {result,exceptionDetails}=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if(exceptionDetails)throw new Error(exceptionDetails.exception?.description??exceptionDetails.text);
  return result.value;
}
const state=()=>evaluate('sceneGame.world.state');
const waitBattle=()=>evaluate('sceneGame.battleReady.then(()=>true)');
function installRecorder(){
  const film=document.createElement('canvas');
  film.width=480;film.height=348;
  const ctx=film.getContext('2d'),{width:w}=film,h=300;
  window.__drAudioLog={active:true,events:[],fps:30,frame:0};
  window.recordFrame=async ([title,caption],screenshot)=>{
    const stage=document.querySelector('.scene-battle-stage');
    const view=stage&&!stage.hidden?stage.querySelector('canvas:not([hidden])'):document.querySelector('.screen>canvas');
    ctx.imageSmoothingEnabled=false;
    ctx.fillStyle='#090711';ctx.fillRect(0,0,w,h);
    if(screenshot){
      const overlay=new Image();
      overlay.src='data:image/png;base64,'+screenshot;
      await overlay.decode();ctx.drawImage(overlay,0,0,w,h);
    }else{
      const scale=Math.min(w/view.width,h/view.height);
      const x=(w-view.width*scale)/2,y=(h-view.height*scale)/2;
      ctx.drawImage(view,x,y,view.width*scale,view.height*scale);
      const curtain=stage.querySelector('.scene-battle-curtain');
      if(!curtain.hidden){
        ctx.globalAlpha=Number(curtain.style.opacity);
        ctx.fillStyle='#090611';ctx.fillRect(0,0,w,h);
        ctx.textAlign='center';ctx.font='bold 13px "Microsoft YaHei UI",sans-serif';ctx.fillStyle='#ead9ff';
        ctx.fillText(curtain.textContent,w/2,h/2+4);ctx.textAlign='start';
        ctx.globalAlpha=1;
      }
    }
    ctx.fillStyle='#1b1429';ctx.fillRect(0,h,w,48);
    ctx.fillStyle='#d4a65e';ctx.fillRect(0,h,w,1);ctx.fillRect(14,h+12,2,25);
    ctx.font='bold 12px "Microsoft YaHei UI",sans-serif';ctx.fillStyle='#ffe5b5';ctx.fillText(title,24,h+20);
    ctx.font='11px "Microsoft YaHei UI",sans-serif';ctx.fillStyle='#e7dbf5';ctx.fillText(caption,24,h+37);
    return film.toDataURL('image/png').split(',')[1];
  };
}
async function frame(hold=[],press=[],n=1,repeat=1,screenshot=false){
  const advance='__drAudioLog.frame='+count+';sceneGame.advance('+JSON.stringify({hold,press})+','+n+');';
  let data;
  if(screenshot){
    await evaluate(advance);
    const clip=await evaluate("(()=>{const {x,y,width,height}=document.querySelector('.screen').getBoundingClientRect();return {x,y,width,height,scale:1};})()");
    const captured=await cdp.send('Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:false});
    data=await evaluate('recordFrame('+JSON.stringify(section)+','+JSON.stringify(captured.data)+')');
  }else data=await evaluate(advance+'recordFrame('+JSON.stringify(section)+')');
  const bytes=Buffer.from(data,'base64');
  for(let i=0;i<repeat;i++){await send(bytes);count++;}
}
async function until(condition,hold=[],limit=160){
  for(let i=0;i<limit;i++){
    if(condition(await state()))return;
    await frame(hold);
  }
  assert.fail('未到达演示节点：'+condition);
}
const tap=(repeat=1)=>frame(['act'],['act'],1,repeat);
async function closeText(){
  for(let i=0;i<12&&(await state()).dialogue;i++){
    await frame([],[],15,14);await tap();
  }
  assert.equal((await state()).dialogue,null);
}
async function intro(title,caption){
  await waitBattle();chapter(title,caption);
  await frame([],[],0,8);
  for(let i=0;i<26;i++)await frame();
  assert.ok(await evaluate("document.querySelector('.scene-battle-stage.in-battle')!==null"));
}
async function fight(route){
  let itemPaused=false,startedAttack=false;
  for(let i=0;i<1200;i++){
    const b=await evaluate('sceneGame.battle?.getState()');
    if(!b)return (await state()).lastBattle.result;
    if(route==='use'&&b.menu?.list?.kind==='item'&&!itemPaused){
      itemPaused=true;chapter('第一战 · 使用星糖','战斗中的道具栏读取场景库存：共有 2 颗星糖。');
      await frame([],[],0,46);
    }
    if(!startedAttack&&b.phase==='attack'){
      startedAttack=true;
      chapter(route==='use'?'第一战 · 实际结算':'第二战 · 队伍落败',
        route==='use'?'用药与受伤按实际数值结算；胜利后将奖励带回场景。':'演示路线故意不闪避，检验落败后的读档。');
    }
    const move=relayInput(b,route==='use'&&b.turnNumber>=2?'win':route);
    await frame(move.hold,move.press.map(k=>k==='confirm'?'act':k),1,b.textbox&&b.phase!=='menu'?8:1);
  }
  throw new Error('战斗未结算');
}
try{
  await cdp.send('Page.enable');await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent',e=>{if(/^https?:/.test(e.request.url))net.push(e.request.url);});
  await cdp.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
  await cdp.send('Page.navigate',{url:pathToFileURL(path.resolve(html)).href+'?manual=1'});
  for(let i=0;i<150;i++){
    if(await evaluate("document.body?.dataset.ready==='true'"))break;
    if(i===149)throw new Error('离线文件无法启动');
    await new Promise(r=>setTimeout(r,70));
  }
  await evaluate('('+installRecorder.toString()+')()');
  chapter(...section);await frame([],[],0,36);
  await until(s=>s.player.x>=207,['right']);
  await frame(['up']);await tap(34);assert.equal((await state()).saveRequest.id,'lamp');
  chapter('余火灯 · 已记录','存档中有 34 / 48 HP、2 颗星糖，读档时回到灯旁。');
  await tap(41);assert.equal(await evaluate('sceneGame.save.snapshot.party.kris.hp'),34);
  await until(s=>s.battle?.id==='patrol',['right']);
  await intro('第一战 · 接触灯芯巡逻员','角色从场景位置冲向战斗站位，落位后才出现战斗 HUD。');
  await frame([],[],0,32);
  assert.equal(await fight('use'),'victory');
  const first=await state();
  assert.equal(first.party.kris.hp,26);assert.equal(first.inventory.tonic,1);assert.equal(first.inventory.cinder,1);assert.equal(first.inventory.badge,1);
  chapter('战斗返回场景','剩余 26 / 48 HP、1 颗星糖，另得到余烬袋和灯章。');
  await frame([],[],1,22);await closeText();await frame([],[],0,29);
  await until(s=>s.prompt?.id==='stair',['right']);await tap();
  await until(s=>s.room==='furnace'&&!s.locked);
  chapter('下一间房 · 继续前进','场景和遭遇可以使用不同角色 ID，仍继承同一个队伍。');
  await until(s=>s.battle?.id==='latch',['right']);await waitBattle();
  const second=await evaluate('sceneGame.battle.partyState()');
  assert.equal(second.party[0].hp,26);
  for(const id of ['tonic','cinder','badge'])assert.equal(second.items.find(i=>i.id===id).count,1);
  await intro('第二战 · 余烬门闩','新战斗继承 26 / 48 HP、剩下的星糖和两件奖励。');
  await frame([],[],0,32);
  assert.equal(await fight('lose'),'defeat');
  chapter('队伍落败 · 读取存档','可以读取最近的余火灯存档，也可以从头开始。');
  await frame([],[],0,59,true);
  await evaluate("document.querySelector('.play-loss .play-loss-actions button:first-child').click()");
  const back=await state();
  assert.equal(back.room,'hall');assert.equal(back.player.x,208);assert.equal(back.party.kris.hp,34);assert.equal(back.inventory.tonic,2);
  assert.equal(back.inventory.cinder,undefined);
  chapter('回到余火灯','恢复 34 / 48 HP 和 2 颗星糖；此后获得的奖励与进度一并回滚。');
  await frame([],[],0,83);
  assert.deepEqual(net,[]);
  // Offline exports use data URLs as file keys. Decode each embedded track once,
  // then give FFmpeg short filenames, not multi-megabyte command-line arguments.
  const source=await evaluate(`(() => {
    const keys=new Map(), tracks=[];
    const events=__drAudioLog.events.map(({url,file,...event})=>{
      if(!file)return event;
      if(!keys.has(file)){keys.set(file,tracks.length);tracks.push(file);}
      return {...event,file:'track-'+keys.get(file)};
    });
    return {events,tracks};
  })()`);
  for(const [i,track] of source.tracks.entries()){
    const encoded=/^data:audio\/[-+.\w]+;base64,([a-z0-9+/=]+)$/i.exec(track)?.[1];
    assert.ok(encoded,'录制用 HTML 必须内嵌音频');
    await fs.writeFile(path.join(work,'track-'+i),Buffer.from(encoded,'base64'));
  }
  const opts={totalSeconds:count/fps};
  const bgmSegments=planBgmSegments(source.events,opts),sfxEvents=dedupeSfx(planSfxEvents(source.events,opts));
  assert.equal(bgmSegments.length,2);
  assert.equal(sfxEvents.filter(e=>e.name==='snd_weaponpull_fast').length,2);
  ff.stdin.end();await complete;
  const plan=buildMixPlan({bgmSegments,sfxEvents,...opts,resolve:()=>file=>path.join(work,file)});
  await fs.writeFile(graph,plan.filter);
  await runFfmpeg(ffmpeg,buildWavCommand(plan,wav,{filterFile:graph}).args);
  await runFfmpeg(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',raw,'-i',wav,'-c:v','copy','-af','volume=0.85','-c:a','aac','-b:a','160k','-movflags','+faststart',out]);
  const media=await probeMedia(ffprobe,out);
  const report={frames:count,seconds:count/fps,chapters,bgm:bgmSegments.length,sfx:sfxEvents.length,media};
  await fs.writeFile(path.join(qa,'录像验收.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{
  if(!ff.stdin.writableEnded)ff.stdin.end();
  await edge.close();
}
