
import {projectPlugins,invoke} from './plugins.mjs';
import {HZ,isPlatformMode} from './format.mjs';
import {hasTrailerPlayback} from './trailer-script.mjs';
import {createWorld} from './world.mjs';
import {drawScene} from './view.mjs';
import {UI_SOUNDS,UI_VOICES} from './ui-kit.mjs';
import {prepareArt} from './resources.mjs';
import {createBattleStage,prepareBattlePlayer,toEncounterInput} from './battle-player.mjs';
import {prepareEntry,transitionFor} from './transition.mjs';
import {mountSaveControls} from './play-save.mjs';

const KEYS={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',
  KeyW:'up',KeyS:'down',KeyA:'left',KeyD:'right',KeyZ:'act',Enter:'act',NumpadEnter:'act',Space:'act',KeyX:'cancel',KeyC:'menu',KeyV:'dash',Escape:'cancel'};
export const trailerControls=(mode,p)=>projectPlugins(p).modes.get(mode)?.hooks.help;
const focusTyping=target=>target instanceof Element&&target.closest('input,select,textarea,[contenteditable=true]');
const TRANSITION=7;
const battleLabels={victory:'胜利',spared:'饶恕',defeat:'落败',flee:'逃离'};
const rhythmSounds={beat:'rhythm_battle_snare',hit:'snd_guitarpickup1',miss:'snd_guitarerror'};

