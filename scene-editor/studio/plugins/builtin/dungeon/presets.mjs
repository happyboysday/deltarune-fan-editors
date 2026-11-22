// Chapter 5 source names, origins and controller references are documented in docs/地下城玩法.md.
export const OFFICIAL_ASSET_BASE = '/official/';
const still = name => OFFICIAL_ASSET_BASE + 'sprites/ch5/all_sprites/' + name + '.png';
// obj_plat_entity.Create sets both sprite axes to 2; obj_plat_player.Step flips X to ±2.
const actorStill = name => ({frames:[still(name)],scale:2,anchor:'feet'});
const frames = (folder, start, count) => Array.from({length:count}, (_, i) =>
  OFFICIAL_ASSET_BASE + folder + '/frame_' + String(start+i).padStart(3,'0') + '.png');

export function officialKrisFighter() {
  const assets = {};
  // Feet are 18 native pixels below obj_plat_player's origin (half the idle canvas).
  function action(slot, folder, name, count, ticks, w, h, ox, oy, loop=false, start=0) {
    const id = 'kris_' + slot;
    assets[id] = {frames:folder ? frames('animations/Kris/'+folder+'/'+name,start,count) : [still(name)],
      ticks,loop,scale:2,anchor:'feet',offset:[w/2-ox,h-oy-18]};
    return id;
  }
  const plat = 'spr_kris_plat_';
  const anims = {
    idle:action('idle','idle',plat+'idle',3,4,34,36,24,18,true),
    walk:action('walk','walk',plat+'run',6,4,41,34,25,16,true),
    run:action('run','walk',plat+'run',6,2,41,34,25,16,true),
    turn:action('turn',null,plat+'turn',1,2,41,34,17,16),
    jump:action('jump','fall','spr_kris_jump_up',3,4,48,37,32,16),
    fall:action('fall','fall','spr_kris_jump_down',3,4,38,46,23,21,true),
    land:action('land','misc',plat+'land',2,4,54,33,36,14),
    hurt:action('hurt',null,plat+'hurt_ground',1,4,40,50,16,30),
    down:'kris_down',
    hurtAir:action('hurt_air',null,plat+'hurt_air',1,4,40,50,13,30),
    climb:action('climb','fall',plat+'climb',6,4,29,42,14,21,true),
    clash:action('clash','misc',plat+'clash',2,3,50,40,25,20),
    pose:action('pose',null,plat+'pose',1,4,29,40,14,22),
    airLand:action('air_land','attack',plat+'slash_airland',2,2,99,90,43,43),
    dodge:'kris_run'
  };
  // The dark-world fallen pose touches the bottom of its canvas. Keep the feet at ground level.
  assets.kris_down = actorStill('spr_kris_fallen_dark');
  // Inclusive alpha bounds of hbx frames 0..2, translated by (-43,-43-18), then doubled into room pixels.
  const attacks = [[-36,-98,116,110],[14,-110,66,142],[-48,-122,148,146]].map(([x,y,w,h],i)=>{
    const count = i===2 ? 5 : 4;
    const slice = suffix => action('slash'+(i+1)+suffix,'attack',plat+'slash_ground'+suffix,count,2,99,90,43,43,false,i*4);
    return {anim:slice(''),effect:slice('_foreground'),windup:2,active:3,recovery:count*2-5,
      hitbox:{x,y,w,h},damage:2+i,lunge:1,hitstop:[3,7,8][i],knockback:2+i};
  });
  const air = suffix => action('air'+suffix,'attack',plat+'slash_air'+suffix,17,2,99,90,52,41);
  const airAttack = {anim:air(''),effect:air('_foreground'),windup:2,active:6,recovery:26,
    hitbox:{x:-56,y:-110,w:144,h:144},damage:3,lunge:1,hitstop:4,knockback:3};
  assets.sun_shot = {...actorStill('spr_plat_bullet_yellow'),anchor:'center'};
  const skills = [
    {id:'spark',name:'金星',input:'skill1',type:'projectile',anim:anims.turn,sprite:'sun_shot',cooldown:0.8,cast:2,
      projectile:{speed:8,life:45,w:24,h:24,damage:3,count:1}},
    {id:'guard',name:'架剑',input:'skill2',type:'parry',anim:anims.turn,cooldown:1,cast:0,parry:{radius:48,window:8,reflect:true,stun:15}},
    {id:'rush',name:'破阵',input:'skill3',type:'dash',anim:anims.dodge,cooldown:1.5,cast:2,dash:{speed:9,ticks:8,damage:4,invulnerable:6}},
    {id:'recover',name:'振作',input:'skill4',type:'heal',anim:anims.idle,cooldown:3,cast:8,heal:{amount:16}}
  ];
  return {assets,fighter:{name:'Kris',hp:120,box:{w:36,h:68},walkSpeed:6,runSpeed:9,jump:20,
    anims,attacks,airAttack,comboWindow:15,dodge:{anim:anims.dodge,ticks:9,speed:11,invulnerable:8,cooldown:.4,afterimages:true},skills}};
}

export const OFFICIAL_TILESETS = [
  {id:'bg_dw_castletop_tileset_new',label:'城顶回廊',cols:17,rows:18},
  {id:'tiles_cliff_dark_new',label:'暮色断崖',cols:21,rows:22}
].map(set=>({...set,src:OFFICIAL_ASSET_BASE+'maps/ch5/tilesets/'+set.id+'.png',tile:40,border:2}));

