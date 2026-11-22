// Compare decoded scene pixels using the exact asset bytes in an export.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createWorld,testCondition} from '../studio/world.mjs';
import {drawScene} from '../studio/view.mjs';
import {args} from './test-env.mjs';

const [baseline,...files]=args;
if(!baseline||!files.length)throw Error('用法：node tools/compare-plugin-frames.mjs 基线studio目录 离线HTML...');
const {createCanvas,loadImage,Path2D}=createRequire(import.meta.url)('@napi-rs/canvas');
Object.assign(globalThis,{Path2D,document:{createElement:()=>createCanvas(1,1)}});
const ref=name=>import(pathToFileURL(path.resolve(baseline,name+'.mjs')));
const [originalWorld,originalView]=await Promise.all([ref('world'),ref('view')]);
for(const file of files){
  const html=fs.readFileSync(file,'utf8');
  const [p,pack]=JSON.parse(html.match(/id="scene-data" type="application\/json">([^<]+)<\/script>/)[1]);
  const images=new Map();
  for(const [url,data] of Object.entries(pack.files))images.set(url,await loadImage(data));
  const sample=p.rooms[p.start.room].mode==='kart'?[0,60,108,180,300,420,500,600,740,791,900,1000]:
    [0,30,60,90,110,130,150,170,190,210,240,270,300,330,360];
  const canvas=()=>createCanvas(p.viewport.w,p.viewport.h);
  const runners=[[originalWorld.createWorld,originalView.drawScene],[createWorld,drawScene]].map(([create,draw])=>
    ({world:create(structuredClone(p),{autoplay:true}),draw,ctx:canvas().getContext('2d')}));
  for(const tick of sample){
    const buffers=runners.map(({world,draw,ctx})=>{
      while(world.state.tick<tick)world.step();
      draw(ctx,world.project,world.state.room,{maps:pack.maps,images,test:testCondition},{state:{...world.state,entities:world.entities()}});
      return Buffer.from(ctx.getImageData(0,0,p.viewport.w,p.viewport.h).data);
    });
    assert.ok(buffers[0].equals(buffers[1]),p.title+' 的 RGBA 不一致，tick '+tick);
  }
  console.log(p.title+' · '+images.size+' 个素材，'+sample.length+' 张完整 RGBA 画面一致');
}
