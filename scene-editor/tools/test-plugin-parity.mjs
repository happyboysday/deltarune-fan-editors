import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {createWorld,testCondition} from '../studio/world.mjs';
import {drawScene} from '../studio/view.mjs';
import {ROOT,args,requireData,workDir} from './test-env.mjs';

const clips={'01_dark_room_door':225,'02_sunlit_meadow_town':300,'03_sunlit_dungeon_action':360,
  '03b_dungeon_sunknight':360,'04_mario_kart_lancer':1000,'04b_kart_starwalker':1000,'05_reunion_sunset':180,
  'dungeon-demo':600};
const scratch=workDir('plugin-parity');
const fixtures=path.join(ROOT,'tools/fixtures/plugin-parity');
const hash=value=>createHash('sha256').update(value).digest('hex');
function encode(_,v){
  if(v instanceof Map)return {map:[...v]};
  if(v instanceof Set)return {set:[...v]};
  if(v===undefined)return {$undefined:true};
  if(typeof v==='number'&&!Number.isFinite(v))return {$number:String(v)};
  if(v&&typeof v==='object'&&!Array.isArray(v))return Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]]));
  return v;
}
const pixels=args.includes('--pixels');
const canvasLib=pixels?createRequire(import.meta.url)('@napi-rs/canvas'):null;
if(pixels)globalThis.Path2D=canvasLib.Path2D;
if(pixels)globalThis.document={createElement:()=>canvasLib.createCanvas(1,1)};
for(const [name,ticks] of Object.entries(clips)){
  const demo=name==='dungeon-demo',file=name+'.scene.json';
  const source=demo?path.join(ROOT,'examples',file):requireData('trailerRoot/scenes/'+file)[0];
  const copy=path.join(scratch,file);
  fs.copyFileSync(source,copy);
  const p=JSON.parse(fs.readFileSync(copy,'utf8'));
  const w=createWorld(p,{autoplay:true});
  const canvas=pixels?canvasLib.createCanvas(w.viewport.w,w.viewport.h):null;
  const expected=fs.readFileSync(path.join(fixtures,name+'.sha256'),'utf8').trim().split(/\r?\n/);
  const frames=[];
  for(let tick=0;tick<=ticks;tick++){
    if(tick){
      const i=tick-1,interact=Math.abs(w.state.player.x-(w.state.room==='roof'?900:1060))<22;
      const press=interact||i%40===0?['act']:[];
      if(!interact&&i%42===0)press.push('skill1');
      w.step(demo?{press,hold:['run','right']}:undefined);
    }
    assert.equal(w.state.tick,tick);
    const digest=hash(JSON.stringify(w.state,encode));
    assert.equal(digest,expected[tick],name+' tick '+tick);
    if(canvas&&(tick===0||tick%60===0||tick===ticks)){
      const ctx=canvas.getContext('2d');
      drawScene(ctx,p,w.state.room,{maps:{},images:new Map(),test:testCondition},
        {state:{...w.state,entities:w.entities()}});
      frames.push(hash(ctx.getImageData(0,0,canvas.width,canvas.height).data));
    }
  }
  assert.equal(expected.length,ticks+1);
  if(demo)assert.ok(w.state.flags.finished);
  else assert.ok(w.trailerStatus()?.done);
  if(pixels)assert.deepEqual(frames,fs.readFileSync(path.join(fixtures,name+'.rgba.sha256'),'utf8').trim().split(/\r?\n/),name+' RGBA');
  console.log(name+' · '+(ticks+1)+' 个状态，'+frames.length+' 张画面');
}