export function mountPlayer(canvas,project,art,{controls,manual=false,onFrame,onExit,onBattle,onError,nav=null,audio=true,battles=null,temporary=false,autoplay=false}={}){
  const plugins=projectPlugins(project);
  const context=canvas.getContext('2d'),held=new Map(),pressed=new Set(),suppressed=new Set();
  const stage=battles?createBattleStage(canvas):null;
  let world,raf,removed=false,last=performance.now(),acc=0,sound,muted=!audio,session=null,saveUi=null;
  // Dialogue and choice cues share the playground's AudioContext.
  let dialogueAudio, autoTrailer=autoplay;
  function preloadDialogueAudio(){
    if(dialogueAudio||removed||!art.ui||!sound)return;
    dialogueAudio=art.ui.createAudio({getContext:()=>sound,isMuted:()=>muted});
    void dialogueAudio.preload(Object.values(UI_VOICES));
  }
  const onDialogueSound=name=>dialogueAudio?.play(name,{restart:true});
  if(!art.ui&&art.loadUiKit)art.loadUiKit().then(kit=>{
    art.ui=kit;preloadDialogueAudio();prepareMinigameAudio();
    if(!removed&&world)paint();
  }).catch(error=>console.warn('UI kit unavailable',error));
  let minigameAudio;
  function prepareMinigameAudio(){
    if(minigameAudio||!sound||!art.ui)return;
    minigameAudio=art.ui.createAudio({getContext:()=>sound,isMuted:()=>muted});
    void minigameAudio.preload([...Object.values(rhythmSounds),'snd_tensionhorn']);
  }
  function unlock(){
    if(muted)return;
    if(session){session.player?.unlock();return;}
    if(!window.AudioContext)return;
    sound??=new AudioContext();
    if(sound.state==='suspended')sound.resume().catch(()=>{});
    preloadDialogueAudio();
  }
  function keydown(e){
    if(focusTyping(e.target))return;
    if(e.code==='Escape'&&onExit&&e.shiftKey){e.preventDefault();onExit();return;}
    if(world.state.defeat)return;
    const {mode,locked,menu}=world.state;
    const shift=e.code==='ShiftLeft'||e.code==='ShiftRight';
    let k=KEYS[e.code];
    if(session)k=battles.keys[e.code]??(shift?'slow':k);
    else if(plugins.modes.has(mode)){
      if(shift&&plugins.modes.get(mode).hooks.toolKey)k='dash';
      if(!locked&&!menu)k=plugins.modes.get(mode).hooks.keys?.[e.code]??k;
    }
    if(!k||e.ctrlKey||e.altKey||e.metaKey)return;
    if((e.code==='Enter'||e.code==='Space')&&e.target instanceof HTMLButtonElement)return;
    if(e.repeat&&suppressed.has(e.code))return;
    takeOver();
    e.preventDefault();unlock();
    if(suppressed.has(e.code))return;
    if(!e.repeat&&!held.has(e.code)){
      held.set(e.code,k);
      pressed.add(k);
    }
  }
  function keyup(e){held.delete(e.code);suppressed.delete(e.code);}
  function flushInput(){
    for(const code of held.keys())if(typeof code==='string')suppressed.add(code);
    held.clear();pressed.clear();
  }
  function clear(){
    held.clear();pressed.clear();suppressed.clear();acc=0;
  }
  function startTrailerScript(){
    if(nav?.active)nav.stop();
    flushInput();autoTrailer=true;
    return world.startTrailerScript();
  }
  function stopTrailerScript(){
    autoTrailer=false;world.stopTrailerScript();
  }
  function takeOver(){
    if(nav?.active)nav.stop('已手动接管。');
    if(world.trailerStatus())stopTrailerScript();
  }
  const loading=new Map(), loadFailed=new Set();
  function roomReady(){
    const key=world.state.room;
    if(!art.loadRoom||art.loadedRooms?.has(key)||loadFailed.has(key))return true;
    if(!loading.has(key))loading.set(key,art.loadRoom(key).catch(error=>{
      loadFailed.add(key);reportError(error);
    }).finally(()=>{loading.delete(key);if(!removed)paint();}));
    return false;
  }
  function paint(){
    const {mode}=world.state;
    controls?.classList.toggle('platform-controls',(isPlatformMode(mode,project)||plugins.modes.get(mode)?.hooks.toolKey)&&!session);
    controls?.classList.toggle('dungeon-controls',!!plugins.modes.get(mode)?.hooks.keys?.KeyF&&!session);
    if(!session&&roomReady())drawScene(context,project,world.state.room,art,{state:{...world.state,entities:world.entities()}});
  }
  function attachStage(view){
    stage.root.hidden=!view;stage.canvas.hidden=view!=='battle';stage.entry.hidden=view!=='entry';canvas.style.visibility=view?'hidden':'';
    stage.root.classList.toggle('in-battle',view==='battle');
    stage.root.classList.toggle('in-entry',view==='entry');
  }
  function reportError(error){
    if(onError)onError(error);
    else console.error(error);
  }
  function leave(){
    if(!session)return;
    const b=session;
    session=null;b.controller.abort();b.player?.dispose();
    attachStage(null);
    stage.curtain.hidden=true;
    stage.root.classList.remove('in-battle');
    if(controls)controls.classList.remove('combat-controls');
    flushInput();
  }
  function handleBattleError(b,error){
    if(session!==b)return;
    world.abortBattle(b.request.serial);
    leave();paint();canvas.focus({preventScroll:true});
    onBattle?.(null);saveUi.refresh();
    reportError(error);
  }
  function beginBattle(request){
    if(nav?.active)nav.stop('已进入战斗，请接管。');
    if(!battles){world.abortBattle(request.serial);reportError(new Error('当前试玩缺少战斗资源'));return;}
    const config=transitionFor(project,project.battles[request.id]);
    const b={request,config,controller:new AbortController(),player:null,started:false,entryAge:0,returning:null,result:null};
    session=b;flushInput();saveUi.refresh();
    attachStage('entry');stage.curtain.hidden=true;stage.label.textContent='';
    b.entry=prepareEntry(stage,canvas,project,world,art,request,config,name=>minigameAudio?.play(name));
    b.entry.render(null,0,Math.max(1,config.ticks));
    onBattle?.({phase:'loading',request});
    b.ready=battles.mount(request.id,stage.canvas,muted,{
      signal:b.controller.signal,project,state:world.state,
      onEnd:result=>{b.result=result;},
      onError:error=>queueMicrotask(()=>handleBattleError(b,error))
    }).then(player=>{
      if(session!==b){player.dispose();return;}
      b.player=player;player.mute(muted);
    }).catch(error=>handleBattleError(b,error));
  }
  function finishBattle(b){
    const outcome=b.result;
    world.completeBattle(b.request.serial,outcome);
    leave();paint();canvas.focus({preventScroll:true});
    if(world.state.defeat)saveUi.showLoss();else saveUi.refresh();
    onBattle?.({phase:'result',request:b.request,outcome});
    onFrame?.(world.state);
  }
  function battleStep(input){
    const b=session;
    if(b.returning!==null){
      const progress=++b.returning/TRANSITION;
      stage.curtain.style.opacity=String(Math.min(1,progress));
      if(progress>=1)finishBattle(b);
      return;
    }
    if(!b.started){
      const config=b.config;
      const ticks=config.style==='instant'?0:config.ticks;
      if(!b.player)return;
      if(b.entryAge<ticks){
        b.entry.render(b.player,++b.entryAge,ticks);
        return;
      }
      b.started=true;flushInput();attachStage('battle');
      stage.curtain.hidden=true;
      stage.label.textContent='';
      controls?.classList.add('combat-controls');
      stage.canvas.focus({preventScroll:true});
      onBattle?.({phase:'battle',request:b.request,title:b.player.title});
      b.player.encounter.step(1,toEncounterInput({}));
    }else b.player.encounter.step(1,toEncounterInput(input));
    if(b.result){
      b.returning=0;flushInput();
      stage.curtain.hidden=false;stage.curtain.style.opacity='0';
      stage.label.textContent=battleLabels[b.result.result]+' · 返回场景';
      b.player.mute(true);
      onBattle?.({phase:'return',request:b.request,outcome:b.result});
    }
  }
  function step(input){
    if(session){battleStep(input);return;}
    if(!roomReady())return;
    prepareMinigameAudio();
    if(nav?.active&&!world.trailerStatus())input=nav.step(world);
    const previousSaveRequest=world.state.saveRequest;
    const previousRhythmAge=world.state.rhythm?.age,previousFeedback=world.state.rhythm?.feedback;
    const s=world.step(input);
    const saved=world.takeSave();
    if(saved)saveUi.remember(saved);
    if(s.saveRequest!==previousSaveRequest)saveUi.refresh();
    const rhythm=s.rhythm;
    if(minigameAudio&&rhythm&&rhythm.age!==previousRhythmAge){
      if(rhythm.beats.some(beat=>beat.at===rhythm.age))
        minigameAudio.play(rhythmSounds.beat,{volume:.46,restart:true});
      if(rhythm.feedback&&rhythm.feedback!==previousFeedback)
        minigameAudio.play(rhythm.feedback.ok?rhythmSounds.hit:rhythmSounds.miss,{volume:.62,restart:true});
    }
    if(s.battle)beginBattle(s.battle);
    onFrame?.(s);
  }
  function frame(now){
    if(removed)return;
    acc+=Math.min(now-last,100);last=now;
    while(acc>=1000/HZ){
      step({hold:[...held.values(),...pressed],press:pressed});
      pressed.clear();acc-=1000/HZ;
    }
    paint();raf=requestAnimationFrame(frame);
  }
  function reset(){
    if(nav?.active)nav.stop();
    leave();world?.dispose();world=createWorld(project,{validated:true,onDialogueSound,autoplay:autoTrailer});
    canvas.width=world.viewport.w;canvas.height=world.viewport.h;
    canvas.style.setProperty('--aspect',world.viewport.w+' / '+world.viewport.h);
    stage?.root.style.setProperty('--scene-ratio',String(canvas.width/canvas.height));
    onFrame?.(world.state);
    flushInput();paint();onBattle?.(null);saveUi?.refresh();
  }
  function applySave(save){
    if(nav?.active)nav.stop();
    leave();world.restoreSave(save);flushInput();paint();onFrame?.(world.state);
    canvas.focus({preventScroll:true});saveUi.refresh();
  }
  function restartFromMenu(){reset();canvas.focus({preventScroll:true});}
  function continueScene(){world.continueDefeat();flushInput();paint();onFrame?.(world.state);canvas.focus({preventScroll:true});}

  function pointerDown(e){
    const button=e.target.closest('button[data-key]');
    if(!button||world.state.defeat)return;
    takeOver();
    e.preventDefault();button.setPointerCapture(e.pointerId);
    const key=button.dataset.key;
    const k=!session&&plugins.modes.get(world.state.mode)?.hooks.keys?.KeyX==='run'&&!world.state.locked&&key==='cancel'?'run':key;
    held.set(e.pointerId,k);pressed.add(k);unlock();
  }
  function pointerUp(e){held.delete(e.pointerId);}
  function pause(){cancelAnimationFrame(raf);raf=null;clear();}
  function resume(){if(manual||removed||raf)return;last=performance.now();raf=requestAnimationFrame(frame);}
  function destroy(){
    removed=true;world.dispose();leave();stage?.root.remove();saveUi.destroy();pause();
    if(window.__ch6Trailer===debug)delete window.__ch6Trailer;
    document.removeEventListener('visibilitychange',clear);
    window.removeEventListener('keydown',keydown);window.removeEventListener('keyup',keyup);window.removeEventListener('blur',clear);
    canvas.removeEventListener('pointerdown',unlock);stage?.canvas.removeEventListener('pointerdown',unlock);
    controls?.removeEventListener('pointerdown',pointerDown);controls?.removeEventListener('pointerup',pointerUp);
    controls?.removeEventListener('pointercancel',pointerUp);controls?.removeEventListener('lostpointercapture',pointerUp);
    dialogueAudio?.dispose();minigameAudio?.dispose();sound?.close().catch(()=>{});
  }
  if(navigator.userActivation?.hasBeenActive)unlock();
  reset();
  saveUi=mountSaveControls(canvas,project,{getWorld:()=>world,load:applySave,restart:restartFromMenu,continueScene,onError:reportError,temporary});
  if(battles)for(const id of Object.keys(project.battles))battles.warm(id).catch(()=>{});
  window.addEventListener('keydown',keydown);window.addEventListener('keyup',keyup);window.addEventListener('blur',clear);
  canvas.addEventListener('pointerdown',unlock);stage?.canvas.addEventListener('pointerdown',unlock);
  document.addEventListener('visibilitychange',clear);
  controls?.addEventListener('pointerdown',pointerDown);controls?.addEventListener('pointerup',pointerUp);
  controls?.addEventListener('pointercancel',pointerUp);controls?.addEventListener('lostpointercapture',pointerUp);
  function advance(input,n=1){
    for(let i=0;i<n;i++)step(i===0?input:{hold:input?.hold});
    paint();
  }
  function trailerStatus(){
    const {tick,room,mode,player,director,flags}=world.state;
    return {tick,room,mode,player:{x:player.x,y:player.y,face:player.face},flags:{...flags},script:world.trailerStatus(),
      fx:director?structuredClone(director):null,
      ...Object.fromEntries([...plugins.modes].filter(([,m])=>m.hooks.debug).map(([id,m])=>
        [id,world.state[id]?invoke(m,'debug',{local:world.state[id]}):null]))};
  }
  const debug=autoplay||hasTrailerPlayback(project)?{
    hz:HZ,canvas,
    start:startTrailerScript,
    stop:stopTrailerScript, pause,resume,reset,status:trailerStatus,
    advance(ticks=1,input){
      if(!Number.isInteger(ticks)||ticks<1||ticks>3600)throw new RangeError('ticks must be an integer between 1 and 3600');
      pause();advance(input,ticks);return trailerStatus();
    }
  }:null;
  if(debug)window.__ch6Trailer=debug;
  resume();
  return {get world(){return world;},get battle(){return session?.player?.encounter??null;},
    get battleReady(){return session?.ready;},get save(){return saveUi.save;},loadSave:()=>saveUi.restore(),
    reset,destroy,pause,resume,startTrailerScript,stopTrailerScript,advance,
    mute(value){muted=value;if(session&&!session.returning)session.player?.mute(value);unlock();}};
}

