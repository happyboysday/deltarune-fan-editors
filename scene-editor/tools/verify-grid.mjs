// 逐格编辑回归检查：node tools/verify-grid.mjs
// 1. 示例工程每个房间：文字地图来回一次，实体 ID、位置、入口完全不变。
// 2. 用文字地图新建房间、移动物件（保留属性）、改大小、自定义多格零件。
// 3. 错误的文字地图给出行列位置。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spritePose} from '../studio/anim-preview.mjs';
import {validateProject} from '../studio/format.mjs';
import {toText,fromText,writeGrid,projectIds,roomFromText,editRoom,paint,erase,fill,resize,readGrid,registry,eraseRect} from '../studio/grid.mjs';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
let failures=0;
function check(name,ok,detail=''){console.log((ok?'✓ ':'✗ ')+name+(ok||!detail?'':' · '+detail));if(!ok)failures++;}
const rows=t=>t.split('\n').filter(l=>l&&!l.startsWith(';')).map(l=>l.split(' ')[0]);

for(const file of ['echo-workshop.scene.json','paper-gate.scene.json','ember-relay.scene.json']){
  const p=JSON.parse(fs.readFileSync(path.join(root,'examples',file),'utf8'));
  for(const [key,room] of Object.entries(p.rooms)){
    const out=writeGrid(room,fromText(room,toText(room,key)),projectIds(p));
    const same=room.entities.every(e=>{const o=out.entities.find(x=>x.id===e.id);return o&&JSON.stringify(o)===JSON.stringify(e);})&&out.entities.length===room.entities.length;
    check(`${file} · ${key} 文字地图来回不变`,same&&JSON.stringify(out.entries)===JSON.stringify(room.entries));
  }
}

const parts={long_bench:{sym:'L',label:'长椅',kind:'prop',sprite:'bench',cells:[4,1],props:{solid:true}}};
const map=['################','#..@......N....#','#..........~~~.#','#..Zzz.....~~~.D','#..zzz.....~~~.d','#......B..S....#','#..Llll........#','#####----#######'].join('\n');
const room=roomFromText(map,{parts});
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
let p={format:'deltarune-scene/1',title:'grid',start:{room:'r',entry:Object.keys(room.entries)[0]},rooms:{r:room},events:{hi:[{op:'say',pages:['你好']}]},assets:{bench:png},gridParts:parts};
check('文字地图新建房间通过校验',validateProject(p).ok,JSON.stringify(validateProject(p).errors));
check('原样输出',JSON.stringify(rows(toText(room,'r',{parts})))===JSON.stringify(rows(map)));
const bench=room.entities.find(e=>e.sprite==='bench');
check('自定义零件写成 4×1 格、带素材和属性',bench&&bench.w===80&&bench.h===20&&bench.solid===true);
check('连成一片的墙合并成矩形',room.entities.filter(e=>e.kind==='wall'&&!e.oneWay).length===6);

p.rooms.r.entities.find(e=>e.kind==='npc').event='hi';
const moved=toText(p.rooms.r,'r',{parts}).replace('#..@......N....#','#..@..N........#');
const r2=writeGrid(p.rooms.r,fromText(p.rooms.r,moved,{parts}),projectIds(p));
const npc=r2.entities.find(e=>e.kind==='npc');
check('文字地图里挪动物件保留 ID 和事件',npc.id===p.rooms.r.entities.find(e=>e.kind==='npc').id&&npc.event==='hi'&&npc.x===120);

const p3=editRoom(p,'r',m=>{paint(m,5,2,'wall');fill(m,1,5,2,5,'slide');erase(m,10,1);});
check('画笔、矩形、橡皮之后仍通过校验',validateProject(p3).ok);
const p4=editRoom(p,'r',m=>resize(m,m.objects.find(o=>o.part==='long_bench'),6,1));
check('改占格：长椅变 6 格宽',p4.rooms.r.entities.find(e=>e.sprite==='bench').w===120);
check('格子被占时不能放',editRoom(p,'r',m=>paint(m,4,6,'npc'))===null);

