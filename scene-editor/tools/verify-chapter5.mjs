import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createWorld,testCondition} from '../studio/world.mjs';
import {validateProject} from '../studio/format.mjs';
import {decodeSave} from '../studio/campaign.mjs';
import {requireData} from './test-env.mjs';

const read=x=>JSON.parse(fs.readFileSync(x,'utf8'));
const [projectFile,coverageFile]=requireData('assets/chapter5/chapter5.scene.json','assets/chapter5/coverage.json');
const doc=read(projectFile);
const coverage=read(coverageFile);
const audit=validateProject(doc);
assert.equal(audit.ok,true,JSON.stringify(audit,null,2));
const R=doc.player.radius,S=doc.player.speed;
const names=['up','down','left','right'];
const offsets=[[0,-1],[0,1],[-1,0],[1,0]];
const clamp=(n,a,b)=>Math.max(a,Math.min(n,b));
const overlaps=(x,y,e,r=R)=>x+r>e.x&&x-r<e.x+e.w&&y+r>e.y&&y-r<e.y+e.h;
const solid=e=>e.kind==='wall'||e.kind==='block'||e.solid;
const auto=e=>e.auto??['zone','mode','checkpoint','enemy'].includes(e.kind);
const report={rooms:Object.keys(doc.rooms).length,content:coverage.counts,tests:[]};

