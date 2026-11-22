
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWorld} from '../studio/world.mjs';
import {connectParty,decodeSave} from '../studio/campaign.mjs';
import {validateProject} from '../studio/format.mjs';
import {args,data,requirePath} from './test-env.mjs';

const read=rel=>JSON.parse(fs.readFileSync(new URL('../examples/'+rel,import.meta.url),'utf8'));
export const relay=read('ember-relay.scene.json');

export function relayInput(s,route){
  let press=[],hold=[];
  if(s.phase==='menu'&&s.menu){
    if(s.menu.list){
      const list=s.menu.list;
      const target=list.kind==='item'?list.items.findIndex(i=>i.label.includes('星糖')):0;
      if(target<0)throw new Error('找不到星糖 '+JSON.stringify(list));
      press=[list.cursor===target?'confirm':list.cursor<target?'down':'up'];
    }else{
      const desired=route==='use'?'item':route==='lose'?'defend':'fight';
      const at=s.menu.buttons.findIndex(a=>a.id===desired);
      if(at<0)throw new Error('找不到指令 '+desired);
      press=[s.menu.cursor===at?'confirm':s.menu.cursor<at?'right':'left'];
    }
  }else if(s.phase==='resolve'&&s.fight){
    const bar=s.fight.bars.find(b=>b.result===null);
    if(bar&&Math.abs(bar.x-bar.targetX)<=6)press=['confirm'];
  }else if(s.textbox||s.bubbles?.length)press=['confirm'];
  if(s.battle&&route==='use'){
    const soul=s.battle.soul,b=s.battle.box;
    const goalX=b.x-b.w/2+14,goalY=b.y+b.h/2-10;
    hold=[...(soul.x>goalX+4?['left']:[]),...(soul.y<goalY-4?['down']:[])];
  }
  return {hold,press};
}

