import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {validateProject} from '../studio/format.mjs';
import {createWorld} from '../studio/world.mjs';
import {toText,fromText,writeGrid,projectIds} from '../studio/grid.mjs';
import {officialKrisFighter,officialEnemyTypes,officialTileParts,OFFICIAL_TILESETS} from '../studio/dungeon-presets.mjs';
import {ROOT,args,data,requireData} from './test-env.mjs';

const demo=JSON.parse(readFileSync(new URL('../examples/dungeon-demo.scene.json',import.meta.url),'utf8'));
function valid(p){
  const report=validateProject(p);
  assert.ok(report.ok,JSON.stringify(report.errors));
}
valid(demo);
const {fighter,assets}=officialKrisFighter(),enemies=officialEnemyTypes();
for(const [id,art] of Object.entries({...assets,...enemies.assets}))assert.equal(art.scale,2,id);
assert.deepEqual(fighter.box,{w:36,h:68});
assert.deepEqual(assets.kris_idle.offset,[-7,0]); // native offset; rendered as -14,0
assert.deepEqual([fighter.skills[0].projectile.w,fighter.skills[0].projectile.h],[24,24]);
assert.deepEqual(enemies.enemyTypes.beetle.melee.hitbox,{x:0,y:-64,w:64,h:64});
for(const [id,type] of Object.entries(enemies.enemyTypes))
  assert.deepEqual(type.box,{w:48,h:['jigsawry','ponman'].includes(id)?64:60});