export const BATTLE_HELP='方向键移动 · Z 确认 · X 取消 / 慢速 · V 冲刺 · B 射击';
export async function offlinePlayer(project,pack,battlePack=null){
  document.title=project.title+' · DELTARUNE 场景';
  document.getElementById('title').textContent=project.title;
  const canvas=document.querySelector('canvas'),status=document.getElementById('status');
  const help='← ↑ ↓ → 移动　Z 互动 / 长按　X 回检查点';
  try{
    const [art,battles]=await Promise.all([prepareArt(project,pack),prepareBattlePlayer(battlePack,{offline:true})]);
    const params=new URLSearchParams(location.search);
    const manual=params.get('manual')==='1',autoplay=params.get('autoplay')==='1';
    status.textContent=art.unresolved.length?'部分内嵌素材无法解码。':trailerControls(project.rooms[project.start.room].mode,project)??help;
    const game=mountPlayer(canvas,project,art,{controls:document.querySelector('.touch'),manual,autoplay,battles,
      onBattle:b=>{if(b)status.textContent=b.phase==='battle'?BATTLE_HELP:b.phase==='loading'?'准备遭遇战…':help;},
      onFrame:s=>{if(!s.battle&&!art.unresolved.length)status.textContent=trailerControls(s.mode,project)??help;},
      onError:error=>{status.textContent='试玩出错：'+error.message;},
    });
    document.getElementById('restart').onclick=()=>{game.reset();canvas.focus();};
    document.getElementById('mute').onchange=e=>game.mute(e.currentTarget.checked);
    canvas.focus();
    if(manual)window.sceneGame=game;
    document.body.dataset.ready='true';
  }catch(ex){status.textContent='无法启动：'+ex.message;}
}
