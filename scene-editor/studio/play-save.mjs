import {saveKeyFor,decodeSave} from './campaign.mjs';
import {PLAY_UI_CSS} from './play-ui-style.mjs';
import {setDefeatFrame,watchSystemKit} from './ui-system.mjs';
import {UI_SOUNDS,UI_VOICES} from './ui-kit.mjs';

const defeatKeys={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',
  KeyW:'up',KeyS:'down',KeyA:'left',KeyD:'right',KeyZ:'act',Enter:'act',NumpadEnter:'act',Space:'act',KeyX:'cancel',Escape:'cancel'};
const systemSoundNames=[...Object.values(UI_SOUNDS),UI_VOICES.susie,UI_VOICES.ralsei];

export function mountSaveControls(canvas,project,{getWorld,load,restart,continueScene,onError,temporary=false}){
  const key=saveKeyFor(project),storageKey=key&&!temporary?'director.play-save/'+key:null;
  const frame=canvas.parentElement,controls=frame.parentElement.querySelector('.touch');
  const mute=canvas.closest('main')?.querySelector('#mute');
  const events=new AbortController(),options={signal:events.signal};
  let save=null,world=null,disconnect=null,audio=null,kit=null,preload=null,activated=false;

  const style=document.createElement('style');
  style.textContent=PLAY_UI_CSS;
  document.head.append(style);
  const bar=document.createElement('div');bar.className='play-savebar play-developer';bar.hidden=!key;
  bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','试玩存档工具');
  const loadBtn=button('读取存档'),exportBtn=button('导出试玩档'),importBtn=button('导入试玩档');
  const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.hidden=true;
  bar.append(loadBtn,exportBtn,importBtn,input);
  frame.after(bar);

  const toolButton=controls?.querySelector('[data-key="tool"]'),toolLabel=toolButton?.textContent;
  const menuButton=button('C');
  menuButton.dataset.key='menu';menuButton.title='打开或关闭菜单（C）';
  if(toolButton){
    toolButton.before(menuButton);
    toolButton.textContent='工具';
  }else controls?.lastElementChild?.append(menuButton);

  function button(text){
    const b=document.createElement('button');b.type='button';b.textContent=text;return b;
  }
  function unsafe(){
    const s=getWorld()?.state;
    return !!(s?.battle||s?.saveRequest||s?.defeat);
  }
  function refresh(){
    const current=getWorld();
    if(current!==world){
      disconnect?.();world=current;
      disconnect=world?.connectSystemUi({playSound,resolveDefeat});
    }
    const blocked=unsafe();
    loadBtn.disabled=!save||blocked;exportBtn.disabled=!save;
    importBtn.disabled=blocked;
  }
  function readStored(){
    if(!storageKey)return;
    try{
      const text=localStorage.getItem(storageKey);
      if(text)save=decodeSave(project,JSON.parse(text));
    }catch(error){onError(error);}
  }
  function remember(doc){
    save=doc;refresh();
    if(!storageKey)return;
    try{localStorage.setItem(storageKey,JSON.stringify(doc));}
    catch(error){onError(new Error('已记录本次试玩；浏览器无法持久保存，请导出试玩档。'));}
  }
  function restore(){if(save){load(save);refresh();}}
  function showLoss(){
    const current=getWorld(),defeat=current.state.defeat;
    if(defeat)setDefeatFrame(defeat,frame.querySelector('.scene-battle-canvas'));
    refresh();
  }
  function resolveDefeat(action){
    const owner=world,defeat=owner.state.defeat;
    // Let the current simulation frame finish before replacing or restoring its world.
    queueMicrotask(()=>{
      if(events.signal.aborted||owner!==getWorld()||owner.state.defeat!==defeat)return;
      if(action==='continue'&&save)restore();
      else if(action==='stay'){continueScene();refresh();}
      else{restart();refresh();}
    });
  }

  function unlockAudio(){
    activated=true;
    if(!audio||mute?.checked)return;
    void audio.unlock();
    preload??=audio.preload(systemSoundNames);
  }
  function playSound(name){
    if(!audio||!activated||mute?.checked)return;
    if(audio.play(name,{restart:true}))return;
    const current=audio;
    preload?.then(()=>{
      if(audio===current&&!events.signal.aborted)current.play(name,{restart:true});
    });
  }
  const unwatch=watchSystemKit(canvas,value=>{
    if(value===kit)return;
    audio?.dispose();kit=value;preload=null;
    audio=kit.createAudio({isMuted:()=>!!mute?.checked});
    if(activated)unlockAudio();
  });
  mute?.addEventListener('change',()=>{
    audio?.setMuted(mute.checked);
    if(!mute.checked)unlockAudio();
  },options);
  window.addEventListener('keydown',e=>{
    const k=defeatKeys[e.code];
    if(e.metaKey||e.altKey||e.ctrlKey||e.shiftKey&&e.code==='Escape')return;
    if(e.target instanceof Element&&e.target.closest('input,select,textarea,[contenteditable=true]'))return;
    if(!k&&e.code!=='KeyC')return;
    unlockAudio();
    const current=getWorld();
    if(!current.state.defeat||!k)return;
    e.preventDefault();
    if(!e.repeat)current.pressDefeat(k);
  },options);
  canvas.addEventListener('pointerdown',unlockAudio,options);
  controls?.addEventListener('pointerdown',e=>{
    const k=e.target.closest('button[data-key]')?.dataset.key;
    if(!k)return;
    unlockAudio();
    const current=getWorld();
    if(!current.state.defeat)return;
    e.preventDefault();current.pressDefeat(k);
  },options);

  loadBtn.onclick=()=>{if(!unsafe())restore();};
  importBtn.onclick=()=>input.click();
  input.onchange=async()=>{
    const [file]=input.files;input.value='';
    if(!file)return;
    try{
      if(file.size>8*1024*1024)throw new Error('试玩档超过 8 MiB');
      const doc=decodeSave(project,JSON.parse((await file.text()).replace(/^\uFEFF/,'')));
      if(events.signal.aborted||unsafe())return;
      remember(doc);restore();
    }catch(error){if(!events.signal.aborted)onError(error);}
  };
  exportBtn.onclick=()=>{
    const uri=URL.createObjectURL(new Blob([JSON.stringify(save,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=uri;a.download='scene-save-'+key+'.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(uri),1000);
  };
  readStored();refresh();
  return {
    remember,refresh,showLoss,get save(){return save;},restore,
    destroy(){
      events.abort();disconnect?.();unwatch();audio?.dispose();style.remove();bar.remove();menuButton.remove();
      if(toolButton)toolButton.textContent=toolLabel;
    }
  };
}
