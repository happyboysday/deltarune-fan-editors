
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWorld} from '../studio/world.mjs';
import {validateProject} from '../studio/format.mjs';
import {args,data,requirePath} from './test-env.mjs';

const example=relative=>JSON.parse(fs.readFileSync(new URL('../examples/'+relative,import.meta.url),'utf8'));
const fixture=example('paper-gate.scene.json');
export function battleControls(s,route){
  if(s.phase==='resolve'&&s.fight){
    const bar=s.fight.bars.find(b=>b.result===null);
    return bar&&Math.abs(bar.x-bar.targetX)<=6?['confirm']:[];
  }
  if(s.phase!=='menu'||!s.menu)return s.textbox||s.bubbles?.length?['confirm']:[];
  if(route==='flee')return ['cancel'];
  if(s.menu.list)return ['confirm'];
  const desired=route==='spared'?(s.enemies[0]?.mercy>=100?'spare':'act'):route==='defeat'?'defend':'fight';
  const at=s.menu.buttons.findIndex(a=>a.id===desired),cursor=s.menu.cursor;
  if(at<0)throw new Error('找不到 '+desired+' · '+JSON.stringify(s.menu));
  return [cursor===at?'confirm':cursor<at?'right':'left'];
}
export function battleMovement(s,route){
  const soul=s.battle?.soul,box=s.battle?.box;
  if(route!=='spared'||!soul||!box)return [];
  const x=box.x-box.w/2+15,y=box.y+box.h/2-11;
  return [...(soul.x>x+4?['left']:[]),...(soul.y<y-4?['down']:[])];
}
async function main(){
  const root=path.resolve(args[0]??data.battleRoot);
  const engine=requirePath(path.join(root,'engine/encounter/index.js'),'battleRoot/engine/encounter/index.js');
  const {createEncounter}=await import(pathToFileURL(engine).href);
  const encounter=example('battle/encounters/paper-guard.json'),attack=example('battle/attacks/paper-guard-rain.json');
  const checked=validateProject(fixture);
  assert.equal(checked.ok,true,JSON.stringify(checked.errors));
  const observed=[];
  for(const expected of ['spared','victory','defeat','flee']){
    const world=createWorld(fixture),s=world.state;
    const tick=(hold=[],press=[])=>world.step({hold,press});
    const tap=()=>tick(['act'],['act']);
    if(expected==='spared'){
      for(let i=0;i<9;i++)tick(['up']);
      assert.equal(s.prompt.id,'clerk');tap();
      for(let i=0;s.dialogue&&i<8;i++)tap();
      assert.ok(s.choice);
      tap();
    }else{
      for(let i=0;i<90&&!s.battle;i++)tick(['right']);
    }
    const request=s.battle;
    assert.ok(request);
    assert.equal(request.enemy,expected==='spared'?null:'paper_guard');
    const before={tick:s.tick,x:s.player.x,y:s.player.y,camera:{...s.camera},room:s.room};
    for(let i=0;i<60;i++)tick(['down'],['cancel']);
    assert.deepEqual({tick:s.tick,x:s.player.x,y:s.player.y,camera:{...s.camera},room:s.room},before);
    const enc=createEncounter({resolveAttack:()=>attack,externalInput:true});
    let result;
    enc.on('end',value=>{assert.equal(result,undefined);result=value;});
    const tested=structuredClone(encounter),spoken=[];
    const custom='* 纸门为你敞开。';
    for(const ending of ['victory','spared'])tested.hooks[ending].push({
      cmd:'if',cond:ending==='victory'?1:0,then:[{cmd:'say',text:custom,win:true}]
    });
    enc.on('say',line=>spoken.push(line.text));
    const {errors}=await enc.load(tested);
    assert.deepEqual(errors,[]);
    for(let i=0;i<1600&&!result;i++){
      const step=enc.getState();
      const press=battleControls(step,expected);
      enc.step(1,{hold:Object.fromEntries(battleMovement(step,expected).map(k=>[k,true])),press});
    }
    assert.equal(result?.result,expected,JSON.stringify({phase:enc.phase,menu:enc.getState().menu,fight:enc.getState().fight,party:enc.getState().party,enemy:enc.getState().enemies}));
    if(expected==='spared'||expected==='victory'){
      const line=expected==='victory'?custom:'* 你赢了！';
      assert.equal(spoken.filter(s=>s===line).length,1,'the closing line must actually run');
      assert.equal(spoken.includes(expected==='victory'?'* 你赢了！':custom),false);
      assert.equal(enc.getState().textbox.lines.map(l=>l.text).join(''),line,'last frame retains the closing line');
      const saved=enc.snapshot();
      assert.ok(enc.restore(saved));
      assert.equal(enc.getState().textbox.lines.map(l=>l.text).join(''),line,'restored closing frame');
    }
    assert.equal(world.completeBattle(request.serial+1,result),false);
    assert.equal(world.completeBattle(request.serial,result),true);
    assert.equal(world.completeBattle(request.serial,result),false);
    assert.equal(s.flags.gate_result,expected);
    tick();assert.ok(s.dialogue);
    assert.equal(s.player.x,before.x);assert.equal(s.player.y,before.y);assert.equal(s.room,before.room);
    for(let i=0;s.dialogue&&i<15;i++)tap();
    assert.equal(s.inventory['盖章值班单']??0,Number(expected==='spared'));
    assert.equal(s.inventory['通行纸']??0,Number(expected==='victory'));
    assert.equal(!!s.flags.gate_open,expected==='spared'||expected==='victory');
    if(expected==='flee'||expected==='defeat'){
      for(let i=0;i<12;i++)tick();
      assert.equal(s.battle,null);
      for(let i=0;i<18;i++)tick(['left']);
      for(let i=0;i<40&&!s.battle;i++)tick(['right']);
      assert.ok(s.battle);assert.notEqual(s.battle.serial,request.serial);
      assert.equal(world.abortBattle(s.battle.serial),true);
      assert.equal(s.flags.gate_result,expected);
    }
    enc.destroy();observed.push({result:expected,frame:result.frame,position:[before.x,before.y]});
  }
  const invalid=structuredClone(fixture);
  invalid.battles.gate_guard.on.spared='missing-event';
  invalid.rooms.hall.entities.find(e=>e.kind==='enemy').battle='missing-battle';
  const report=validateProject(invalid);
  assert.ok(report.errors.some(e=>e.path==='battles.gate_guard.on.spared'));
  assert.ok(report.errors.some(e=>e.path.endsWith('.battle')&&e.message.includes('missing-battle')));
  console.log(JSON.stringify({ok:true,observed},null,2));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main();