assert.deepEqual(demo.fighters.kris,fighter);
assert.deepEqual(demo.enemyTypes,enemies.enemyTypes);
const parts={};
for(const set of OFFICIAL_TILESETS){
  const pack=officialTileParts(set);
  Object.assign(parts,pack.tileParts);Object.assign(assets,pack.assets);
}
assert.deepEqual(demo.tileParts,parts);
for(const [id,asset] of Object.entries({...assets,...enemies.assets}))assert.deepEqual(demo.assets[id],asset);
for(const a of Object.values(demo.assets))for(const url of typeof a==='string'?[a]:a.frames)
  assert.match(url,/^\/(official\/(?:animations\/Kris|enemy-animations\/enemies|sprites\/ch5)|a-files\/exports\/derived\/tiles\/ch5|studio\/art\/dungeon-ch5)\//);
// data.win frame counts; include the separate idle pose and the firing sequence in the same audit.
const extracted=new Set();
for(const [name,count] of Object.entries({spr_forange_largeglove:6,spr_forange_glove:3,spr_shinobeetle_hurt:2,
  spr_fyellow_gun:3,spr_faqua_small:5,spr_faqua_spin:5,spr_faqua_blur:3})){
  const expected=Array.from({length:count},(_,i)=>'/studio/art/dungeon-ch5/'+name+'_'+String(i).padStart(3,'0')+'.png');
  assert.deepEqual(enemies.assets[name].frames.toSorted(),expected,name);
  for(const url of expected)extracted.add(url);
}
// Check every shipped URL against the server's actual source library or crop manifest.
const artPrefix=data.assets===ROOT&&!existsSync(path.join(ROOT,'art/dungeon-ch5'))?'assets/studio':'assets';
const [manifest]=requireData('base/management/agents/A-assets/exports/v8/sprites.json','officialRoot',artPrefix+'/art/dungeon-ch5');
const crops=new Map(JSON.parse(readFileSync(manifest)).sprites.filter(s=>s.kind==='tile_crop').map(s=>[s.path,s]));
const urls=new Set(Object.values(demo.assets).flatMap(a=>typeof a==='string'?[a]:a.frames));
for(const r of Object.values(demo.rooms))for(const layer of r.parallax??[])urls.add(layer.src);
for(const url of urls){
  const crop=crops.get(url.replace('/a-files/exports/',''));
  assert.ok(crop || url.startsWith('/official/') || extracted.has(url),url);
  const spec=extracted.has(url)?artPrefix+url.slice('/studio'.length):
    'officialRoot/'+(crop?crop.source_path:url.slice('/official/'.length));
  const [file]=requireData(spec);
  const bytes=readFileSync(file);
  assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a',url);
  if(crop){
    const {x,y,width,height}=crop.source_rect;
    assert.equal(crop.source_path_base,'official');
    assert.equal(width,40);assert.equal(height,40);
    assert.equal(x%44,2);assert.equal(y%44,2);
    assert.ok(x+width<=bytes.readUInt32BE(16) && y+height<=bytes.readUInt32BE(20),url);
  }
}
assert.deepEqual(fighter.airAttack.hitbox,{x:-56,y:-110,w:144,h:144});
assert.deepEqual(fighter.attacks.map(a=>a.hitbox),[
  {x:-36,y:-98,w:116,h:110},{x:14,y:-110,w:66,h:142},{x:-48,y:-122,w:148,h:146}]);
for(const a of [...fighter.attacks,fighter.airAttack])assert.equal(assets[a.anim].frames.length,assets[a.effect].frames.length);
for(const room of Object.values(demo.rooms)){
  const occupied=new Set();
  for(const t of room.tiles){
    for(const n of [t.x,t.y,t.w,t.h])assert.equal(n%room.grid.size,0);
    const layer=t.layer??parts[t.part].layer,key=[layer,t.x,t.y].join('/');
    assert.ok(!occupied.has(key),key);occupied.add(key);
  }
}
assert.ok(demo.rooms.roof.tiles.some(t=>parts[t.part].layer==='actor' && parts[t.part].depth>0));
assert.ok(demo.rooms.roof.tiles.some(t=>parts[t.part].layer==='front'));
const bad=[
  ['assets.kris_idle.offset.0','x'],
  ['fighters.kris.anims.idle','absent'],['fighters.kris.airAttack.hitbox.h',0],
  ['fighters.kris.attacks.0.active',-1],['fighters.kris.dodge.ticks',0],
  ['fighters.kris.skills.0.projectile.count',1.5],['fighters.kris.skills.1.parry.window',0],
  ['fighters.kris.skills.2.dash.ticks',0],['fighters.kris.skills.3.heal.amount',-1],
  ['enemyTypes.glove.sym','D'],['enemyTypes.beetle.ai','walk'],['enemyTypes.gun.shoot.sprite','missing'],
  ['tileParts.column.layer','forward'],['tileParts.column.sym','G'],['tileParts.column.cells.0',0],
  ['rooms.roof.tiles.0.depth','6'],['rooms.roof.dungeonConfig.fighter','unknown'],['player.fighter','absent'],
  ['rooms.cliff.entities.0.enemyType','absent']
];
for(const [path,value] of bad){
  const p=structuredClone(demo),keys=path.split('.'),last=keys.pop();
  keys.reduce((o,k)=>o[k],p)[last]=value;
  assert.ok(validateProject(p).errors.some(e=>e.path.endsWith(path)),path);
}
const area={id:'ring',name:'回旋斩',input:'skill1',type:'area',cast:1,cooldown:1,
  area:{x:-60,y:-80,w:160,h:80,damage:11,ticks:4}};
const inline=structuredClone(demo);
inline.fighters.kris.anims.idle={frames:assets.kris_idle.frames,offset:[1,-2],flip:true,loop:false,ticks:3};
valid(inline);
for(const scale of [.25,8,0.24,8.01,'2',null]){
  inline.fighters.kris.anims.idle.scale=scale;
  inline.assets.kris_idle.scale=scale;
  const errors=validateProject(inline).errors;
  for(const path of ['assets.kris_idle.scale','fighters.kris.anims.idle.scale'])
    assert.equal(errors.some(e=>e.path.endsWith(path)),![.25,8].includes(scale),path);
}
delete inline.fighters.kris.anims.idle.scale;
delete inline.assets.kris_idle.scale;
valid(inline);
inline.fighters.kris.anims.idle.flip=2;
assert.ok(validateProject(inline).errors.some(e=>e.path.endsWith('anims.idle.flip')));
const areaProject=structuredClone(demo);
areaProject.fighters.kris.skills[0]=structuredClone(area);valid(areaProject);
areaProject.fighters.kris.skills[0].area.ticks=0;
assert.ok(validateProject(areaProject).errors.some(e=>e.path.endsWith('area.ticks')));
const clash=structuredClone(demo);
clash.gridParts={guard:{sym:'G',kind:'prop'}};
assert.ok(validateProject(clash).errors.some(e=>e.path.endsWith('enemyTypes.glove.sym')));
createWorld(demo).step({});
console.log('通过：预设、全素材引用、示例加载、校验反例、逐格对齐与排序数据');
const staticOnly=args.includes('--static');
if(staticOnly)console.log('仅运行静态验收。完整验收请去掉 --static。');

function checkGrid(){
  for(const [name,r] of Object.entries(demo.rooms))for(const layer of ['collision','objects','back','actor','front']){
    const options={project:demo,layer},text=toText(r,name,options);
    const rows=text.split(/\r?\n/).filter(l=>l && !l.startsWith(';'));
    for(const t of r.tiles.filter(t=>(t.layer??parts[t.part].layer)===layer))
      assert.equal(rows[t.y/40][t.x/40],parts[t.part].sym);
    const restored=writeGrid(r,fromText(r,text,options),projectIds(demo));
    assert.equal(toText(restored,name,options),text);
    assert.deepEqual(restored.tiles,r.tiles);
    assert.deepEqual(restored.entities,r.entities);
  }
}
function arena({enemy,x=85,y,override={},edit}={}){
  const p=structuredClone(demo),r=p.rooms.cliff;
  r.entries={start:{x:60,y:380,face:'right'},retry:{x:300,y:380,face:'right'}};
  r.platform.retryEntry='retry';r.tiles=r.tiles.filter(t=>t.part==='soil');
  r.entities=enemy?[{id:'target',kind:'actionEnemy',enemyType:enemy,x,y:y??400-p.enemyTypes[enemy].box.h,...override}]:[];
  edit?.(p,r);valid(p);
  const w=createWorld(p);
  return w;
}
function tick(w,n=1,press=[],hold=[]){
  for(let i=0;i<n;i++)w.step({press:i?[]:press,hold});
}
function until(w,test,label,n=160){
  for(let i=0;i<n&&!test();i++)tick(w);
  assert.ok(test(),label);
}
const enemy=w=>w.state.dungeon.enemies.get('target');
const dummy={enemy:'gun',override:{hp:90,contact:false},edit:p=>{delete p.enemyTypes.gun.shoot;}};
function combat(){
  const reach=arena({...dummy,x:125});tick(reach,20);tick(reach,1,['act']);
  until(reach,()=>enemy(reach).hp===90-fighter.attacks[0].damage,'第一段应击中原生框以外、两倍框以内的目标');
  const w=arena(dummy);tick(w,20);
  let hp=enemy(w).hp;
  for(const a of fighter.attacks){
    tick(w,1,['act']);
    until(w,()=>enemy(w).hp<hp,'连段未命中');assert.equal(enemy(w).hp,hp-a.damage);hp=enemy(w).hp;
    until(w,()=>!w.state.dungeon.swing,'收招');
  }
  const air=arena(dummy);tick(air,20);tick(air,1,['up']);tick(air,1,['act']);
  until(air,()=>enemy(air).hp===90-fighter.airAttack.damage,'空中斩伤害');
}
function movement(){
  const travel=hold=>{const w=arena();tick(w,20);const x=w.state.player.x;tick(w,30,[],hold);return w.state.player.x-x;};
  assert.ok(travel(['right','run'])>travel(['right'])*1.25,'奔跑速度');
  const w=arena({edit:(p,r)=>r.tiles.push({part:'ledge',x:40,y:280,w:40,h:40})});
  tick(w,30);assert.ok(Math.abs(w.state.player.y-400)<=1,'实体地面');
  tick(w,1,['up']);until(w,()=>w.state.player.y<280,'向上穿过三格高的单向平台');
  tick(w,60);assert.ok(Math.abs(w.state.player.y-280)<=1,'下降落在单向平台');
  const contact={enemy:'gun',x:124,edit:p=>{delete p.enemyTypes.gun.shoot;}};
  const walker=arena(contact);tick(walker,20);tick(walker,18,[],['right']);
  assert.ok(walker.state.dungeon.hp<fighter.hp,'步行接触应受伤');
  const dash=arena(contact);tick(dash,20);tick(dash,8,['dash'],['right']);
  assert.ok(dash.state.player.x>=140);assert.equal(dash.state.dungeon.hp,fighter.hp,'闪避无敌');
}
function powers(){
  for(const [key,x,amount] of [['skill1',120,3],['skill3',90,4],['area',80,11]]){
    const w=arena({...dummy,x,edit:(p,r)=>{dummy.edit(p);if(key==='area')p.fighters.kris.skills[0]=structuredClone(area);}});
    tick(w,20);tick(w,1,[key==='area'?'skill1':key]);
    until(w,()=>enemy(w).hp===90-amount,key+' 伤害');
  }
  const heal=arena();tick(heal,20);heal.state.dungeon.hp-=30;
  tick(heal,12,['skill4']);assert.equal(heal.state.dungeon.hp,fighter.hp-14);
  const guard=arena({enemy:'gun',x:160});tick(guard);
  until(guard,()=>guard.state.dungeon.bullets.some(b=>Math.abs(b.x-guard.state.player.x)<34),'枪弹接近');
  tick(guard,2,['skill2']);assert.ok(guard.state.dungeon.bullets.some(b=>b.reflected),'弹反');
}
function foes(){
  const patrol=arena({enemy:'glove',x:200,override:{patrol:[200,215]}});tick(patrol,10);
  const mid=enemy(patrol).x;assert.ok(mid>200);tick(patrol,19);assert.ok(enemy(patrol).x<mid,'巡逻折返');
  const chase=arena({enemy:'beetle',x:140,override:{contact:false}});tick(chase,15);assert.ok(enemy(chase).x<140);
  until(chase,()=>chase.state.dungeon.hp===fighter.hp-7,'敌人近战');
  const fly=arena({enemy:'aqua',x:180,y:250});tick(fly,20);
  assert.ok(enemy(fly).x<180 && enemy(fly).y!==250,'浮空追击');
  const turret=arena({enemy:'gun',x:180,override:{damage:120,contact:false}});
  until(turret,()=>turret.state.dungeon.hp===0,'枪弹致死');assert.equal(enemy(turret).x,180);
  until(turret,()=>turret.state.dungeon.hp===fighter.hp,'归零重开');assert.equal(turret.state.player.x,300);
}
function walkthrough(){
  const w=createWorld(demo);
  for(let i=0;i<1800 && !w.state.flags.finished;i++){
    const roof=w.state.room==='roof',x=w.state.player.x;
    const interact=Math.abs(x-(roof?900:1060))<22,press=[];
    if(interact || i%40===0)press.push('act');
    if(!interact && i%42===0)press.push('skill1');
    tick(w,1,press,['run','right']);
  }
  assert.equal(w.state.room,'roof','断崖尽头的门');
  assert.equal(w.state.flags.finished,true,'城顶终点');
}
if(!staticOnly){
  for(const [label,test] of Object.entries({图层文字地图:checkGrid,地面三连与空中斩:combat,移动闪避与碰撞:movement,五种技能:powers,四种敌人与重开:foes,双房间通关:walkthrough})){
    try{test();console.log('通过：'+label);}catch(error){console.error('失败：'+label,error.message);process.exitCode=1;}
  }
}