for(const [bad,want] of [[moved.replace('#..@..N........#','#..@..N.......#'),'第 1 行'],[moved.replace('#..zzz.....~~~.d','#..zz......~~~.d'),'第 4 行'],[moved.replace('#..@..N........#','#..@..x........#'),'第 1 行']]){
  try{fromText(p.rooms.r,bad,{parts});check('错误地图应报错：'+want,false);}catch(ex){check('错误地图报出位置：'+ex.message.slice(0,24),ex.message.startsWith(want));}
}
// V0.7：不同层允许共占一格。保留实例覆盖、旧瓦片和原实体顺序。
const official='/a-files/official/';
const scene={
  assets:{cliffs:official+'maps/ch5/tilesets/tiles_cliff.png',enemy_idle:official+'enemy-animations/enemies/spr_jigsawry_idle/frame_000.png'},
  gridParts:parts,
  tileParts:{cliff:{sym:'a',cells:[2,1],sprite:'cliffs',layer:'back'}, floor:{sym:'1',cells:[1,1],layer:'actor',solid:'oneway',depth:4},
    flowers:{sym:'f',layer:'front',cells:[1,2]}},
  enemyTypes:{guard:{sym:'G',cells:[1,2],anims:{idle:'enemy_idle'}}}
};
const dungeon={title:'Cliffs',mode:'dungeon',w:160,h:100,entries:{start:{x:10,y:10}},entities:[
  {id:'guard_7',kind:'actionEnemy',enemyType:'guard',hp:19,x:40,y:20,w:20,h:40},
  {id:'unaltered_wall',kind:'wall',x:40,y:20,w:20,h:20}],
  tiles:[{part:'cliff',x:40,y:20,w:40,h:20,depth:11,activeWhen:{flag:'seen'}},
    {part:'cliff',x:80,y:20,w:40,h:20},{part:'floor',x:40,y:20,w:20,h:20},
    {part:'flowers',x:40,y:20,w:20,h:40},{sprite:'cliffs',x:121,y:20,w:16,h:16,front:true},
    {part:'cliff',layer:'front',depth:7,x:80,y:60,w:40,h:20}]};
scene.rooms={cliff:dungeon};
const opts=layer=>({project:scene,layer});
for(const layer of ['collision','back','actor','front','objects']){
  const t=toText(dungeon,'cliff',opts(layer)), m=fromText(dungeon,t,opts(layer));
  check(layer+' 图层逐字段往返',JSON.stringify(dungeon)===JSON.stringify(writeGrid(dungeon,m,projectIds(scene))));
}
const combined=writeGrid(dungeon,fromText(dungeon,toText(dungeon,'cliff',{project:scene}),{project:scene}),projectIds(scene));
check('合并地图保留地下城敌人脚下的碰撞',JSON.stringify(combined)===JSON.stringify(dungeon));
const staggered={...dungeon,entities:[
  {id:'top',kind:'actionEnemy',enemyType:'guard',x:40,y:0,w:20,h:20},
  {id:'lower',kind:'actionEnemy',enemyType:'guard',x:20,y:20,w:40,h:20}
]};
const objectOpts=opts('objects'), staggeredMap=toText(staggered,'cliff',objectOpts);
check('错位相邻的同符号物件保留各自尺寸',JSON.stringify(staggered)===JSON.stringify(writeGrid(staggered,fromText(staggered,staggeredMap,objectOpts))));
const outside={...dungeon,tiles:[{part:'cliff',x:-20,y:0,w:40,h:20,activeWhen:{flag:'seen'}}]};
const backOpts=opts('back');
check('房间边缘外的旧实例保留原坐标',JSON.stringify(outside)===JSON.stringify(writeGrid(outside,fromText(outside,toText(outside,'cliff',backOpts),backOpts))));
const reg=registry(parts,scene.tileParts,scene.enemyTypes);
check('注册三类工程零件',reg.bySym.L.custom && reg.bySym.a.tileKey==='cliff' && reg.bySym.G.props.enemyType==='guard');
for(const [name,extra] of [['内置','N'],['自定义','L'],['敌人','G']]){
  try{registry(parts,{}, {...scene.enemyTypes,duplicate:{sym:extra}});check(name+' 符号冲突',false);}
  catch(ex){check(name+' 符号冲突',ex.message.includes('冲突'));}
}
try{registry({}, {...scene.tileParts,dup:{sym:'a',layer:'front'}});check('跨层重复方块符号',false);}
catch(ex){check('跨层重复方块符号',ex.message.includes('冲突'));}
const eraseBack=editRoom(scene,'cliff',m=>eraseRect(m,2,1,3,1),opts('back')).rooms.cliff;
check('背景矩形橡皮只移除目标零件',JSON.stringify(eraseBack.tiles)===JSON.stringify(dungeon.tiles.slice(1)) && JSON.stringify(eraseBack.entities)===JSON.stringify(dungeon.entities));
const addEnemies=editRoom(scene,'cliff',m=>fill(m,4,0,5,1,'enemy:guard'),opts('objects')).rooms.cliff;
check('矩形敌人按定义占格，保留墙和方块',addEnemies.entities.filter(e=>e.enemyType==='guard' && e.h===40).length===3 &&
  JSON.stringify(addEnemies.tiles)===JSON.stringify(dungeon.tiles) && addEnemies.entities.some(e=>e.id==='unaltered_wall'));
