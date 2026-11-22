
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {battleControls,battleMovement} from './verify-battle.mjs';
import {args,data,openBrowserTest,requireData,requirePath,workDir} from './test-env.mjs';

const [origin,out=workDir('verify-battle-browser'),battleRoot=data.battleRoot]=args;
if(!origin){
  requireData('battleAssets/index.json');
  requirePath(path.join(battleRoot,'serve.py'),'battleRoot/serve.py');
}
await fs.mkdir(out,{recursive:true});
const scratch=await fs.mkdtemp(path.join(out,'edge-'));
const {origin:studio,edge,CDP}=await openBrowserTest(origin,battleRoot,{profileDir:path.join(scratch,'profile'),windowSize:'1400,960'});
const cdp=edge.cdp,net=[],errors=[];
let savedBattleTitle;
const delay=n=>new Promise(r=>setTimeout(r,n));
async function evalOn(session,expression){
  const {result,exceptionDetails}=await session.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if(exceptionDetails)throw new Error(exceptionDetails.exception?.description??exceptionDetails.text);
  return result.value;
}
const run=expression=>evalOn(cdp,expression);
async function wait(expression,ms=12000,session=cdp){
  const stop=Date.now()+ms;
  while(Date.now()<stop){
    const value=await evalOn(session,expression);
    if(value)return value;
    await delay(80);
  }
  throw new Error('超时：'+expression+' '+await evalOn(session,"[location.href,document.querySelector('#status')?.textContent,document.querySelector('#enc-toolbar-msg')?.textContent]"));
}
const click=selector=>run('document.querySelector('+JSON.stringify(selector)+').click()');
const set=(selector,value)=>run('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}));})()');
async function download(name){
  const file=path.join(scratch,name);
  for(let i=0;i<160;i++){
    const text=await fs.readFile(file,'utf8').catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
    if(text?.includes('</html>'))return text;
    await delay(80);
  }
  throw new Error('Missing '+name);
}
async function shot(file,canvas=false){
  const data=canvas?(await run("(document.querySelector('.scene-battle-stage.in-battle canvas')??document.querySelector('.screen>canvas')).toDataURL()")).split(',')[1]:
    (await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data;
  await fs.writeFile(path.join(out,file),Buffer.from(data,'base64'));
}
const down=(code,key)=>cdp.send('Input.dispatchKeyEvent',{type:'keyDown',code,key});
const up=(code,key)=>cdp.send('Input.dispatchKeyEvent',{type:'keyUp',code,key});
const tap=async(code,key)=>{await down(code,key);await delay(48);await up(code,key);await delay(48);};
async function jsonPost(endpoint,body){
  const res=await fetch(studio+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:res.status,data:await res.json()};
}
try{
  const catalogue=await fetch(studio+'/api/studio/battles');
  assert.equal(catalogue.status,200);
  const {entries,available}=await catalogue.json();
  assert.equal(available,true);
  const bossHud=entries.some(entry=>entry.source==='sample'&&entry.encounter==='boss-hud-lab');
  const skipped=bossHud?[]:['boss-hud-lab：当前战斗编辑器未提供此样例'];
  for(const reason of skipped)console.log('SKIP: '+reason);
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');
  cdp.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.exception?.description??e.exceptionDetails.text));
  cdp.on('Network.requestWillBeSent',e=>net.push(e.request.url));
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:scratch});
  await cdp.send('Page.navigate',{url:studio+'/?example=battle'});
  await wait("document.body?.dataset.ready==='true'&&document.querySelector('#title').value==='纸门值班室'");
  await click('#battlePanel summary');
  await set('#battleEditor [aria-label="工程中的战斗引用"]','gate_guard');
  assert.equal(await run("document.querySelector('#battleEditor [aria-label=\"饶恕后\"]').value"),'paper_spared');
  await shot('01-场景战斗绑定.png');
  await run("[...document.querySelectorAll('#battleEditor button')].find(b=>b.textContent==='编辑遭遇 ↗').click()");
  let tab;
  for(let i=0;i<120;i++){
    const list=await (await fetch('http://127.0.0.1:'+edge.debugPort+'/json/list')).json();
    tab=list.find(x=>x.url.includes('/encounter.html?file=paper-guard'));
    if(tab)break;
    await delay(100);
  }
  assert.ok(tab,'scene UI opened actual battle editor');
  const editor=await new CDP(tab.webSocketDebuggerUrl).connect();
  try{
    await wait("window.__drEncounterEditor?.store.fileName==='paper-guard.json'",14000,editor);
    const original=await evalOn(editor,'window.__drEncounterEditor.store.doc.meta.name');
    const renamed=original.endsWith('验收')?'折纸哨兵 · 改稿':'折纸哨兵 · 验收';
    await evalOn(editor,"window.__drEncounterEditor.store.setAt('meta.name',"+JSON.stringify(renamed)+");document.querySelector('#enc-btn-save').click()");
    await wait("window.__drEncounterEditor.store.doc.meta.name==="+JSON.stringify(renamed)+"&&!window.__drEncounterEditor.store.isDirty()",12000,editor);
    const saved=await (await fetch(new URL('/api/encounters/paper-guard.json',tab.url))).json();
    assert.equal(saved.meta.name,renamed);
    const revised=await jsonPost('/api/studio/battles/bundle',{battles:{fixture:{encounter:'paper-guard',source:'workspace'}}});
    assert.equal(revised.status,200);assert.equal(revised.data.entries[0].title,renamed);
    const clean='折纸哨兵 · 值班测试';
    await evalOn(editor,"window.__drEncounterEditor.store.setAt('meta.name',"+JSON.stringify(clean)+");document.querySelector('#enc-btn-save').click()");
    await wait("window.__drEncounterEditor.store.doc.meta.name==="+JSON.stringify(clean)+"&&!window.__drEncounterEditor.store.isDirty()",12000,editor);
    assert.equal((await (await fetch(new URL('/api/encounters/paper-guard.json',tab.url))).json()).meta.name,clean);
    savedBattleTitle=clean;
  }finally{
    editor.close();
    await fetch('http://127.0.0.1:'+edge.debugPort+'/json/close/'+tab.id);
  }
  const alias={encounter:'paper-guard',source:'workspace',lang:'zh'};
  const battles={first:alias,second:alias};
  if(bossHud)battles.lab={encounter:'boss-hud-lab',source:'sample'};
  const pack=await jsonPost('/api/studio/battles/bundle',{battles,offline:true});
  assert.equal(pack.status,200);
  assert.equal(pack.data.entries.length,bossHud?2:1);
  assert.equal(pack.data.byId.first,pack.data.byId.second);
  assert.equal(pack.data.entries[0].title,savedBattleTitle);
  if(bossHud){
    assert.ok(pack.data.entries[1].attacks['boss-hud-range'].soulProfiles.yellow);
    assert.ok(pack.data.entries[1].doc.settings.bossHud.widgets);
  }
  const missing=await jsonPost('/api/studio/battles/bundle',{battles:{x:{...alias,encounter:'missing'}}});
  assert.equal(missing.status,422);assert.equal(missing.data.issues[0].path,'battles.x.encounter');
  await click('#jsonPanel summary');await click('#validate');
  await wait("document.querySelector('#status').textContent.includes('战斗依赖校验通过')");
  await click('#play');await wait("document.body.classList.contains('playing')");
  await down('ArrowRight','ArrowRight');await wait("document.querySelector('.scene-battle-stage.in-battle')",14000);
  await up('ArrowRight','ArrowRight');
  await shot('02-编辑器内战斗.png');
  await tap('KeyX','x');
  // Confirm the fleeing hook, then wait for the scene branch. The same key must not auto-confirm the new scene text.
  for(let i=0;i<4&&await run("!document.querySelector('.scene-battle-stage').hidden");i++)await tap('KeyZ','z');
  await wait("document.querySelector('#status').textContent.includes('已返回场景 · 逃离')");
  await shot('03-返回原场景.png');
  await click('#editMode');
  await click('#eventPanel summary');
  await set('#eventEditor [aria-label="事件模板"]','对白后开战');
  await set('#eventEditor [aria-label="对白触发的战斗"]','gate_guard');
  await set('#eventEditor [aria-label="新事件 ID"]','qa_battle_dialogue');
  await run("[...document.querySelectorAll('#eventEditor button')].find(e=>e.textContent==='新建').click()");
  await wait("document.querySelector('#status').textContent.includes('qa_battle_dialogue')");
  await click('#refreshJson');
  assert.equal(await run("JSON.parse(document.querySelector('#document').value).events.qa_battle_dialogue[1].battle"),'gate_guard');
  await click('#save');await wait("document.querySelector('dialog').open");
  const saveId='battle-qa-'+Date.now();
  await set('dialog input',saveId);await click('dialog button[value=ok]');
  await wait("document.querySelector('#status').textContent.includes('已保存')");
  const stored=await (await fetch(studio+'/api/studio/projects/'+saveId)).json();
  assert.equal(stored.project.battles.gate_guard.on.spared,'paper_spared');
  await click('#exportHtml');
  await wait("document.querySelector('#status').textContent.includes('HTML 已导出')");
  const html=await download('纸门值班室-离线试玩.html');
  assert.ok(html.includes('type="importmap"')&&html.includes('data:audio/'));
  const file=path.join(out,'纸门值班室-离线试玩.html');await fs.writeFile(file,html);
  const netStart=net.length;
  await cdp.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
  await cdp.send('Page.navigate',{url:pathToFileURL(file).href+'?manual=1'});
  await wait("document.body?.dataset.ready==='true'");
  await run("window.__drAudioLog={active:true,events:[],fps:30,frame:0}");
  const advance=(hold=[],press=[],n=1)=>run('sceneGame.advance('+JSON.stringify({hold,press})+','+n+')');
  const world=()=>run("({tick:sceneGame.world.state.tick,player:sceneGame.world.state.player,battle:sceneGame.world.state.battle,last:sceneGame.world.state.lastBattle,dialogue:sceneGame.world.state.dialogue,room:sceneGame.world.state.room,flags:sceneGame.world.state.flags,inventory:sceneGame.world.state.inventory})");
  const records=[];
  for(const route of ['spared','victory','defeat','flee']){
    await run('sceneGame.reset()');
    if(route==='spared'){
      await advance(['up'],[],9);await advance(['act'],['act']);
      for(let i=0;i<12&&await run('!!sceneGame.world.state.dialogue');i++)await advance(['act'],['act']);
      assert.ok(await run('!!sceneGame.world.state.choice'));
      await advance(['act'],['act']);
    }else await advance(['right'],[],72);
    const before=await world();assert.ok(before.battle);
    assert.equal(before.battle.enemy,route==='spared'?null:'paper_guard');
    await run('sceneGame.battleReady.then(()=>true)');
    await advance(['right'],['act'],26);
    assert.equal((await world()).tick,before.tick);
    assert.equal((await world()).player.x,before.player.x);
    assert.ok(await run("document.querySelector('.scene-battle-stage').classList.contains('in-battle')"));
    let shotBattle=false;
    for(let i=0;i<1200;i++){
      const b=await run('sceneGame.battle?.getState()');
      if(!b)break;
      const h=battleMovement(b,route),p=battleControls(b,route).map(k=>k==='confirm'?'act':k);
      if(route==='spared'&&b.phase==='attack'&&b.battle?.bullets?.length>1&&!shotBattle){
        shotBattle=true;await shot('04-离线弹幕.png',true);
      }
      await advance(h,p);
    }
    const after=await world();
    assert.equal(after.last?.result,route);
    assert.equal(after.room,before.room);assert.equal(after.player.x,before.player.x);assert.equal(after.player.y,before.player.y);
    assert.equal(after.tick,before.tick);
    assert.equal(after.flags.gate_result,route);
    await advance();
    const returned=await world();assert.ok(returned.dialogue);
    assert.equal(returned.dialogue.age,0,'returned dialogue did not consume battle input');
    assert.equal(returned.inventory['通行纸']??0,Number(route==='victory'));
    assert.equal(returned.inventory['盖章值班单']??0,Number(route==='spared'));
    await advance([],[],20);
    await shot('05-离线结果-'+route+'.png',true);
    records.push({result:route,frame:after.last.frame,trigger:before.battle.enemy?'touch':'dialogue',room:after.room,x:after.player.x,y:after.player.y});
  }
  const bgm=await run("__drAudioLog.events.filter(e=>e.type==='bgm').map(e=>({name:e.name,action:e.action,instance:e.instance}))");
  assert.deepEqual(bgm.map(e=>e.action),Array.from({length:4},()=>['play','stop']).flat());
  await run('sceneGame.reset()');
  await advance(['right'],[],72);
  assert.ok((await world()).battle);
  await run('(()=>{const ready=sceneGame.battleReady;sceneGame.reset();return ready.then(()=>true);})()');
  assert.equal((await world()).battle,null);
  assert.equal((await world()).tick,0);
  assert.ok(await run("document.querySelector('.scene-battle-stage').hidden"));
  assert.equal(net.slice(netStart).filter(u=>/^https?:/i.test(u)).length,0);
  assert.deepEqual(errors,[]);
  const report={ok:true,engine:'actual encounters',browser:edge.browser,tests:['battle-link','original editor save','refresh saved battle','event template','workspace dependency check','missing dependency diagnostic','bundle dedupe','live keyboard','offline no-network','scene freeze','four real outcomes','reset during load'],skipped,records,bgm};
  await fs.writeFile(path.join(out,'浏览器验收.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}catch(ex){
  await shot('失败画面.png').catch(()=>{});
  console.error('Browser errors:',errors);throw ex;
}finally{await edge.close();}
