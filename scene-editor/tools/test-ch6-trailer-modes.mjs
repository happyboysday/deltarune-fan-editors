import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {FORMAT,HZ,validateProject} from '../studio/format.mjs';
import {createWorld,testCondition} from '../studio/world.mjs';
import {drawScene} from '../studio/view.mjs';
import {kartSectionAt,kartTrackPoint} from '../studio/trailer-kart.mjs';
import {roomArtSources} from '../studio/resources.mjs';
import {args,requireData,requirePath} from './test-env.mjs';

const [shelterFile,fixtureDir]=args;
const build=(room,opts={})=>({format:FORMAT,title:'CH6 Trailer Test',viewport:{w:320,h:180},
  start:{room:'slice',entry:'start'},rooms:{slice:room},...opts});
const asset='/ch6-trailer-assets/';
const dungeon=build({
  mode:'dungeon',w:640,h:180,entries:{start:{x:72,y:138,face:'right'},jumpTest:{x:268,y:138}},
  style:'workshop',skyGradient:{top:'#698fde',bottom:'#efffbf'},sunbeams:true,onEnter:'intro',
  entities:[
    {id:'floor',kind:'wall',x:0,y:144,w:640,h:36},
    {id:'ledge',kind:'wall',oneWay:true,x:240,y:105,w:74,h:6},
    {id:'knight',type:'actionEnemy',x:97,y:124,w:18,h:20,hp:6,patrolSpeed:0,shotInterval:0,onDefeat:'kill'},
    {id:'wisp',kind:'actionEnemy',x:157,y:124,w:18,h:20,hp:9,patrolSpeed:0,shotDelay:.38,shotInterval:.65}
  ]
},{events:{
  intro:[{op:'flash',duration:.6,hold:.15,color:'#ffe9b4'}],
  kill:[{op:'flag',id:'knightDefeated',value:true}]
}});
const kart=build({
  mode:'kart',w:320,h:180,entries:{start:{x:160,y:100}},
  kartConfig:{
    trackSegments:[{length:78},{length:110,curve:.40,slope:.11},{length:135,curve:-.48,slope:-.10},{length:160,curve:.43,slope:.06},{length:105}],
    itemBoxes:[{at:29,lane:0}],boostPads:[{at:52,lane:0,width:1.4}],
    opponents:[{id:'gold',lane:-.38,start:43,speed:152},{id:'violet',lane:.44,start:68,speed:167}],
    forceItem:'lancer',onFinish:'finish'
  },
  kartScript:[
    {tick:10,op:'titlecard',title:'SUNLIT HIGHWAY',bg:'transparent',duration:1,fadeIn:.17,fadeOut:.3},
    {at:2.47,hold:['right','dash']},{tick:87,hold:[]},{tick:91,hold:['left']},{tick:103,hold:[]},
    {at:4.7,press:['act']}
  ]
},{events:{finish:[{op:'flag',id:'kartFinished',value:true}]}});
const step=(world,press=[],hold=[])=>world.step({press,hold});
function until(world,predicate,max=180){
  for(let i=0;i<max&&!predicate();i++)step(world);
  assert.ok(predicate(),'condition did not arrive at tick '+world.state.tick);
}

function canvasSpy(w,h){
  const rows=new Set(),colors=new Set(),text=[],gradient={addColorStop(){}};
  let depth=0;
  const ctx={canvas:{width:w,height:h},imageSmoothingEnabled:true, save(){depth++;},
    restore(){assert.ok(depth>0);depth--;}, createLinearGradient(){return gradient;},createRadialGradient(){return gradient;},
    fillRect(x,y,width,height){
      assert.ok([x,y,width,height].every(Number.isFinite));
      if(height===1&&width===w)rows.add(y);
      if(typeof this.fillStyle==='string'&&width>0&&height>0)colors.add(this.fillStyle);
    },
    fillText(s){text.push(s);},measureText(s){return {width:s.length*6};},
    beginPath(){},closePath(){},moveTo(){},lineTo(){},rect(){},clip(){},fill(){},stroke(){},translate(){},scale(){}
  };
  return {ctx,rows,colors,text,check(){assert.equal(depth,0);assert.equal(ctx.imageSmoothingEnabled,false);}};
}
function draw(world,images=new Map()){
  const {w,h}=world.viewport,spy=canvasSpy(w,h);
  const imageCalls=[];
  if(images.size)spy.ctx.drawImage=(img,...rect)=>{
    assert.ok(rect.every(Number.isFinite));
    imageCalls.push({img,rect});
  };
  drawScene(spy.ctx,world.project,world.state.room,{images,maps:{},test:testCondition},
    {state:{...world.state,entities:world.entities()}});
  spy.check();
  return {...spy,imageCalls};
}

