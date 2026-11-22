
import {connectParty} from './campaign.mjs';

export async function prepareBattlePack(project,{offline=false,checkOnly=false,signal}={}){
  if(!Object.keys(project.battles??{}).length)return null;
  const response=await fetch('/api/studio/battles/bundle',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({battles:project.battles,offline,checkOnly,campaign:project.campaign,battleTransition:project.battleTransition}),signal
  });
  const payload=await response.json();
  if(!response.ok)throw Object.assign(new Error(payload.issues?.[0]?.message??payload.error??('战斗加载失败 · HTTP '+response.status)),{issues:payload.issues});
  return payload;
}

const battleModules=[
  'assets.js','audio.js','encounter/index.js','soul-mechanics.js'
];
let engineModules;
async function openBattleEngine(offline){
  return engineModules??=Promise.all(battleModules.map(k=>import((offline?'http://dr.local/engine/':'/battle-engine/')+k)))
    .catch(error=>{engineModules=null;throw error;});
}

export async function prepareBattlePlayer(pack,{offline=false}={}){
  if(!pack||!pack.entries.length)return null;
  const [{loadAssets},audio,engine,{soulActionBindings}]=await openBattleEngine(offline);
  const keys=Object.fromEntries(soulActionBindings().map(a=>[a.code,a.id]));
  const stores=new Map();
  function getAssets(entry){
    if(stores.has(entry))return stores.get(entry);
    const index=URL.createObjectURL(new Blob([JSON.stringify(entry.assets)],{type:'application/json'}));
    const ready=loadAssets(index).then(async a=>{
      if(a.error)throw a.error;
      await Promise.all([a.preloadFonts(entry.fonts),a.preload()]);
      return a;
    }).finally(()=>URL.revokeObjectURL(index)).catch(error=>{stores.delete(entry);throw error;});
    stores.set(entry,ready);
    return ready;
  }
  return {
    keys,
    warm(id){return getAssets(pack.entries[pack.byId[id]]);},
    async mount(id,canvas,muted,{signal,onEnd,onError,project,state}){
      const entry=pack.entries[pack.byId[id]];
      const transfer=connectParty(project,project.battles[id],entry.doc,state.party,state.inventory);
      if(transfer.doc!==entry.doc&&transfer.doc.party.length&&!transfer.doc.party.some(p=>(p.hp??p.maxHp??100)>0))
        throw new Error('出战队员都已倒下；请在存档点恢复或读取试玩档。');
      const assets=await getAssets(entry);
      signal.throwIfAborted();
      const sound=audio.createAudio(assets);
      const encounter=engine.createEncounter({canvas,assets,audio:sound,externalInput:true,
        resolveAttack:name=>Object.hasOwn(entry.attacks,name)?entry.attacks[name]:null});
      const dispose=()=>{encounter.destroy();sound.stopBgm(0);sound.destroy();};
      try{
        encounter.setOptions({lang:entry.lang,muted,scale:1});
        encounter.on('end',result=>onEnd({...result,progress:transfer.sync(encounter.partyState())}));
        encounter.on('error',payload=>{if(payload.path==='flow'||payload.path==='render')onError(new Error(payload.message));});
        const loaded=await encounter.load(transfer.doc);
        signal.throwIfAborted();
        if(loaded.errors.length||encounter.debug.missingAttacks.length||encounter.debug.flowUnavailable){
          const issue=loaded.errors[0];
          throw new Error(issue?issue.path+'：'+issue.message:'战斗引擎未能加载流程或引用的攻击');
        }
        return {encounter,dispose,title:entry.title,unlock:()=>sound.unlock(),mute:value=>encounter.setOptions({muted:value}),
          impact(){sound.play('snd_impact',{volume:.66});sound.play('snd_weaponpull_fast',{volume:.54});}};
      }catch(ex){dispose();throw ex;}
    }
  };
}

export function createBattleStage(canvas){
  const root=document.createElement('div');
  root.className='scene-battle-stage';root.hidden=true;
  const combat=document.createElement('canvas');
  combat.className='scene-battle-canvas';combat.width=640;combat.height=480;combat.hidden=true;
  combat.tabIndex=0;combat.setAttribute('aria-label','战斗画布');
  const curtain=document.createElement('div');curtain.className='scene-battle-curtain';
  curtain.hidden=true;
  const label=document.createElement('span');label.setAttribute('role','status');
  curtain.append(label);
  const entry=document.createElement('canvas');
  entry.className='scene-battle-entry';entry.width=640;entry.height=480;entry.hidden=true;
  entry.tabIndex=0;entry.setAttribute('aria-label','入战演出');
  root.append(combat,entry,curtain);canvas.after(root);
  return {root,canvas:combat,entry,curtain,label};
}

const battleAction=k=>k==='act'?'confirm':k;
export function toEncounterInput(input){
  const hold=Object.fromEntries(Array.from(input.hold??[],k=>[battleAction(k),true]));
  const press=Array.from(input.press??[],battleAction);
  if(hold.cancel)hold.slow=true;
  if(press.includes('cancel')&&!press.includes('slow'))press.push('slow');
  return {hold,press};
}
