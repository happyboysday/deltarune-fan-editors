import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {args,requireData,requirePath} from './test-env.mjs';
const [remote,output]=args;
const [dir]=requireData('assets/chapter5','assets/chapter5/chapter5.scene.json','assets/chapter5/coverage.json');
const from=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const p=from(path.join(dir,'chapter5.scene.json')), coverage=from(path.join(dir,'coverage.json'));
const radius=p.player.radius;
const need=new Set();
const reachableRooms=new Set();
const count={reachableDoors:0,unreachableDoors:0,reachableInteractions:0,unreachableInteractions:0,images:0,mappedVisible:0};
const exceptions=[];
function raster(room){
 const step=4;
 const cols=Math.floor((room.w-2*radius)/step)+1,rows=Math.floor((room.h-2*radius)/step)+1;
 const grid=new Uint8Array(cols*rows),queue=new Uint32Array(grid.length);
 const rect=(e,d)=>[
   Math.max(0,Math.floor((e.x-d-radius)/step)+1),Math.min(cols-1,Math.ceil((e.x+e.w+d-radius)/step)-1),
   Math.max(0,Math.floor((e.y-d-radius)/step)+1),Math.min(rows-1,Math.ceil((e.y+e.h+d-radius)/step)-1)
 ];
 for(const e of room.entities){
  if(e.hidden||e.activeWhen||!(e.kind==='wall'||e.kind==='block'||e.solid))continue;
  const [x0,x1,y0,y1]=rect(e,radius);
  for(let y=y0;y<=y1;y++)if(x0<=x1)grid.fill(1,y*cols+x0,y*cols+x1+1);
 }
 let head=0,tail=0;
 const push=i=>{if(!grid[i]){grid[i]=2;queue[tail++]=i;}};
 for(const entry of Object.values(room.entries)){
  const x=Math.round((entry.x-radius)/step),y=Math.round((entry.y-radius)/step);
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
   if(x+dx>=0&&x+dx<cols&&y+dy>=0&&y+dy<rows)push((y+dy)*cols+x+dx);
  }
 }
 while(head<tail){
  const i=queue[head++],col=i%cols;
  if(col>0)push(i-1);if(col<cols-1)push(i+1);
  if(i>=cols)push(i-cols);if(i+cols<grid.length)push(i+cols);
 }
 return (e,d)=>{
  const [x0,x1,y0,y1]=rect(e,d);
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(grid[y*cols+x]===2)return true;
  return false;
 };
}
for(const [key,room] of Object.entries(p.rooms)){
 const layout=from(requirePath(path.join(dir,'layouts',room.layout+'.json'),'assets/chapter5/layouts/'+room.layout+'.json'));
 assert.equal(layout.id,key);
 assert.equal(layout.width,room.w);assert.equal(layout.height,room.h);
 const layers=new Map(layout.layers.map(l=>[l.id,l]));
 assert.equal(layers.size,layout.layers.length,key+' repeated layer');
 let images=0;
 for(const e of layout.elements){
  assert.ok(layers.has(e.layer),key+' missing layer '+e.layer);
  if(e.visible===false||layers.get(e.layer).visible===false||e.alpha===0)continue;
  if(!e.url)need.add(e.asset);
  images++;
 }
 if(images)count.mappedVisible++;
 const hit=raster(room);
 for(const e of room.entities){
  if(e.hidden||!['door','savepoint'].includes(e.kind)&&!e.event&&!e.beforeEvent)continue;
  let access=e.auto?radius:e.toolTarget?Math.max(room.tool?.range??17,22):22;
  const found=hit(e,access);
  const counter=(found?'reachable':'unreachable')+(e.kind==='door'?'Doors':'Interactions');
  count[counter]++;
  if(found&&images)reachableRooms.add(key);
  if(!found)exceptions.push({room:key,id:e.id,kind:e.kind,target:e.room??null});
 }
}
assert.ok(reachableRooms.size>coverage.counts.inScope/2,'playable majority not satisfied');
if(remote){
 const all=[...need], missing=[];
 for(let i=0;i<all.length;i+=400){
  const ids=all.slice(i,i+400);
  const result=await fetch(remote+'/api/assets/resolve',{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chapter:'ch5',ids})
  });
  assert.ok(result.ok,result.status+' could not resolve assets');
  const data=await result.json(),resolved=new Set(data.assets.filter(a=>a.url).flatMap(a=>[a.asset,a.name]));
  for(const next of ids)if(!resolved.has(next))missing.push(next);
 }
 count.missingAssets=missing;
}
count.images=need.size;
const result={counts:count,roomsWithReachableImportedBehavior:reachableRooms.size,reachable:[...reachableRooms],unreachable:exceptions,
 note:'Static test: unobstructed geometry from a declared entrance on a four-pixel grid, excluding dynamic conditions. Browser and scene replays separately exercise actual movement and scripts.'};
if(output)fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({counts:count,roomsWithReachableImportedBehavior:reachableRooms.size,exceptions:exceptions.slice(0,20)},null,2));

