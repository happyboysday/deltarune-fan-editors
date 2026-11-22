
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createWorld} from '../studio/world.mjs';
import {validateProject} from '../studio/format.mjs';
import {args} from './test-env.mjs';

const p=JSON.parse(fs.readFileSync(new URL('../examples/echo-workshop.scene.json',import.meta.url),'utf8'));
const world=createWorld(p),s=world.state,log=[];
const describe=()=>JSON.stringify({tick:s.tick,room:s.room,x:s.player.x,y:s.player.y,face:s.player.face,prompt:s.prompt,
  lock:s.locked,grip:s.grip,mode:s.mode,flag:s.flags,note:s.note});
function check(test,label){assert.ok(test,label+' '+describe());}
function step(n=1,hold=[],press=[]){
  const prev=log.at(-1);
  if(!press.length&&prev&&!prev.mark&&JSON.stringify(prev.hold??[])===JSON.stringify(hold))prev.n+=n;
  else log.push({n,...(hold.length?{hold}:{}),...(press.length?{press}:{})});
  for(let i=0;i<n;i++)world.step({hold,press:i===0?press:[]});
}
function tap(key='act'){step(1,[key],[key]);step();}
function until(pred,key='',limit=240){
  for(let i=0;i<limit;i++){
    if(pred())return;
    step(1,key?[key]:[]);
  }
  check(pred(),'wait timeout '+key);
}
function go(axis,to){
  const dir=axis==='x'?(to>s.player.x?'right':'left'):(to>s.player.y?'down':'up');
  until(()=>Math.abs(s.player[axis]-to)<(s.mode==='slide'?4:2.8),dir);
}
function say(){
  for(let i=0;s.dialogue&&i<80;i++){step(10);tap();}
  check(!s.dialogue,'dialogue exhausted');
}
function mark(id){
  if(!log.length||log.at(-1).mark)step();
  log.at(-1).mark=id;
}
function use(id){
  check(s.prompt?.id===id,'expected prompt '+id);tap();
}
function enter(id,room){
  use(id);until(()=>s.room===room&&!s.locked,'',90);mark('enter-'+room);
}

// Locked door and upper collision wall.
go('x',376);go('y',185);use('canal_gate');check(s.dialogue,'locked door gives feedback');say();
go('x',316);step(75,['up']);
check(s.player.y>=77.9&&s.player.y<80.7,'cannot walk through one tile wall');mark('collision');
go('y',178);go('x',223);step(1,['up']);
use('foreman');say();check(s.choice?.index===0,'interactive choice starts at option 0');
tap('down');check(s.choice?.index===1,'choice selection moves');
tap();say();check(!s.choice&&s.inventory['铜钥匙']===1&&s.inventory['水壶']===1&&s.flags.met,'choice + items granted');mark('foreman');
go('x',375);step(1,['up']);enter('canal_gate','canal');
check(s.mode==='slide'&&s.player.vx===0,'room transitions reset movement');
step(12,['right']);const before=s.player.x;step(8);check(s.player.x>before+7,'released slide input still has inertia');mark('inertia');
until(()=>s.flags.valve,'right');check(world.entities().find(e=>e.id==='copper_box').x>227,'block was pushed');step(15);say();mark('pressure');
go('x',451);enter('stage_gate','stage');
go('x',177);use('rhythm_console');check(s.rhythm,'rhythm begins');
until(()=>!!s.dialogue,'',240);check(!s.flags.badge,'misses are failure');say();mark('rhythm-retry');
use('rhythm_console');
while(s.rhythm?.done===null){
  const next=s.rhythm.beats[s.rhythm.cursor];
  if(next&&s.rhythm.age+1===next.at)step(1,[next.key],[next.key]);
  else step();
}
until(()=>!!s.dialogue,'',100);check(s.flags.badge&&s.inventory['试音章']===1,'all beats pass');
check(world.entities().some(e=>e.id==='stage_light')&&world.entities().find(e=>e.id==='stagehand').x===303,'show and timed move executed');
say();mark('rhythm-pass');
// Move around the solid console.
go('y',172);go('x',385);step(1,['right']);enter('garden_gate','garden');
go('x',207);check(s.mode==='climb'&&s.checkpoint?.name==='苗圃入口','checkpoint and climb activate');
until(()=>s.mode==='walk'&&s.note?.text.includes('回到'),'',140);
check(s.player.x<150&&s.inventory['试音章']===1,'grip exhaustion resets position and retains previous room progress');mark('grip-reset');
go('x',215);
until(()=>s.player.y<232,'up',90);
check(s.mode==='climb','rest ledge keeps climb mode');
step(100);
check(s.grip===s.maxGrip,'ledge replenishes grip');
until(()=>s.player.y<=116,'up',120);check(s.mode==='walk','exit drops climb mode');mark('climb');
go('x',280);check(s.prompt?.id==='planter','planter reachable');
step(18,['act'],['act']);const half=s.hold.progress;
step(7);check(s.hold.progress<half&&s.hold.progress>0,'hold interruption decays without losing whole progress');
until(()=>!!s.dialogue,'act',100);check(s.flags.bloom&&s.inventory['苗圃签']===1,'hold and delayed event complete');say();mark('water');
// Go above the solid planter before walking to the exit.
go('y',87);go('x',414);go('y',122);step(1,['right']);enter('garden_exit','hub');
go('x',478);go('y',160);step(1,['right']);use('exit_cabinet');
until(()=>!!s.dialogue,'',90);
check(!s.camera.follow,'camera interpolates to a scripted point');
say();check(s.flags.done&&s.camera.follow&&!world.entities().some(e=>e.id==='hub_lamp'),'full story ends; camera released');mark('complete');