const cleared=editRoom(scene,'cliff',m=>erase(m,2,1),opts('collision')).rooms.cliff;
check('碰撞橡皮只删墙',cleared.entities.length===1 && cleared.entities[0].id==='guard_7' && cleared.tiles.length===dungeon.tiles.length);
const movedTile=toText(dungeon,'cliff',opts('back')).replace('..aaaa..','aa..aa..');
const tm=writeGrid(dungeon,fromText(dungeon,movedTile,opts('back')),projectIds(scene));
check('移动多格方块保留条件、深度',tm.tiles[0].x===0 && tm.tiles[0].depth===11 && tm.tiles[0].activeWhen.flag==='seen');
const enemyMap=toText(dungeon,'cliff',opts('objects')).replace('..G.....','....G...').replace('..g.....','....g...');
const em=writeGrid(dungeon,fromText(dungeon,enemyMap,opts('objects')),projectIds(scene));
check('移动敌人保留类型、实例 HP、ID',em.entities[0].enemyType==='guard' && em.entities[0].hp===19 && em.entities[0].x===80 && em.entities[0].id==='guard_7');
check('跨层画笔和锁定旧瓦片拒绝修改',!paint(readGrid(dungeon,opts('front')),0,0,'tile:floor') && !erase(readGrid(dungeon,opts('front')),6,1));
for(const [layer,a,b] of [['back','..aaaa..','..aaa...'],['front','?','.'],['actor','..1.....','..G.....']]){
  const t=rows(toText(dungeon,'cliff',opts(layer))).join('\n').replace(a,b);
  try{fromText(dungeon,t,opts(layer));check('应拒绝 '+layer+' 错误地图',false);}catch(ex){check('拒绝 '+layer+' 错误地图',ex.message.includes('列'));}
}
// 官方地面斩击单帧的原生画布和原点，偏移与贴图随 scale 放大。
const slash={anchor:'feet',offset:[6.5,29],scale:2}, image={naturalWidth:99,naturalHeight:90};
const right=spritePose(slash,image,200,200),left=spritePose(slash,image,200,200,-1);
check('2 倍斩击原生偏移对齐脚底',right.x===114 && right.y===78 && right.sx===2 && right.sy===2);
check('左向斩击绕脚底镜像',left.x===286 && left.y===78 && left.sx===-2);
const flip=spritePose({...slash,flip:true},image,200,200);
check('素材 flip 保留右向偏移',flip.x===312 && flip.sx===-2 && flip.y===78);
const tile=spritePose({anchor:'center',scale:.5,offset:[2,-4]},image,80,120,1,{w:40,h:80});
check('缩放方块以实例锚点定位',tile.x===91 && tile.y===138 && tile.w===40 && tile.h===80);
console.log(failures?`${failures} 项失败`:'全部通过');
process.exitCode=failures?1:0;