function checkDungeon(){
  const world=createWorld(dungeon),s=world.state,d=s.dungeon;
  step(world);
  assert.equal(s.director.flash.color,'#ffe9b4');
  step(world,['act']);
  assert.equal(d.swing.stage,1);
  until(world,()=>d.hitstop===3);
  assert.equal(d.enemies.get('knight').hp,5);
  const {age}=d,{x}=s.player;
  for(let i=2;i>=0;i--){
    step(world,i===2?['act']:[]);
    assert.equal(d.hitstop,i);
    assert.equal(d.age,age);
    assert.equal(s.player.x,x);
  }
  until(world,()=>d.swing?.stage===2);
  draw(world);
  until(world,()=>d.enemies.get('knight').hp===3);
  step(world,['act']);
  until(world,()=>d.swing?.stage===3);
  until(world,()=>d.enemies.get('knight').hp===0);
  assert.equal(d.kills,1);
  assert.ok(s.flags.knightDefeated);
  assert.ok(d.particles.length>16);
  draw(world);

  const powers=createWorld(dungeon),p=powers.state.dungeon;
  until(powers,()=>p.bullets.some(b=>b.x<119));
  step(powers,['skill2','tool']);
  assert.equal(p.parries,1);
  assert.ok(p.deflected>0);
  assert.ok(p.enemies.get('knight').stun>p.age);
  assert.equal(p.wavesCast,1);
  const before=p.enemies.get('wisp').hp;
  until(powers,()=>p.enemies.get('wisp').hp<before);
  assert.ok(p.enemies.get('knight').hp<6,'wave also hit the closer enemy');
  step(powers,['tool','skill2']);
  assert.deepEqual([p.wavesCast,p.parries],[1,1]);

  const dodge=createWorld(dungeon),dodgeState=dodge.state.dungeon;
  step(dodge);
  step(dodge,['dash'],['right']);
  for(let i=0;i<4;i++)step(dodge,[],['right']);
  assert.equal(dodgeState.trail.length,5);
  assert.ok(dodgeState.grazes>0);
  assert.equal(dodgeState.hp,dodgeState.maxHp);
  draw(dodge);

  const patrol=structuredClone(dungeon);
  patrol.rooms.slice.entities.at(-1).patrol=[149,170];
  patrol.rooms.slice.entities.at(-1).patrolSpeed=.8;
  const walkingEnemy=createWorld(patrol);
  for(let i=0;i<12;i++)step(walkingEnemy);
  assert.ok(walkingEnemy.state.dungeon.enemies.get('wisp').x>163);
  const jump=createWorld({...dungeon,start:{room:'slice',entry:'jumpTest'}});
  step(jump);
  step(jump,['up']);
  until(jump,()=>jump.state.player.y<98);
  for(let i=0;i<40;i++)step(jump);
  assert.ok(Math.abs(jump.state.player.y-99)<1,'one-way platform catches the descent');
}

