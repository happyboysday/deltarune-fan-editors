
import {modeNames} from './format.mjs';

const SAVED_FORMAT='deltarune-scene-save/1';

export function saveKeyFor(p){
  if(!p.campaign?.saveKey&&!Object.values(p.rooms).some(r=>(r.entities??[]).some(e=>e.kind==='savepoint')))return null;
  const raw=JSON.stringify(p.id?[p.id,p.start.room]:[p.title,...Object.keys(p.rooms)]);
  let hash=2166136261;
  for(const c of raw)hash=Math.imul(hash^c.codePointAt(0),16777619);
  return p.campaign?.saveKey??'scene-'+(hash>>>0).toString(16);
}

export function initialParty(project){
  return Object.assign(Object.create(null),Object.fromEntries(Object.entries(project.campaign?.party??{}).map(([id,p])=>
    [id,{name:p.name??id,maxHp:p.maxHp,hp:p.hp??p.maxHp}])));
}

export function isSharedBattle(project,ref){
  return ref.carry!=='isolated'&&(ref.carry==='inherit'||!!project.campaign?.party||!!project.campaign?.items);
}

function bindings(map,id,otherwise){
  return map&&Object.hasOwn(map,id)?map[id]:otherwise;
}

export function connectParty(project,ref,source,roster,inventory){
  if(!isSharedBattle(project,ref))return {doc:source,sync:()=>null};
  const partyLinks=new Map(),itemLinks=new Map(),members=new Set(),itemsUsed=new Set();
  const party=(source.party??[]).map((p,index)=>{
    const id=p.id??'party'+index;
    const k=bindings(ref.partyMap,id,Object.hasOwn(roster,id)?id:null);
    if(k===null)return p;
    if(!Object.hasOwn(roster,k))throw new Error('共享成员不存在：'+k);
    if(members.has(k))throw new Error('战斗中多个队员映射到 '+k);
    members.add(k);partyLinks.set(id,k);
    return {...p,id,hp:roster[k].hp,maxHp:roster[k].maxHp};
  });
  const items=(source.items??[]).map((a,index)=>{
    const id=a.id??'item'+index,k=bindings(ref.itemMap,id,id);
    if(k===null)return a;
    if(itemsUsed.has(k))throw new Error('战斗中多个道具映射到 '+k);
    itemsUsed.add(k);itemLinks.set(id,k);
    return {...a,id,count:Object.hasOwn(inventory,k)?inventory[k]:0};
  });
  for(const [id,info] of Object.entries(project.campaign?.items??{})){
    // An explicitly local item using the same ID takes the encounter's slot.
    if(itemsUsed.has(id)||items.some((a,i)=>(a.id??'item'+i)===id))continue;
    items.push({...info,id,count:Object.hasOwn(inventory,id)?inventory[id]:0});itemLinks.set(id,id);
  }
  const doc={...source,party,items};
  return {doc,sync(state){
    const hp=Object.create(null),counts=Object.create(null);
    for(const {id,hp:value} of state.party)if(partyLinks.has(id))hp[partyLinks.get(id)]=value;
    for(const {id,count} of state.items)if(itemLinks.has(id))counts[itemLinks.get(id)]=count;
    return {hp,items:counts};
  }};
}

export function encodeSave(project,point,snapshot){
  return {format:SAVED_FORMAT,project:saveKeyFor(project),point:{id:point.id,name:point.name},snapshot};
}

const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const integer=(v,min,max)=>Number.isInteger(v)&&finite(v,min,max);
const dictState=(v,check)=>object(v)&&Object.keys(v).length<=60000&&Object.entries(v).every(([k,x])=>
  !['__proto__','constructor','prototype'].includes(k)&&check(x,k));