async function main(){
  const root=path.resolve(args[0]??data.battleRoot);
  const engine=requirePath(path.join(root,'engine/encounter/index.js'),'battleRoot/engine/encounter/index.js');
  const {createEncounter}=await import(pathToFileURL(engine));
  const docs={patrol:read('battle/encounters/ember-patrol.json'),latch:read('battle/encounters/ember-latch.json')};
  const attacks={'ember-curtain':read('battle/attacks/ember-curtain.json'),'ember-furnace':read('battle/attacks/ember-furnace.json')};
  assert.equal(validateProject(relay).ok,true);
  const game=createWorld(relay),s=game.state;
  const step=(hold=[],press=[])=>game.step({hold,press});
  const tap=()=>step(['act'],['act']);
  function until(condition,hold=[],max=140){
    for(let i=0;i<max&&!condition();i++)step(hold);
    assert.ok(condition(),JSON.stringify({x:s.player.x,y:s.player.y,room:s.room,prompt:s.prompt,battle:s.battle}));
  }
  function closeText(){for(let i=0;i<10&&s.dialogue;i++)tap();assert.equal(s.dialogue,null);}
  until(()=>s.player.x>=207,['right']);
  step(['up']);tap();assert.equal(s.saveRequest.id,'lamp');
  tap();const saved=decodeSave(relay,JSON.parse(JSON.stringify(game.takeSave())));
  assert.equal(saved.snapshot.party.kris.hp,34);
  assert.equal(saved.snapshot.inventory.tonic,2);
  assert.equal(saved.snapshot.player.x,208);
  assert.throws(()=>decodeSave({...relay,campaign:{...relay.campaign,saveKey:'other'}},saved),/不属于/);
  const malformed=structuredClone(saved);malformed.snapshot.inventory.tonic=-1;
  assert.throws(()=>decodeSave(relay,malformed),/物品/);
  until(()=>s.battle,['right']);
  const startTick=s.tick;
  async function encounter(id,route){
    const request=s.battle;
    assert.equal(request.id,id);
    const bridge=connectParty(relay,relay.battles[id],docs[id],s.party,s.inventory);
    const enc=createEncounter({externalInput:true,resolveAttack:name=>attacks[name]});
    const {errors}=await enc.load(bridge.doc);
    assert.deepEqual(errors,[]);
    let result;
    enc.on('end',value=>result={...value,progress:bridge.sync(enc.partyState())});
    const initial=enc.partyState(),routeLog={id,initial};
    let phase=route;
    for(let i=0;i<1700&&!result;i++){
      const view=enc.getState();
      if(route==='use'&&view.phase==='menu'&&view.turnNumber>=2)phase='win';
      const input=relayInput(view,phase);
      enc.step(1,{hold:Object.fromEntries(input.hold.map(k=>[k,true])),press:input.press});
    }
    assert.ok(result,JSON.stringify(enc.getState().menu));
    routeLog.final=enc.partyState();routeLog.result=result.result;
    const frozen=s.tick;for(let i=0;i<10;i++)step(['down']);assert.equal(s.tick,frozen);
    assert.equal(game.completeBattle(request.serial,result),true);
    assert.equal(game.completeBattle(request.serial,result),false);
    enc.destroy();return routeLog;
  }
  const first=await encounter('patrol','use');
  assert.equal(first.result,'victory');
  assert.equal(first.initial.party[0].hp,34);
  assert.equal(first.initial.party[0].maxHp,48);
  assert.equal(first.initial.items.find(i=>i.id==='treat').count,2);
  assert.equal(s.inventory.tonic,1);assert.equal(s.inventory.cinder,1);assert.equal(s.inventory.badge,1);
  assert.equal(s.inventory.room_key,1);assert.equal(s.tick,startTick);
  const afterHP=s.party.kris.hp;assert.ok(afterHP>0&&afterHP<48);
  step();closeText();
  until(()=>s.prompt?.id==='stair',['right']);tap();until(()=>s.room==='furnace'&&!s.locked);
  until(()=>s.battle,['right']);
  const second=await encounter('latch','lose');
  assert.equal(second.result,'defeat');assert.equal(second.initial.party[0].id,'guest');
  assert.equal(second.initial.party[0].hp,afterHP);
  for(const key of ['tonic','cinder','badge'])assert.equal(second.initial.items.find(i=>i.id===key).count,1);
  assert.equal(s.party.kris.hp,0);assert.ok(s.defeat);
  game.restoreSave(saved);
  assert.equal(s.room,'hall');assert.equal(s.player.x,208);assert.equal(s.party.kris.hp,34);
  assert.equal(s.inventory.tonic,2);assert.equal(s.inventory.cinder,undefined);
  assert.equal(s.flags.first_cleared,undefined);assert.equal(s.lastBattle,null);assert.equal(s.defeat,null);
  const local=connectParty(relay,{carry:'isolated'},docs.patrol,s.party,s.inventory);
  assert.equal(local.doc,docs.patrol);assert.equal(local.doc.items[0].count,9);
  const old=read('paper-gate.scene.json');const standalone=connectParty(old,old.battles.gate_guard,docs.patrol,{},{});
  assert.equal(standalone.doc,docs.patrol);
  // A repeating switch under a savepoint fires on the first press only;
  // reopening the save must not give the player its item a second time.
  const pressure=structuredClone(relay);
  const hall=pressure.rooms.hall;
  const lamp=hall.entities.find(e=>e.kind==='savepoint');
  Object.assign(lamp,{auto:true,confirm:false,heal:true,x:195,y:160,w:25,h:25});
  hall.entities.unshift({id:'plate',kind:'switch',flag:'pressed',event:'plate_bonus',x:195,y:160,w:25,h:25});
  pressure.events.plate_bonus=[{op:'item',id:'token',delta:1}];
  const pressureGame=createWorld(pressure);
  let point;
  for(let i=0;i<100&&!point;i++){
    pressureGame.step({hold:['right']});
    point=pressureGame.takeSave();
  }
  assert.ok(point);
  assert.equal(point.snapshot.party.kris.hp,48,'optional savepoint healing');
  assert.deepEqual(point.snapshot.pressedSwitches,['plate']);
  const decoded=decodeSave(pressure,JSON.parse(JSON.stringify(point)));
  const loaded=createWorld(pressure);
  loaded.restoreSave(decoded);loaded.step();
  assert.equal(loaded.state.inventory.token,1,'a queued switch event at save time still runs');
  loaded.step();
  assert.equal(loaded.state.inventory.token,1,'holding a plate at the checkpoint is not a new press');
  for(let i=0;i<12;i++)loaded.step({hold:['left']});
  for(let i=0;i<12;i++)loaded.step({hold:['right']});
  assert.equal(loaded.state.inventory.token,2,'leaving and returning can press it again');
  console.log(JSON.stringify({ok:true,first,second,restored:{hp:s.party.kris.hp,items:s.inventory,room:s.room,x:s.player.x}},null,2));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main();