export function officialTileParts(set=OFFICIAL_TILESETS[0].id) {
  const id = typeof set==='string' ? set : set.id;
  const castle = id===OFFICIAL_TILESETS[0].id;
  if(!castle && id!==OFFICIAL_TILESETS[1].id) throw new RangeError('未知的第 5 章瓦片集：'+id);
  const definitions = castle ? [
    ['brick','b','砖壁',5,'back'],['floor','s','城墙',45,'actor','solid'],['ledge','l','窄台',122,'actor','oneway'],
    ['column','p','前景柱身',22,'front'],['capital','c','柱头',2,'front'],['base','v','近处浮雕',11,'actor']
  ] : [
    ['rock','r','远岩',135,'back'],['soil','g','崖顶',76,'actor','solid'],['shelf','t','浮岩',125,'actor','oneway'],
    ['root','f','前景岩缘',155,'front'],['spur','a','岩角',30,'actor']
  ];
  const assets={}, tileParts={};
  for(const [key,sym,label,index,layer,solid='none'] of definitions) {
    const sprite='ch5_'+key;
    // The catalog numbers crops from 1; definitions above index atlas cells from 0.
    assets[sprite]='/a-files/exports/derived/tiles/ch5/'+id+'/tile_'+String(index+1).padStart(4,'0')+'.png';
    tileParts[key]={sym,label,sprite,cells:[1,1],layer,solid};
    if(layer==='actor' && solid==='none') tileParts[key].depth=6;
  }
  return {assets,tileParts};
}

export function officialEnemyTypes() {
  const assets = {}, enemyTypes = {};
  function sequence(name,indices,ticks){
    return {frames:indices.map(i=>'/studio/art/dungeon-ch5/'+name+'_'+String(i).padStart(3,'0')+'.png'),
      ticks,scale:2,anchor:'feet'};
  }
  // The gun holds frame 0 at rest. On fire the GML selects frame 1 for four ticks.
  const gun='spr_fyellow_gun';
  assets.gun_rest=sequence(gun,[0],4);
  assets[gun]=sequence(gun,[1,2,0],4);
  assets.spr_forange_largeglove=sequence('spr_forange_largeglove',[0,1,2,3,4,5],4);
  assets.spr_forange_glove=sequence('spr_forange_glove',[0,1,2],2);
  assets.spr_shinobeetle_hurt=sequence('spr_shinobeetle_hurt',[0,1],2);
  assets.spr_faqua_small=sequence('spr_faqua_small',[0,1,2,3,4],4);
  assets.spr_faqua_spin=sequence('spr_faqua_spin',[0,1,2,3,4],4);
  assets.spr_faqua_blur=sequence('spr_faqua_blur',[0,1,2],4);
  for(const [id,sym,label,ai,idle,attack,hurt] of [
    ['glove','G','拳套','patrol','spr_forange_largeglove','spr_forange_largeglove_angry','spr_forange_glove'],
    ['beetle','J','忍甲虫','chase','spr_shinobeetle','spr_shinobeetle_pose','spr_shinobeetle_hurt'],
    ['gun','T','金枪','turret','gun_rest',gun,'gun_rest'],
    ['aqua','A','水刃','flyer','spr_faqua_small','spr_faqua_spin','spr_faqua_blur']
  ]) {
    for(const name of [idle,attack,hurt]) assets[name]??=actorStill(name);
    const enemy={sym,label,cells:[1,2],hp:8,damage:5,contact:true,box:{w:48,h:60},ai,
      speed:ai==='turret'?0:1,aggroRange:220,gravity:ai!=='flyer',anims:{idle,move:idle,attack,hurt,die:hurt}};
    if(ai==='turret') {
      assets.sun_shot={...actorStill('spr_plat_bullet_yellow'),anchor:'center'};
      enemy.shoot={interval:1.6,delay:.6,speed:4,count:1,spread:0,range:240,sprite:'sun_shot'};
    }
    if(ai==='chase') enemy.melee={range:60,windup:8,active:3,recovery:12,hitbox:{x:0,y:-64,w:64,h:64},damage:7};
    enemyTypes[id]=enemy;
  }
  // Full-frame shared sprites also present in the chapter 5 sprite table.
  for(const [id,sym,label,ai,poses] of [
    ['jigsawry','I','拼图兵','patrol',{idle:['jigsawry_idle',6],hurt:['jigsawry_wounded',6],die:['jigsawry_clobbered',1]}],
    ['ponman','M','棋兵','chase',{idle:['ponman_idle',4],attack:['ponman_appear',6],hurt:['ponman_touched',1],die:['ponman_dark',1]}]
  ]) {
    const anims={};
    for(const [slot,[pose,count]] of Object.entries(poses)){
      const key='spr_'+pose;
      assets[key]={frames:frames('enemy-animations/enemies/'+key,0,count),ticks:4,loop:slot==='idle',anchor:'feet',scale:2};
      anims[slot]=key;
    }
    enemyTypes[id]={sym,label,cells:[1,2],ai,hp:7,damage:4,contact:true,gravity:true,speed:.8,aggroRange:160,
      box:{w:48,h:64},anims:{...anims,move:anims.idle}};
  }
  return {assets,enemyTypes};
}
