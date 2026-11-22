
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {relayInput} from './verify-campaign.mjs';
import {args,data,openBrowserTest,requireData,workDir} from './test-env.mjs';

const [origin,out=workDir('verify-campaign-browser'),root=data.battleRoot,publishedFile]=args;
if(!origin)requireData('battleAssets/index.json');
const published=publishedFile??path.join(data.assets,'examples','余火接力-离线试玩.html');
const hasPublished=published&&(await fs.stat(published).catch(ex=>ex.code==='ENOENT'?null:Promise.reject(ex)))?.isFile();
await fs.mkdir(out,{recursive:true});
const scratch=await fs.mkdtemp(path.join(out,'edge-'));
const {origin:studio,edge}=await openBrowserTest(origin,root,{profileDir:path.join(scratch,'profile'),windowSize:'1440,970'});
const {cdp}=edge,errors=[],requests=[];
const delay=n=>new Promise(r=>setTimeout(r,n));
async function evalIn(expression){
  const {result,exceptionDetails}=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if(exceptionDetails)throw new Error(exceptionDetails.exception?.description??exceptionDetails.text);
  return result.value;
}
async function wait(expression,ms=12000){
  for(const end=Date.now()+ms;Date.now()<end;){
    const value=await evalIn(expression);if(value)return value;await delay(80);
  }
  throw new Error('超时：'+expression+' '+await evalIn("[location.href,document.querySelector('#status')?.textContent]"));
}
const click=sel=>evalIn('document.querySelector('+JSON.stringify(sel)+').click()');
const set=(sel,value)=>evalIn(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
async function shot(file,selector){
  const base64=selector?(await evalIn('document.querySelector('+JSON.stringify(selector)+').toDataURL()')).split(',')[1]:
    (await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data;
  await fs.writeFile(path.join(out,file),Buffer.from(base64,'base64'));
}
async function readDownload(name,mode='html'){
  const file=path.join(scratch,name);
  for(let i=0;i<170;i++){
    try{
      const text=await fs.readFile(file,'utf8');
      if(mode==='html'&&text.includes('</html>')||mode==='json'&&JSON.parse(text).snapshot)return {file,text};
    }catch(ex){if(ex.code!=='ENOENT'&&!(ex instanceof SyntaxError))throw ex;}
    await delay(80);
  }
  throw new Error('没有下载：'+name);
}
const state=()=>evalIn("sceneGame.world.state");
const advance=(hold=[],press=[],n=1)=>evalIn('sceneGame.advance('+JSON.stringify({hold,press})+','+n+')');
const tap=()=>advance(['act'],['act']);
const key=(type,code,key)=>cdp.send('Input.dispatchKeyEvent',{type,code,key});
const tapKey=async(code,value)=>{
  await key('keyDown',code,value);await delay(74);await key('keyUp',code,value);
};
async function goUntil(condition,hold=[],limit=160,readState=state,step=advance){
  for(let i=0;i<limit;i++){
    const s=await readState();if(condition(s))return s;
    await step(hold);
  }
  const s=await readState();
  throw new Error(JSON.stringify({condition:String(condition),room:s.room,player:s.player,prompt:s.prompt,request:s.saveRequest}));
}
async function openLamp(readState,step){
  await goUntil(s=>s.player.x>=207,['right'],160,readState,step);
  await step(['up']);await step(['act'],['act']);
}
function entryState({room,player:{x,y,face},flags}){
  return {room,player:{x,y,face},flags};
}
async function closeText(){
  for(let i=0;i<12&&(await state()).dialogue;i++)await tap();
  assert.equal((await state()).dialogue,null);
}
const playwrightRect="(()=>{const a=document.querySelector('.screen').getBoundingClientRect();return [a.x,a.y,a.width,a.height]})()";
const fittedCanvas=(selector)=>`(()=>{
  const v=document.querySelector(${JSON.stringify(selector)}),r=v.getBoundingClientRect(),k=Math.min(r.width/v.width,r.height/v.height);
  const w=v.width*k,h=v.height*k;
  return [r.x+(r.width-w)/2,r.y+(r.height-h)/2,w,h];
})()`;
try{
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');
  cdp.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.exception?.description??e.exceptionDetails.text));
  cdp.on('Network.requestWillBeSent',e=>requests.push(e.request.url));
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:scratch});
  if(!hasPublished)console.log('SKIP: 未找到旧版《余火接力》离线试玩文件');
  await cdp.send('Page.navigate',{url:studio+'/?example=campaign'});
  await wait("document.body?.dataset.ready==='true'&&document.getElementById('title').value==='余火接力'");
  await click('#campaignPanel summary');
  assert.equal(await evalIn("document.querySelector('[aria-label=\"初始 HP\"]').value"),'34');
  await shot('01-队伍与存档设置.png');
  await set('#entities','entity:lamp');
  const healSwitch="[...document.querySelectorAll('#fields label')].find(l=>l.textContent==='保存时恢复 HP').querySelector('input')";
  await click('#refreshJson');
  const original=JSON.parse(await evalIn("document.querySelector('#document').value"));
  await evalIn(healSwitch+'.click()');
  await click('#play');
  await wait("document.body.classList.contains('playing')");
  await key('keyDown','ArrowRight','ArrowRight');await delay(1040);await key('keyUp','ArrowRight','ArrowRight');
  await tapKey('ArrowUp','ArrowUp');await tapKey('KeyZ','z');await tapKey('KeyZ','z');
  const editorSaveKey="localStorage.getItem('director.play-save/ember-relay-v1')";
  await wait(editorSaveKey);
  assert.equal(await evalIn('JSON.parse('+editorSaveKey+').snapshot.party.kris.hp'),48);
  await click('#editMode');
  await click('#play');
  await wait("document.body.classList.contains('playing')");
  assert.equal(await evalIn("document.querySelector('.play-savebar button:first-child').disabled"),false);
  await click('.play-savebar button:first-child');
  await shot('01b-在线读取试玩档.png');
  await key('keyDown','ArrowRight','ArrowRight');
  await wait("!document.querySelector('.scene-battle-entry').hidden");
  await key('keyUp','ArrowRight','ArrowRight');
  await shot('02-在线入战.png');
  await wait("document.querySelector('.scene-battle-stage.in-battle')");
  await click('#editMode');
  // Reopen the original fixture with a clean editor before checking its export.
  const acceptDiscard=cdp.on('Page.javascriptDialogOpening',()=>cdp.send('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{}));
  await cdp.send('Page.navigate',{url:studio+'/?example=campaign'});
  acceptDiscard();
  await wait("document.body?.dataset.ready==='true'&&document.getElementById('title').value==='余火接力'");
  await click('#refreshJson');
  assert.deepEqual(JSON.parse(await evalIn("document.querySelector('#document').value")),original);
  await click('#exportHtml');
  await wait("document.getElementById('status').textContent.includes('HTML 已导出')");
  const {text:html}=await readDownload('余火接力-离线试玩.html');
  const offline=path.join(out,'余火接力-离线试玩.html');await fs.writeFile(offline,html);
  const url=pathToFileURL(offline).href+'?manual=1',requestsStart=requests.length;
  await cdp.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
  await cdp.send('Page.navigate',{url});
  await wait("location.protocol==='file:'&&document.body?.dataset.ready==='true'&&!!window.sceneGame");
  await evalIn("window.__drAudioLog={active:true,events:[],fps:30,frame:0}");
  await openLamp(state,advance);assert.equal((await state()).saveRequest.id,'lamp');
  await shot('03-存档确认.png','.screen>canvas');
  await tap();
  const saved=await evalIn('sceneGame.save');
  assert.equal(saved.snapshot.party.kris.hp,34);
  assert.equal(saved.snapshot.inventory.tonic,2);
  assert.equal(saved.snapshot.player.x,208);
  assert.equal(await evalIn("JSON.parse(localStorage.getItem('director.play-save/ember-relay-v1')).snapshot.party.kris.hp"),34);
  await click('.play-savebar button:nth-child(2)');
  const exported=await readDownload('scene-save-ember-relay-v1.json','json');
  assert.deepEqual(JSON.parse(exported.text),saved);
  await cdp.send('Page.reload');
  await wait("document.body?.dataset.ready==='true'&&!!window.sceneGame?.save");
  await click('.play-savebar button:first-child');
  assert.equal((await state()).player.x,208);
  await evalIn("window.__drAudioLog={active:true,events:[],fps:30,frame:0}");
  const rect=await evalIn(playwrightRect);
  await goUntil(s=>s.battle?.id==='patrol',['right']);
  const start=await state();
  await evalIn('sceneGame.battleReady.then(()=>true)');
  assert.deepEqual(await evalIn(playwrightRect),rect);
  // On a short window the scene canvas is height-limited. Both overlays must
  // use its fitted coordinate system instead of sizing to the outer column.
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:500,deviceScaleFactor:1,mobile:false});
  const sceneFit=await evalIn(fittedCanvas('.screen>canvas'));
  const entryFit=await evalIn(fittedCanvas('.scene-battle-entry'));
  assert.ok(sceneFit.every((value,i)=>Math.abs(value-entryFit[i])<1));
  const [x,y,w,h]=entryFit,combatWidth=h*4/3;
  const expectedCombat=[x+(w-combatWidth)/2,y,combatWidth,h];
  const hashes=new Set();
  for(let t=0;t<=25;t++){
    if([0,5,10,14,19,24].includes(t)){
      hashes.add(await evalIn("document.querySelector('.scene-battle-entry').toDataURL()"));
      await shot('转场-'+String(t).padStart(2,'0')+'.png','.scene-battle-entry');
    }
    if(t<25)await advance();
  }
  assert.ok(hashes.size>=5);
  assert.equal((await state()).tick,start.tick);
  await advance();assert.ok(await evalIn("document.querySelector('.scene-battle-stage.in-battle')"));
  const actualCombat=await evalIn(fittedCanvas('.scene-battle-canvas'));
  assert.ok(actualCombat.every((value,i)=>Math.abs(value-expectedCombat[i])<1));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(await evalIn(playwrightRect),rect);
  const firstInitial=await evalIn("sceneGame.battle.partyState()");
  assert.equal(firstInitial.party[0].hp,21,'intro damage is applied after the inherited 34 HP opening');
  let itemShown=false;
  async function fight(route){
    for(let i=0;i<1200;i++){
      const b=await evalIn('sceneGame.battle?.getState()');
      if(!b)return (await state()).lastBattle.result;
      if(b.menu?.list?.kind==='item'&&!itemShown){itemShown=true;await shot('04-战斗道具栏.png','.scene-battle-canvas');}
      const move=relayInput(b,route==='use'&&b.turnNumber>=2?'win':route);
      await advance(move.hold,move.press.map(k=>k==='confirm'?'act':k));
    }
    throw new Error('战斗没有结算');
  }
  assert.equal(await fight('use'),'victory');
  const first=await state();
  assert.equal(first.party.kris.hp,26);assert.equal(first.inventory.tonic,1);
  assert.equal(first.inventory.cinder,1);assert.equal(first.inventory.badge,1);
  assert.equal(first.tick,start.tick);
  await advance();await advance([],[],14);
  await shot('05-第一战回场景.png','.screen>canvas');
  await closeText();
  await goUntil(s=>s.prompt?.id==='stair',['right']);await tap();
  await goUntil(s=>s.room==='furnace'&&!s.locked);
  await goUntil(s=>s.battle?.id==='latch',['right']);
  await evalIn('sceneGame.battleReady.then(()=>true)');
  const second=await evalIn('sceneGame.battle.partyState()');
  assert.equal(second.party[0].id,'guest');
  assert.equal(second.party[0].hp,26);assert.equal(second.party[0].maxHp,48);
  for(const k of ['tonic','badge','cinder'])assert.equal(second.items.find(a=>a.id===k).count,1);
  await advance([],[],26);
  await shot('06-第二战继承.png','.scene-battle-canvas');
  assert.equal(await fight('lose'),'defeat');
  assert.equal((await state()).party.kris.hp,0);
  await shot('07-落败读档.png');
  // The Game Over screen is drawn on the canvas since the S2 play UI (abb8382): tapping confirm
  // four times while the SOUL shatters revives at once and continues from the last save.
  for(let i=0;i<400&&await evalIn('!!sceneGame.world.state.defeat');i++)await advance([],['act']);
  assert.equal(await evalIn('!!sceneGame.world.state.defeat'),false,'Game Over screen must continue from the save');
  const restored=await state();
  assert.equal(restored.room,'hall');assert.equal(restored.player.x,208);assert.equal(restored.party.kris.hp,34);
  assert.equal(restored.inventory.tonic,2);assert.equal(restored.inventory.cinder,undefined);assert.equal(restored.flags.first_cleared,undefined);
  await shot('08-回到余火灯.png','.screen>canvas');
  const log=await evalIn("window.__drAudioLog.events.map(e=>[e.type,e.action,e.name])");
  assert.deepEqual(log.filter(e=>e[0]==='bgm').map(e=>e[1]),['play','stop','play','stop']);
  assert.equal(log.filter(e=>e[2]==='snd_weaponpull_fast').length,2);
  await evalIn("localStorage.removeItem('director.play-save/ember-relay-v1');sceneGame.reset()");
  // The portable JSON can be imported even when this browser's storage was cleared.
  const input=await cdp.send('DOM.getDocument');
  const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:input.root.nodeId,selector:'.play-savebar input[type=file]'});
  await cdp.send('DOM.setFileInputFiles',{nodeId,files:[exported.file]});
  await wait("sceneGame.world.state.player.x===208&&sceneGame.world.state.party.kris.hp===34");
  assert.deepEqual(errors,[]);
  assert.equal(requests.slice(requestsStart).filter(u=>/^https?:/.test(u)).length,0);
  if(hasPublished){
    const legacyUrl=pathToFileURL(path.resolve(published)).href+'?manual=1&legacy=1';
    await cdp.send('Page.navigate',{url:legacyUrl});
    await wait("location.protocol==='file:'&&location.search==='?manual=1&legacy=1'&&document.body?.dataset.ready==='true'&&!!window.sceneGame");
    await advance(['right'],[],10);
    assert.equal((await state()).tick,10,'previous export starts and advances');
  }
  const data={ok:true,browser:edge.browser,first:{hp:first.party.kris.hp,inventory:first.inventory},second,restored:{room:restored.room,x:restored.player.x,hp:restored.party.kris.hp,inventory:restored.inventory},entryFrames:hashes.size,compactViewport:true,log,editorSavepoint:true,editorSaveLoad:true,editorOfflineParity:true,legacyExportOpened:Boolean(hasPublished),saveReload:true,saveFileImport:true};
  await fs.writeFile(path.join(out,'浏览器验收.json'),JSON.stringify(data,null,2)+'\n');
  console.log(JSON.stringify(data,null,2));
}catch(ex){
  await shot('浏览器故障.png').catch(()=>{});
  console.error(errors);throw ex;
}finally{await edge.close();}