function checkKart(){
  const world=createWorld(kart,{autoplay:true}),k=world.state.kart;
  const first=draw(world);
  assert.ok(first.rows.size>75,'projected grass fill should use scanlines');
  assert.equal(k.position,3);
  assert.ok(first.text.includes('KM/H'));
  const sun=k.sunScale;
  const a=kartTrackPoint(k.track,84),b=kartTrackPoint(k.track,172);
  assert.ok(b.x>a.x&&b.y>a.y,'curved and sloped segments change world projection');
  until(world,()=>!!k.roulette);
  assert.equal(k.pickups,1);
  draw(world);
  until(world,()=>k.item==='lancer');
  until(world,()=>k.drift>=9);
  until(world,()=>k.drift===0);
  assert.ok(k.boostCount>=2,'crossed a pad and released a charged drift');
  until(world,()=>k.lancer?.phase==='throw');
  assert.ok(k.lastTarget);
  until(world,()=>k.lancer?.phase==='drop');
  assert.ok(draw(world).text.includes('HO HO HO!'));
  until(world,()=>k.lancerHits===1);
  assert.ok(k.opponents.some(o=>o.spin>0&&o.id===k.lastTarget));
  assert.ok(draw(world).text.includes('SPLAT!'));
  until(world,()=>k.finished,500);
  assert.equal(k.raceProgress,1);
  assert.ok(k.sunScale>sun*5);
  assert.ok(world.state.flags.kartFinished);
  draw(world);

  const repeat=createWorld(kart,{autoplay:true});
  for(let i=0;i<world.state.tick;i++)step(repeat);
  assert.deepEqual(repeat.state.kart,k,'replay should reach the same complete state');
}

function checkKartCanyon(){
  const project=structuredClone(kart),room=project.rooms.slice;
  Object.assign(room.kartConfig,{
    trackSegments:[{length:26},{length:32,gap:true},{length:50,curve:2.2,bridge:true},{length:120}],
    jumpPads:[{at:23,lane:0,width:1.4,power:1}],
    horizonSprite:asset+'env/parallax_dreamtown.png',
    horizonFarSprite:asset+'env/parallax_meadow_hills.png',
    generateScenery:false,boostPads:[],itemBoxes:[],
    opponents:[{id:'gold',lane:0,start:11,speed:152}]
  });
  const result=validateProject(project);
  assert.equal(result.ok,true,JSON.stringify(result.errors));
  assert.ok(roomArtSources(room).includes(room.kartConfig.horizonFarSprite));
  const far={naturalWidth:160,naturalHeight:40},mid={naturalWidth:160,naturalHeight:40};
  const images=new Map([[room.kartConfig.horizonFarSprite,far],[room.kartConfig.horizonSprite,mid]]);

  const world=createWorld(project),k=world.state.kart;
  assert.equal(kartSectionAt(k.track,26).gap,true);
  assert.equal(kartSectionAt(k.track,58).bridge,true);
  assert.equal(kartSectionAt(k.track,k.track.length),null);
  until(world,()=>k.distance>=18);
  assert.equal(k.airY,0);
  const grounded=draw(world);
  for(const color of ['#5a89c8','#b86d4c','#d8ccb8','#fffdf0','#c94844']){
    assert.ok(grounded.colors.has(color),'expected canyon frame color '+color);
  }
  const backdrop=draw(world,images);
  for(const img of [far,mid]){
    const tiles=backdrop.imageCalls.filter(call=>call.img===img);
    assert.ok(tiles.length>=2);
    for(let i=1;i<tiles.length;i++)assert.equal(tiles[i-1].rect[0]+tiles[i-1].rect[2],tiles[i].rect[0]);
  }
  until(world,()=>k.airborne);
  assert.ok(k.jumpCount>=1&&k.airY>0&&k.jumps[0].last===k.age);
  assert.ok(k.distance<26,'the pad launches before the canyon lip');
  until(world,()=>kartSectionAt(k.track,k.distance)?.gap);
  assert.ok(k.airborne&&k.opponents.some(o=>o.airY>0));
  draw(world);
  until(world,()=>!k.airborne);
  assert.ok(k.distance>=58,'the kart clears the canyon before landing');
  assert.deepEqual([k.airY,k.airVy,k.landFlash],[0,0,10]);
  assert.ok(draw(world).colors.has('#ffb24d'));
  const repeat=createWorld(project);
  for(let i=0;i<world.state.tick;i++)step(repeat);
  assert.deepEqual(repeat.state.kart,k);

  const gapOnly=structuredClone(project);
  gapOnly.rooms.slice.kartConfig.jumpPads[0].lane=1.25;
  const lipWorld=createWorld(gapOnly),lipKart=lipWorld.state.kart;
  until(lipWorld,()=>lipKart.airborne);
  assert.ok(kartSectionAt(lipKart.track,lipKart.distance)?.gap,'missing the ramp launches from the canyon lip');
  assert.equal(lipKart.jumps[0].last,-999);
}