// A draft door must never send the party to a default room.
const fixture={
  format:'deltarune-scene/1',title:'校验',start:{room:'test',entry:'start'},
  rooms:{test:{w:180,h:140,entries:{start:{x:90,y:90,face:'up'}},entities:[
    {id:'draft',kind:'door',name:'未配置',x:80,y:61,w:18,h:12},
    {id:'tap',kind:'hold',x:105,y:86,w:14,h:16,ticks:3,decay:1,event:'done'}
  ]}},events:{done:[{op:'item',id:'token',delta:1}]}
};
assert.equal(validateProject(fixture).warnings[0].path,'rooms.test.entities.0');
const draft=createWorld(fixture);
draft.step({hold:['act'],press:['act']});
assert.equal(draft.state.room,'test');assert.match(draft.state.note.text,/没有设置去向/);
draft.step({hold:['right']});
for(let i=0;i<3;i++)draft.step({hold:['act']});
assert.equal(draft.state.inventory.token,1);
draft.step();
draft.step({hold:['act']});draft.step({hold:['act']});
assert.equal(draft.state.inventory.token,1);
draft.step({hold:['act']});
assert.equal(draft.state.inventory.token,2);

// Replay exactly the recorded inputs in a fresh world.
const replay=createWorld(p);
for(const seg of log)for(let i=0;i<seg.n;i++)replay.step({hold:seg.hold,press:i===0?seg.press:undefined});
assert.deepEqual(replay.state,s);
assert.deepEqual(replay.entities(),world.entities());
const broken=structuredClone(p);broken.rooms.hub.entities.find(e=>e.id==='canal_gate').entry='missing';
broken.events.recursive=[{op:'call',event:'recursive'}];
broken.rooms.hub.entries.arrival.x=-9;
const report=validateProject(broken);
assert.deepEqual(new Set(report.errors.map(e=>e.path)),new Set(['rooms.hub.entities.6.entry','events.recursive','rooms.hub.entries.arrival.x']));
if(args[0])fs.writeFileSync(args[0],JSON.stringify(log,null,2)+'\n');
console.log(JSON.stringify({ok:true,ticks:s.tick,flags:s.flags,inventory:s.inventory,markers:log.filter(e=>e.mark).map(e=>e.mark)},null,2));
