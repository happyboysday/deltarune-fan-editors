import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createWorld} from '../studio/world.mjs';
import {createSceneNavigator} from '../studio/scene-navigator.mjs';
import {requireData} from './test-env.mjs';
const make=(entities,start={x:20,y:70,face:'right'})=>({title:'测试房',w:320,h:200,style:'flat',entries:{start},entities});
const p={format:'deltarune-scene/1',id:'test-nav',title:'走廊',viewport:{w:320,h:200},player:{radius:5,speed:3},start:{room:'a',entry:'start'},rooms:{
 a:make([{id:'wall',kind:'wall',x:75,y:0,w:16,h:140},{id:'door',kind:'door',x:220,y:60,w:20,h:25,room:'b',entry:'start',auto:true,fade:2}]),
 b:make([{id:'manual',kind:'door',x:150,y:70,w:15,h:18,room:'c',entry:'start',auto:false,fade:2}]),
 c:make([])},events:{}};
function run(project,goal,limit=3000){
 const w=createWorld(project),notes=[],nav=createSceneNavigator(msg=>notes.push(msg));nav.start(goal);
 let minX=Infinity,maxX=-Infinity,bottom=0,jumps=0;const rooms=[];
 for(let t=0;t<limit&&nav.active;t++){
   if(rooms.at(-1)!==w.state.room)rooms.push(w.state.room);
   const input=nav.step(w);w.step(input);minX=Math.min(minX,w.state.player.x);maxX=Math.max(maxX,w.state.player.x);bottom=Math.max(bottom,w.state.player.y);
   if((input.press??[]).includes('up'))jumps++;
 }
 return {rooms,room:w.state.room,active:nav.active,bottom,minX,maxX,jumps,note:notes.at(-1)};
}
let walk=run(p,'c');assert.equal(walk.room,'c',JSON.stringify(walk));assert.ok(!walk.active&&walk.bottom>=145);assert.deepEqual(walk.rooms,['a','b','c']);
const explore=run(p,'');assert.equal(explore.room,'c');assert.ok(!explore.active&&explore.note.includes('走完'));
const noWay=structuredClone(p);noWay.rooms.a.entities[0].h=200;assert.equal(run(noWay,'c').room,'a');
const cliff=JSON.parse(fs.readFileSync(requireData('assets/chapter5/chapter5.scene.json')[0]));cliff.start={room:'room_dw_cliff_dash_runner',entry:'entry_1'};
const jump=run(cliff,'room_dw_cliff_seth_miniboss',3800);
console.log(JSON.stringify({walk,explore,jump}));
assert.equal(jump.room,'room_dw_cliff_seth_miniboss',JSON.stringify(jump));assert.ok(jump.jumps>=3&&jump.maxX>9900&&!jump.active);