function checkDirector(){
  const p=structuredClone(dungeon);
  p.navScript=[
    {tick:2,op:'shake',intensity:8,duration:.35},
    {tick:4,op:'titlecard',title:'不屬於暗世界的光彩',bg:'transparent',duration:.4,fadeIn:0},
    {tick:8,op:'fade',to:'black',duration:.3},
    {tick:22,op:'fade',to:'clear',duration:.3}
  ];
  const w=createWorld(p,{autoplay:true}),s=w.state;
  until(w,()=>s.tick===6);
  assert.ok(s.director.shake&&s.director.title);
  assert.ok(draw(w).text.includes('不屬於暗世界的光彩'));
  until(w,()=>s.tick===21);
  assert.equal(s.director.fade.to.alpha,1);
  assert.equal(s.director.flash,undefined);
  until(w,()=>s.tick===25);
  assert.equal(s.director.fade.from.alpha,1);
  assert.equal(s.director.fade.to.alpha,0);
  draw(w);
  assert.equal(w.hz,HZ);
  p.navScript.push({tick:29,at:3,press:['bogus']});
  assert.equal(validateProject(p).ok,false);
}

function checkShelter(){
  const file=shelterFile?requirePath(shelterFile,'第 6 章避难所工程'):
    requireData('projects/ch6-deep-shelter.scene.json')[0];
  const project=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const world=createWorld(project);
  for(let i=0;i<120;i++)step(world);
  assert.equal(world.state.room,project.start.room);
  assert.equal(world.state.dungeon,undefined);
  assert.equal(world.state.kart,undefined);
  assert.ok(world.entities().length>0);
}

for(const [name,check] of [['dungeon',checkDungeon],['kart',checkKart],['kart canyon',checkKartCanyon],
  ['Director FX',checkDirector],['Deep Shelter',checkShelter]]){
  check();
  console.log(name+' OK');
}

if(fixtureDir){
  const dungeonShots=structuredClone(dungeon),r=dungeonShots.rooms.slice;
  r.parallax=[
    {src:asset+'env/parallax_clouds.png',height:90,speedX:.22},
    {src:asset+'env/parallax_dreamtown.png',height:90,y:39,speedX:.44},
    {src:asset+'env/parallax_meadow_hills.png',height:80,y:74,speedX:.65}
  ];
  r.dungeonConfig={slashSprites:[1,2,3].map(i=>asset+'dungeon/slash_arc_'+i+'.png'),waveSprite:asset+'dungeon/crescent_wave.png',
    parrySprite:asset+'dungeon/soul_parry_ring.png'};
  r.navScript=[{tick:2,press:['act']},{tick:12,press:['act']},{tick:23,press:['act']},
    {tick:44,press:['tool']},{tick:50,press:['skill2']},{tick:74,hold:['right'],press:['dash']},{tick:80,hold:[]}];
  const kartShots=structuredClone(kart),k=kartShots.rooms.slice.kartConfig;
  kartShots.viewport={w:640,h:360};
  k.playerSprites=Object.fromEntries(['straight','left1','left2','right1','right2','boost'].map(p=>[p,asset+'kart/kris_kart_'+p+'.png']));
  k.lancerIcon=asset+'kart/item_lancer_icon.png';
  k.lancerSprite=asset+'kart/lancer_drop.png';
  k.itemBoxSprite=asset+'kart/item_box.png';
  k.sunSprite=asset+'solux/solux_sun.png';
  k.bulbSprite=asset+'solux/solux_bulb.png';
  k.rivalSprites={gold:asset+'kart/rival_kart_soldier.png',violet:asset+'kart/rival_kart_sunflower.png'};
  mkdirSync(fixtureDir,{recursive:true});
  for(const [name,project] of Object.entries({dungeon:dungeonShots,kart:kartShots,'kart fallback':kart})){
    assert.equal(validateProject(project).ok,true);
    writeFileSync(join(fixtureDir,name+'.scene.json'),JSON.stringify(project,null,2)+'\n');
  }
}