export function decodeSave(project,data){
  function fail(reason){throw new Error('无法读取存档：'+reason);}
  if(!object(data)||data.format!==SAVED_FORMAT||!data.project||data.project!==saveKeyFor(project))fail('档案不属于本工程');
  const {point,snapshot:s}=data;
  if(!object(point)||typeof point.id!=='string'||typeof point.name!=='string'||point.name.length>160||!object(s))fail('档案字段缺失');
  if(s.rngState!==undefined&&!integer(s.rngState,0,0xffffffff))fail('随机数状态无效');
  const room=Object.hasOwn(project.rooms,s.room)?project.rooms[s.room]:null;
  if(!room)fail('档案的房间已不存在');
  const e=(room.entities??[]).find(e=>e.kind==='savepoint'&&e.id===point.id);
  if(!e)fail('这个存档点已不在当前工程');
  const switches=new Set((room.entities??[]).filter(e=>e.kind==='switch').map(e=>e.id));
  if(s.pressedSwitches!==undefined&&(!Array.isArray(s.pressedSwitches)
    ||s.pressedSwitches.length>switches.size||s.pressedSwitches.some(id=>!switches.has(id))))fail('存档的踏板状态无效');
  const r=project.player?.radius??6;
  const player=s.player;
  if(!object(player)||!finite(player.x,r,room.w-r)||!finite(player.y,r,room.h-r)
    ||!['up','down','left','right'].includes(player.face)
    ||player.sprite!==undefined&&!Object.hasOwn(project.assets??{},player.sprite))fail('玩家位置或外观无效');
  if(!object(s.camera)||!finite(s.camera.x,-16384,16384)||!finite(s.camera.y,-16384,16384)||typeof s.camera.follow!=='boolean')fail('镜头无效');
  if(!modeNames(project).includes(s.mode)||!integer(s.maxGrip,0,3600)||!integer(s.grip,0,s.maxGrip))fail('移动状态无效');
  if(!dictState(s.flags,v=>typeof v==='string'||typeof v==='boolean'||Number.isFinite(v))
    ||!dictState(s.inventory,v=>integer(v,0,999999))
    ||!dictState(s.used,v=>v===true)||!Array.isArray(s.switchFlags)||!s.switchFlags.every(v=>typeof v==='string'))fail('物品或剧情状态无效');
  const authored=new Set(Object.keys(project.campaign?.party??{}));
  if(!dictState(s.party,(hp,id)=>authored.has(id)&&object(hp)&&integer(hp.hp,0,hp.maxHp)&&integer(hp.maxHp,1,9999))
    ||Object.keys(s.party).length!==authored.size)fail('存档的队伍配置和工程不同');
  const entities=new Map(Object.values(project.rooms).flatMap(r=>(r.entities??[]).map(e=>[e.id,r])));
  if(!dictState(s.changed,(v,id)=>{
    const room=entities.get(id);
    return object(v)&&room&&Object.entries(v).every(([k,x])=>k==='hidden'&&typeof x==='boolean'||k==='sprite'&&Object.hasOwn(project.assets??{},x)
      ||k==='x'&&finite(x,0,room.w)||k==='y'&&finite(x,0,room.h));
  }))fail('存档的场景物件已发生变化');
  if(!Array.isArray(s.timers)||s.timers.length>1024||s.timers.some(t=>!object(t)||!integer(t.delay,0,108000)
    ||t.room!==null&&!Object.hasOwn(project.rooms,t.room)||!Object.hasOwn(project.events??{},t.event)))fail('计时事件无效');
  if(s.pending!==undefined&&(!Array.isArray(s.pending)||s.pending.length>60000||s.pending.some(id=>typeof id!=='string'
    ||!Object.hasOwn(project.events??{},id))))fail('待执行事件无效');
  if(s.lastBattle!==null&&(!object(s.lastBattle)||!Object.hasOwn(project.battles??{},s.lastBattle.id)
    ||!['victory','spared','defeat','flee'].includes(s.lastBattle.result)))fail('战斗结算记录无效');
  return structuredClone(data);
}
