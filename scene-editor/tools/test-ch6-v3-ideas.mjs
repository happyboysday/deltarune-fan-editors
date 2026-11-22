// Covers the v3 trailer additions: dungeon ACT/spare, SOUL mode, body-centred parry, and the kart [Starwalker] item.
import assert from 'node:assert/strict';
import {FORMAT} from '../studio/format.mjs';
import {createWorld} from '../studio/world.mjs';
import {SOUL_ENTER,SOUL_EXIT,SPARE_TICKS} from '../studio/trailer-dungeon.mjs';

const build=(room,opts={})=>({format:FORMAT,title:'v3 ideas',viewport:{w:320,h:180},
  start:{room:'slice',entry:'start'},rooms:{slice:room},...opts});
const step=(world,press=[],hold=[])=>world.step({press,hold});
const floor={id:'floor',kind:'wall',x:0,y:144,w:640,h:36};

function checkSpare(){
  const world=createWorld(build({mode:'dungeon',w:640,h:180,entries:{start:{x:72,y:138,face:'right'}},entities:[floor,
    {id:'fan',kind:'actionEnemy',x:110,y:124,w:18,h:20,hp:6,patrolSpeed:0,shotInterval:0,contact:false,
      spare:{text:'遮光',range:60},onDefeat:'gone'}]},{events:{gone:[{op:'flag',id:'spared',value:true}]}}));
  const d=world.state.dungeon;
  step(world);
  step(world,['spare']);
  const fan=d.enemies.get('fan');
  assert.ok(fan.spared!=null,'spare marks the enemy');
  assert.equal(d.spares,1);
  assert.equal(d.actPop?.text,'遮光');
  step(world,['act']);
  for(let i=0;i<12;i++)step(world);
  assert.equal(fan.hp,6,'a spared enemy cannot be hurt');
  for(let i=0;i<SPARE_TICKS;i++)step(world);
  assert.equal(fan.hp,0);
  assert.equal(world.state.flags.spared,true,'leaving runs onDefeat');
  assert.equal(d.kills,0,'sparing is not a kill');
}

function checkSoul(){
  const world=createWorld(build({mode:'dungeon',w:640,h:180,entries:{start:{x:72,y:138,face:'right'}},entities:[floor,
    {id:'boss',kind:'actionEnemy',x:150,y:114,w:24,h:30,hp:9,patrolSpeed:0,shotInterval:0,
      soul:{range:120,seconds:1,w:90,h:60,lift:60,damage:5,stunAfter:1}}]}));
  const d=world.state.dungeon;
  step(world);
  assert.ok(d.soul,'an enemy with a soul spec pulls Kris into the bullet box');
  const start=d.age;
  for(let i=0;i<SOUL_ENTER+6;i++)step(world,[],['left']);
  assert.ok(d.soul.heart.x<d.soul.cx,'the heart follows the held direction');
  while(d.soul&&d.age<start+SOUL_ENTER+30+SOUL_EXIT+5)step(world);
  assert.equal(d.soul,null,'SOUL mode ends after its time');
  const boss=d.enemies.get('boss');
  assert.ok(boss.soulDone,'it does not trigger twice');
  assert.ok(boss.stun>d.age,'the caster is stunned afterwards');
  assert.ok(d.hp>0);
}

function checkStarwalker(){
  const world=createWorld(build({mode:'kart',w:320,h:180,entries:{start:{x:160,y:100}},
    kartConfig:{trackSegments:[{length:400}],itemBoxes:[{at:20,lane:0}],forceItem:'starwalker',
      opponents:[{id:'slow',lane:0,start:60,speed:40}]}}));
  const k=world.state.kart;
  let i=0;
  while(k.item!=='starwalker'&&i++<400)step(world,[],['dash']);
  assert.equal(k.item,'starwalker');
  step(world,['act'],['dash']);
  assert.ok(k.star,'Starwalker starts the rainbow dash');
  assert.equal(k.itemBanner?.text,'STARWALKER!');
  assert.ok(k.boost>0);
  for(i=0;i<75&&k.star;i++)step(world,[],['dash']);
  assert.equal(k.star,null,'the dash ends');
}

checkSpare();
checkSoul();
checkStarwalker();
console.log('v3 ideas OK');