function adjacent(p,e){
 const dx=clamp(p.x,e.x,e.x+e.w)-p.x;
 const dy=clamp(p.y,e.y,e.y+e.h)-p.y;
 if(dx*dx+dy*dy>(R+17)**2)return Infinity;
 const front={up:-dy,down:dy,left:-dx,right:dx}[p.face];
 const across=['down','up'].includes(p.face)?Math.abs(dx):Math.abs(dy);
 if(e.facing!==false&&Math.abs(dx)+Math.abs(dy)>2&&(front<0||across>Math.max(front*1.35,R+2)))return Infinity;
 return Math.hypot(dx,dy);
}
const stoppable=new Set(['npc','enemy','door','prop','zone','checkpoint','savepoint','mode','hold']);
function choose(p,ents){
 let best=Infinity,pick=null;
 for(const e of ents){
  if(!stoppable.has(e.kind)||auto(e)||e.toolTarget||e.kind==='prop'&&!e.event&&!e.otherwise)continue;
  const d=adjacent(p,e);
  if(d<best){best=d;pick=e;}
 }
 return pick;
}
function plan(world,goal,allowAuto=null){
 const room=doc.rooms[world.state.room];
 const ents=world.entities().filter(e=>!e.hidden&&testCondition(e.activeWhen,world.state)&&!(e.once&&world.state.used[world.state.room+':'+e.id]));
 const walls=ents.filter(solid);
 const triggers=ents.filter(e=>auto(e)&&['door','zone','enemy'].includes(e.kind)&&e.id!==allowAuto);
 const queue=[{...world.state.player,prior:-1,key:null}],seen=new Set();
 for(let i=0;i<queue.length;i++){
  const p=queue[i];
  if(goal(p,ents)){
   const input=[];
   let n=i;
   while(queue[n].prior>=0){input.push(queue[n].key);n=queue[n].prior;}
   return input.reverse();
  }
  for(let j=0;j<4;j++){
   const [dx,dy]=offsets[j],face=names[j];
   let x=p.x,y=p.y;
   for(let t=0;t<S;t++){
    const nx=clamp(x+dx,R,room.w-R),ny=clamp(y+dy,R,room.h-R);
    if(walls.some(e=>overlaps(nx,ny,e)))break;
    x=nx;y=ny;
   }
   if(triggers.some(e=>overlaps(x,y,e)&&!overlaps(p.x,p.y,e)))continue;
   const hash=x.toFixed(3)+':'+y.toFixed(3)+':'+face;
   if(seen.has(hash))continue;
   seen.add(hash);queue.push({x,y,face,prior:i,key:face});
  }
  if(queue.length>700000)break;
 }
 throw Error('cannot navigate in '+world.state.room+' from '+JSON.stringify(world.state.player));
}
function make(room='room_krisroom',entry='arrival',flags={}){
 return createWorld({...doc,start:{room,entry},flags:{...doc.flags,...flags}},{validated:true});
}
function step(world,hold=[],press=[]){return world.step({hold,press});}
function wait(world,n){for(let t=0;t<n;t++)step(world);}
function visit(world,id){
 const e=world.entities().find(a=>a.id===id);
 assert.ok(e,'missing '+id);
 const keys=plan(world,(p,ents)=>auto(e)?overlaps(p.x,p.y,e):choose(p,ents)?.id===id,e.id);
 for(const key of keys)step(world,[key]);
 if(!auto(e)){
  if(!keys.length)step(world); assert.equal(world.state.prompt?.id,id);
  step(world,[],['act']);
 }
 return keys.length;
}
function sayThrough(world,limit=150){
 const pages=[];
 while(world.state.dialogue&&limit--){
  const current=world.state.dialogue;
  pages.push(current.pages[current.page].text);
  wait(world,95);
  step(world,[],['act']);
 }
 assert.ok(limit>0,'dialogue did not progress');
 return pages;
}
{
 const w=make();
 const transitions=[];
 for(const room of ['room_krishallway','room_torhouse','room_town_krisyard','room_town_north']){
  const d=w.entities().find(e=>e.kind==='door'&&e.room===room);
  assert.ok(d);
  const walked=visit(w,d.id);wait(w,60);
  assert.equal(w.state.room,room);
  transitions.push({room,walked});
 }
 report.tests.push({name:'Hometown: four actual door transitions in succession',transitions});
}
{
 const w=make();
 const bed='krisroom_bed';
 visit(w,bed);
 const q=sayThrough(w);
 // Two narration pages, then the question as its own page (scr_readychoicer queues the choices separately).
 assert.equal(q.length,3);
 assert.equal(q[2].replace(/^\* /,''),w.state.choice?.question.replace(/^\* /,''));
 assert.match(w.state.choice?.options[0].text??'',/sleep|睡觉/i);
 step(w,[],['down']);step(w,[],['act']);
 assert.match(sayThrough(w).join(' '),/somewhere else|另外找个地方/i);
 assert.equal(w.state.room,'room_krisroom');
 visit(w,bed);sayThrough(w);
 step(w,[],['act']);wait(w,102);
 assert.match(sayThrough(w).join(' '),/opened your eyes|睁开眼/i);
 wait(w,45);
 assert.equal(w.state.room,'room_dw_garden_intro');
 assert.equal(w.state.flags.gml_plot,190);
 assert.equal(w.state.flags.gml_f_1767,1);
 step(w,['right']);
 assert.equal(w.state.player.sprite,'kris_dark');
 report.tests.push({name:'Kris bedroom: decline, return, then sleep into Garden',room:w.state.room});
}
{
 const w=make('room_dw_castle_town','arrival');
 const point=w.entities().find(e=>e.kind==='savepoint');
 assert.ok(point?.beforeEvent);
 visit(w,point.id);
 const q=sayThrough(w);
 assert.ok(q.some(t=>/familiar town|熟悉.{0,5}(小镇|城镇)/i.test(t)));
 assert.equal(w.state.saveRequest?.id,point.id);
 assert.equal(w.resolveSave(true),true);
 const saved=w.takeSave();assert.ok(saved);
 const scene=decodeSave(doc,saved);
 assert.ok(scene);
 assert.equal(scene.snapshot?.room,'room_dw_castle_town');
 report.tests.push({name:'Castle Town: source dialogue then confirm and read a save',saved:scene.snapshot.room});
}
{
 const k='room_dw_garden_wateringcan_aqua';
 const w=make(k,'arrival',{gml_plot:240,gml_f_1373:2});
 const e=w.entities().filter(e=>e.kind==='prop'&&e.name==='浇水壶架').sort((a,b)=>b.y-a.y)[0];
 assert.ok(e);
 visit(w,e.id);
 wait(w,2);
 assert.equal(w.state.inventory.watering_can,1);
 assert.equal(w.state.flags.gml_f_1332,1);
 const area=(p)=>{
  const base=doc.rooms[k].tool,d=base.variants.find(v=>testCondition(v.when,w.state))??base,q=d.width/2;
  if(p.face==='up')return {x:p.x-q,y:p.y-d.range,w:d.width,h:d.range};
  if(p.face==='down')return {x:p.x-q,y:p.y,w:d.width,h:d.range};
  if(p.face==='left')return {x:p.x-d.range,y:p.y-q,w:d.range,h:d.width};
  return {x:p.x,y:p.y-q,w:d.range,h:d.width};
 };
 const near=(p,es)=>{const a=area(p);return es.some(e=>e.toolTarget&&a.x+a.w>e.x&&a.x<e.x+e.w&&a.y+a.h>e.y&&a.y<e.y+e.h);};
 const keys=plan(w,near);
 for(const key of keys)step(w,[key]);
 for(let t=0;t<4;t++)step(w,['tool']);
 assert.ok(Object.values(w.state.changed).some(e=>e.sprite?.startsWith('a_spr_')));
 report.tests.push({name:'Garden: pick up water can, walk, hold tool, change plant art',room:k,pathSteps:keys.length});
}
{
 const k='room_dw_fcastle_entrance',w=make(k,'arrival',{gml_plot:380});
 const e=w.entities().find(e=>e.id==='dw19_zone');
 assert.ok(e?.once);
 visit(w,e.id);
 wait(w,70);const pages=sayThrough(w);
 assert.ok(pages.some(s=>/the entrance|入口/.test(s)));
 assert.ok(w.state.used[k+':'+e.id]);
 report.tests.push({name:'Flower Castle: cross original trigger, camera and entrance dialogue',room:k});
}
console.log(JSON.stringify(report,null,2));

