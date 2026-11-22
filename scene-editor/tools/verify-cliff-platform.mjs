import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createWorld} from '../studio/world.mjs';
import {validateProject} from '../studio/format.mjs';
import {requireData} from './test-env.mjs';
const doc=JSON.parse(fs.readFileSync(requireData('assets/chapter5/chapter5.scene.json')[0]));
const id='room_dw_cliff_dash_runner';
doc.start={room:id,entry:'entry_1'};
const check=validateProject(doc);
assert.equal(check.ok,true,JSON.stringify(check.errors.slice(0,3)));
const w=createWorld(doc),step=(hold=[],press=[])=>w.step({hold,press});
for(let i=0;i<25;i++)step();
const startY=w.state.player.y;
step(['up'],['up']);assert.ok(w.state.player.y<startY);
for(let i=0;i<55;i++)step();
assert.ok(Math.abs(w.state.player.y-startY)<2);
let furthest=0;
for(let t=0;t<850;t++){
 step(['right']);furthest=Math.max(furthest,w.state.player.x);
 if(furthest>5500&&w.state.player.x<50)break;
}
assert.ok(furthest>5500&&w.state.player.x<50,'fall did not return to the left entrance');
const jumps=[5580,7230,8610],landings=[6240,8110,9470];
let phase=-1,elapsed=0,n=0;
for(;n<1700&&w.state.room===id;n++){
 const x=w.state.player.x,keys=x<10098?['right']:[],press=[];
 if(phase<2&&x>=jumps[phase+1]){phase++;elapsed=0}
 if(phase>=0&&x<landings[phase]){
   if(elapsed===0){keys.push('up');press.push('up','dash')}
   if(elapsed>=13){keys.push('up');if(elapsed===13)press.push('up')}
   elapsed++;
 }
 step(keys,press);
}
assert.equal(w.state.room,'room_dw_cliff_seth_miniboss');
assert.equal(phase,2);
console.log(JSON.stringify({entry:'entry_1',fallRetry:true,jumps:jumps.length,ticks:n,destination:w.state.room}));

