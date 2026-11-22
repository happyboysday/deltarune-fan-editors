import {HZ} from '../../../timing.mjs';
import {defaults} from './defaults.mjs';

import {animation,dungeonBox,relativeBox} from './data.mjs';
import {typedEnemy} from './enemies.mjs';

export const SLASHES=[
  {life:8,windup:1,active:3,reach:26,height:13,damage:1,lunge:3.8},
  {life:9,windup:1,active:4,reach:31,height:21,damage:2,lunge:4.5},
  {life:13,windup:2,active:5,reach:44,height:25,damage:3,lunge:6.2}
];
export const DASH_FRAMES=5;
// SOUL mode: an enemy with a `soul` spec pulls Kris's heart into a bullet box for a few seconds.
export const SOUL_ENTER=10,SOUL_EXIT=10;
// ACT/spare: an enemy with a `spare` spec can be spared with the `spare` key; it floats away instead of dying.
export const SPARE_TICKS=30;
const DODGE_FRAMES=Math.ceil(.28*HZ);
const COMBO_WINDOW=15;
const PARTICLE_LIMIT=120;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const time=seconds=>Math.max(1,Math.round(seconds*HZ));
const facing=p=>p.face==='left'?-1:1;
const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
const solid=e=>e.kind!=='actionEnemy'&&(e.kind==='wall'||e.kind==='block'||e.solid);

export function createDungeon(room,project={}){
  const cfg=room.dungeonConfig??{};
  const fighter=project.fighters?.[cfg.fighter??project.player?.fighter];
  const maxHp=fighter?.hp??cfg.maxHp??100;
  return {
    fighter,radius:project.player?.radius??6,assets:project.assets,state:'idle',stateAt:0,ready:{},dodgeReady:0,clock:0,areas:[],age:0,hp:maxHp,maxHp,kills:0,hits:0,combo:0,comboUntil:0,comboStage:0,chainUntil:0,swing:null,
    queuedSlash:false,hitstop:0,buffer:new Set(),invulnerableUntil:0,hurtUntil:0,hurtDir:0,retryAt:0,
    dash:null,trail:[],grazes:0,pop:null,parry:null,waves:[],bullets:[],enemies:new Map(),particles:[],seed:0x2347c9ab,
    waveCooldown:time(cfg.waveCooldown??1.2),parryCooldown:time(cfg.parryCooldown??2),waveReady:0,parryReady:0,
    wavesCast:0,parries:0,deflected:0,soul:null,spares:0,actPop:null
  };
}

function random(d){
  d.seed=(Math.imul(d.seed,1664525)+1013904223)>>>0;
  return d.seed/0x100000000;
}

function burst(d,x,y,count,colors,force=3){
  for(let i=0;i<count;i++){
    const angle=random(d)*Math.PI*2, speed=(.2+random(d))*force;
    const life=6+Math.floor(random(d)*12);
    d.particles.push({x,y,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-.6,life,max:life,
      size:2+Math.floor(random(d)*3),color:colors[i%colors.length]});
  }
  if(d.particles.length>PARTICLE_LIMIT)d.particles.splice(0,d.particles.length-PARTICLE_LIMIT);
}

function syncEnemies(d,active,hooks){
  const visible=[];
  for(const spec of active){
    if(spec.kind!=='actionEnemy')continue;
    let enemy=d.enemies.get(spec.id);
    if(!enemy){
      const maxHp=spec.hp??6;
      enemy={x:spec.x,y:spec.y,w:spec.w,h:spec.h,baseX:spec.x,baseY:spec.y,hp:maxHp,maxHp,dir:1,
        knock:0,flash:0,stun:0,shot:d.age+Math.round((spec.shoot?.delay??spec.shotDelay??.6)*HZ),grazed:false};
      d.enemies.set(spec.id,enemy);
    }
    enemy.x+=spec.x-enemy.baseX;
    enemy.y+=spec.y-enemy.baseY;
    enemy.baseX=spec.x;
    enemy.baseY=spec.y;
    if(enemy.deathEnd!=null&&d.age>=enemy.deathEnd){enemy.deathEnd=null;hooks.defeated(spec);}
    if(enemy.hp>0)visible.push({spec,enemy});
  }
  return visible;
}

function fire(d,enemy,spec,p){
  const x=enemy.x+enemy.w/2,y=enemy.y+enemy.h/2;
  if(Math.hypot(p.x-x,p.y-y)>(spec.shoot?.range??spec.fireRange??220)||spec.shotInterval===0)return;
  const angle=Math.atan2(p.y-y,p.x-x),speed=spec.shoot?.speed??spec.bulletSpeed??3.4,shots=spec.shoot?.count??spec.shots??1;
  for(let i=0;i<shots&&d.bullets.length<144;i++){
    const a=angle+(i-(shots-1)/2)*(spec.enemyType?(spec.shoot?.spread??0)*Math.PI/180:.19);
    d.bullets.push({x,y,vx:Math.cos(a)*speed,vy:Math.sin(a)*speed,life:90,damage:spec.damage??12,
      owner:spec.id,born:d.age,sprite:spec.shoot?.sprite,color:spec.shoot?.color??spec.bulletColor??'#ff72a7',reflected:false,grazed:false});
  }
}

function startSoul(d,p,enemy,spec){
  const s=spec.soul,ex=enemy.x+enemy.w/2;
  d.soul={owner:spec.id,at:d.age,ticks:time(s.seconds??2.8),w:s.w??150,h:s.h??110,
    cx:Math.round((p.x+ex)/2),cy:Math.round(p.y-(s.lift??96)),heart:{x:p.x,y:p.y-34},release:null,
    shots:[],damage:s.damage??6,rain:s.rain??6,sweep:s.sweep??16,speed:s.speed??1,pop:null,stunAfter:time(s.stunAfter??1.5)};
  enemy.soulDone=true;
  d.swing=d.dash=d.casting=null;d.queuedSlash=false;d.bullets=[];
}

function stepSoul(d,p,input,hooks){
  const s=d.soul,t=d.age-s.at,end=SOUL_ENTER+s.ticks;
  const home={x:p.x,y:p.y-34},box={x:s.cx-s.w/2,y:s.cy-s.h/2,w:s.w,h:s.h};
  if(s.pop&&d.age>=s.pop.until)s.pop=null;
  if(t<SOUL_ENTER){
    const u=t/SOUL_ENTER;
    s.heart.x=home.x+(s.cx-home.x)*u;s.heart.y=home.y+(s.cy-home.y)*u;
    return;
  }
  if(t>=end){
    s.release??={...s.heart};s.shots=[];
    const u=Math.min(1,(t-end)/SOUL_EXIT);
    s.heart.x=s.release.x+(home.x-s.release.x)*u;s.heart.y=s.release.y+(home.y-s.release.y)*u;
    if(t>=end+SOUL_EXIT){
      // The caster is left dizzy after its big attack, which opens it up for a finisher.
      const owner=d.enemies.get(s.owner);
      if(owner){owner.stun=Math.max(owner.stun,d.age+s.stunAfter);owner.melee=null;}
      d.soul=null;d.invulnerableUntil=Math.max(d.invulnerableUntil,d.age+12);
    }
    return;
  }
  const mx=Number(input.hold.has('right'))-Number(input.hold.has('left'));
  const my=Number(input.hold.has('down'))-Number(input.hold.has('up'));
  s.heart.x=clamp(s.heart.x+mx*2.8,box.x+8,box.x+box.w-8);
  s.heart.y=clamp(s.heart.y+my*2.8,box.y+8,box.y+box.h-8);
  const k=t-SOUL_ENTER;
  if(k%s.rain===0)s.shots.push({x:box.x+8+random(d)*(box.w-16),y:box.y+3,vx:0,vy:(2+random(d)*1.3)*s.speed});
  if(k%s.sweep===Math.floor(s.sweep/2)){
    const left=Math.floor(k/s.sweep)%2===0;
    s.shots.push({x:left?box.x+3:box.x+box.w-3,y:box.y+12+random(d)*(box.h-24),vx:(left?3.2:-3.2)*s.speed,vy:0,ray:true});
  }
  for(const b of s.shots){
    b.x+=b.vx;b.y+=b.vy;
    const dist=Math.hypot(b.x-s.heart.x,b.y-s.heart.y);
    if(dist<6){
      if(d.age>=d.invulnerableUntil){
        d.hp=Math.max(1,d.hp-s.damage);d.invulnerableUntil=d.age+18;hooks.shake(3);
        burst(d,s.heart.x,s.heart.y,9,['#ff4169','#fff2df','#ff93c7'],2.4);
      }
      b.dead=true;
    }else if(dist<14&&!b.grazed){
      b.grazed=true;d.grazes++;s.pop={x:s.heart.x+10,y:s.heart.y-10,text:'GRAZE',until:d.age+14};
    }
  }
  s.shots=s.shots.filter(b=>!b.dead&&b.x>box.x-4&&b.x<box.x+box.w+4&&b.y>box.y-4&&b.y<box.y+box.h+4);
}

function trySpare(d,p,live){
  let best=null;
  for(const {enemy,spec} of live){
    if(!spec.spare||enemy.spared!=null||enemy.hp<=0)continue;
    const dist=Math.abs(enemy.x+enemy.w/2-p.x);
    if(dist<=(spec.spare.range??72)&&(!best||dist<best.dist))best={enemy,spec,dist};
  }
  if(!best)return false;
  const {enemy,spec}=best;
  enemy.spared=d.age;enemy.stun=d.age+SPARE_TICKS+30;enemy.melee=null;
  d.spares++;
  d.actPop={text:spec.spare.text??'ACT',x:p.x,y:p.y-(d.fighter?.box?.h??60)-38,until:d.age+40};  // above the SPARE tag
  const pose=d.fighter?.anims?.pose;
  if(pose){d.skill={anim:pose};d.casting={skill:{type:'act',anim:pose},at:d.age+(spec.spare.cast??12)};d.skillAt=d.age;}
  burst(d,enemy.x+enemy.w/2,enemy.y+enemy.h/2,14,['#ffe866','#fff7c2','#ffffff'],2.6);
  return true;
}

function stepEnemies(d,live,p,room,walls,body,hooks){
  for(const {enemy,spec} of live){
    if(enemy.hp<=0)continue;
    if(spec.enemyType){
      typedEnemy(d,enemy,spec,p,body,room,walls,(n,x)=>damagePlayer(d,p,n,x,hooks),
        ()=>fire(d,enemy,spec,{x:p.x,y:body.y+body.h/2}));
      continue;
    }
    const [lo,hi]=spec.patrol??[spec.x-32,spec.x+32];
    const stunned=enemy.stun>d.age, speed=spec.patrolSpeed??.65;
    let x=enemy.x;
    if(Math.abs(enemy.knock)>.1){
      x=clamp(x+enemy.knock,0,room.w-enemy.w);
      enemy.knock*=.68;
    }else if(!stunned&&speed){
      const min=clamp(lo,0,room.w-enemy.w),max=clamp(hi,min,room.w-enemy.w);
      if(x<=min)enemy.dir=1;
      if(x>=max)enemy.dir=-1;
      const dest=enemy.dir>0?max:min;
      x+=clamp(dest-x,-speed,speed);
    }
    if(!walls.some(w=>!w.oneWay&&overlap({...enemy,x},w)))enemy.x=x;
    else {enemy.dir*=-1;enemy.knock=0;}
    if(!stunned&&d.age>=enemy.shot){
      fire(d,enemy,spec,p);
      enemy.shot=d.age+time(spec.shotInterval??1.45);
    }
  }
}

function damageEnemy(d,enemy,spec,damage,dir,hooks,heavy=false,tint='#8bfbff'){
  enemy.hp=Math.max(0,enemy.hp-damage);
  enemy.flash=d.age+4;
  if(spec.enemyType){enemy.state='hurt';enemy.since=d.age;}
  enemy.knock=dir*(heavy?5.4:3.5);
  enemy.stun=Math.max(enemy.stun,d.age+5);
  d.hits++;
  d.combo++;
  d.comboUntil=d.age+36;
  const x=enemy.x+enemy.w/2,y=enemy.y+enemy.h/2;
  burst(d,x,y,heavy?16:10,[tint,'#ffffff','#ffda99'],heavy?4:2.8);
  if(enemy.hp===0){
    d.kills++;
    burst(d,x,y,23,[spec.color??'#9e68ef','#ff8ed2','#fbfff4',tint],4.7);
    const die=animation(d.assets,spec.anims?.die);
    if(die){enemy.state='die';enemy.since=d.age;enemy.deathEnd=d.age+die.frames.length*(die.ticks??4);}
    else hooks.defeated(spec);
  }
}

function stopOnHit(d,hooks,heavy){
  d.hitstop=3;
  hooks.shake(heavy?6:3);
}

function startSlash(d,p){
  if(d.dash?.burst>0||d.fighter&&(d.age<d.hurtUntil||d.casting||d.skillAt===d.age))return;
  if(d.swing){d.queuedSlash=true;return;}
  if(d.fighter){
    const air=!p.grounded,list=d.fighter.attacks??[];
    const stage=air||d.age>d.chainUntil?1:d.comboStage%Math.max(1,list.length)+1;
    const attack=air?(d.fighter.airAttack??list[0]):list[stage-1];
    if(!attack)return;
    d.swing={attack,stage,air,age:0,dir:facing(p),hit:new Set()};
    d.comboStage=air?0:stage;d.stateAt=d.age;
    return;
  }
  const stage=d.age<=d.chainUntil?d.comboStage%3+1:1;
  d.comboStage=stage;
  d.chainUntil=d.age+SLASHES[stage-1].life+COMBO_WINDOW;
  d.swing={stage,age:0,dir:facing(p),hit:new Set()};
}

function stepSlash(d,p,live,hooks){
  const swing=d.swing;
  if(!swing)return;
  if(swing.attack){
    const a=swing.attack,wind=a.windup??2,end=wind+(a.active??3);
    const area=relativeBox(p,swing.dir,a.hitbox??{x:6,y:-30,w:28,h:22});
    if(swing.age>=wind&&swing.age<end)for(const {enemy,spec} of live){
      if(enemy.hp<=0||swing.hit.has(spec.id)||!overlap(area,enemy))continue;
      swing.hit.add(spec.id);damageEnemy(d,enemy,spec,a.damage??2,swing.dir,hooks);
      enemy.knock=swing.dir*(a.knockback??0);d.hitstop=a.hitstop??0;hooks.shake(3);
    }
    if(++swing.age>=end+(a.recovery??6)){
      d.swing=null;d.chainUntil=d.age+(d.fighter.comboWindow??15);
      if(d.queuedSlash){d.queuedSlash=false;startSlash(d,p);}
    }
    return;
  }
  const {life,windup,active,reach,height,damage}=SLASHES[swing.stage-1];
  if(swing.age>=windup&&swing.age<=windup+active){
    const left=swing.dir>0?p.x-2:p.x-reach;
    const area={x:left,y:p.y-height-(swing.stage===2?4:0),w:reach+2,h:height+12};
    let contact=false;
    for(const {enemy,spec} of live){
      if(enemy.hp<=0||swing.hit.has(spec.id)||!overlap(area,enemy))continue;
      swing.hit.add(spec.id);
      damageEnemy(d,enemy,spec,damage,swing.dir,hooks,swing.stage===3,swing.stage===2?'#ffa8db':'#99fff2');
      contact=true;
    }
    if(contact)stopOnHit(d,hooks,swing.stage===3);
  }
  if(++swing.age<life)return;
  d.swing=null;
  if(d.queuedSlash){d.queuedSlash=false;startSlash(d,p);}
}

function cast(d,p,skill,hooks){
  const dir=facing(p);
  const base={dir,sprite:skill.sprite,born:d.age};
  switch(skill.type){
    case 'projectile':{
      const q=skill.projectile??{},count=q.count??1,speed=q.speed??7;
      for(let i=0;i<count;i++){
        const angle=(i-(count-1)/2)*(q.spread??0)*Math.PI/180;
        d.waves.push({...base,x:p.x+dir*(d.fighter?(d.fighter.box?.w??2*d.radius)/2:5),
          y:p.y-(d.fighter?(d.fighter.box?.h??2*d.radius)/2:3),vx:dir*Math.cos(angle)*speed,vy:Math.sin(angle)*speed,
          life:q.life??40,w:q.w??26,h:q.h??30,damage:q.damage??3,gravity:q.gravity??0,pierce:q.pierce,hit:new Set()});
      }
      d.wavesCast++;
      burst(d,p.x+dir*10,p.y-3,7,['#a4fffe','#f3fff2'],2);
      break;
    }
    case 'area':{
      const a=skill.area??{};
      const box={x:-20,y:-30,w:40,h:30,...a};
      d.areas.push({...base,box,...relativeBox(p,dir,box),life:a.ticks??4,
        damage:a.damage??2,knockback:a.knockback??0,hit:new Set()});
      break;
    }
    case 'dash':{
      const a=skill.dash??{},ticks=a.ticks??8;
      d.dash={...base,burst:ticks,until:d.age+ticks,speed:a.speed??9.2,damage:a.damage??2,hit:new Set()};
      d.invulnerableUntil=Math.max(d.invulnerableUntil,d.age+(a.invulnerable===true?ticks:a.invulnerable??0));
      break;
    }
    case 'heal':{
      const a=animation(d.assets,skill.sprite);
      if(a)d.healFx={...base,until:d.age+a.frames.length*(a.ticks??4)};
      d.hp=Math.min(d.maxHp,d.hp+(skill.heal?.amount??10));
      break;
    }
    case 'parry':{
      const a=skill.parry??{};
      d.parry={...base,age:0,x:p.x,y:p.y-3,radius:a.radius??48,window:a.window??5,reflect:a.reflect??true,stun:a.stun??24,hit:new Set()};
      d.parries++;
      d.invulnerableUntil=Math.max(d.invulnerableUntil,d.age+(d.fighter?d.parry.window:5));
      hooks.shake(3);burst(d,p.x,p.y,21,['#ff4169','#fff2df','#ff93c7'],4);
      break;
    }
  }
}
function resolveParry(d,p,live){
  const a=d.parry;
  if(!a||a.age>=a.window)return;
  // Measure from the middle of Kris's body, not the feet, so shots aimed at the torso can be deflected.
  const cy=p.y-(d.fighter?(d.fighter.box?.h??0)/2:0);
  for(const bullet of d.bullets){
    if(!a.reflect||bullet.reflected||Math.hypot(bullet.x-p.x,bullet.y-cy)>a.radius)continue;
    const source=d.enemies.get(bullet.owner);
    const angle=source?.hp>0?Math.atan2(source.y+source.h/2-bullet.y,source.x+source.w/2-bullet.x):Math.atan2(-bullet.vy,-bullet.vx);
    Object.assign(bullet,{vx:Math.cos(angle)*8,vy:Math.sin(angle)*8,reflected:true,color:'#fff4a4',life:28});
    d.deflected++;burst(d,bullet.x,bullet.y,7,['#fff4a4','#ff7bba'],2);
  }
  for(const {enemy,spec} of live)if(!a.hit.has(spec.id)&&Math.hypot(enemy.x+enemy.w/2-p.x,enemy.y+enemy.h/2-cy)<=a.radius+1){
    a.hit.add(spec.id);enemy.stun=Math.max(enemy.stun,d.age+a.stun);enemy.flash=d.age+4;
    enemy.knock=enemy.x+enemy.w/2<p.x?-2.8:2.8;
  }
}

function fighterMove(d,p,input,x,move,hooks){
  const f=d.fighter,blocked=d.age<d.hurtUntil;
  if(!blocked&&!d.swing&&!d.dash&&!d.casting){
    if(x)p.face=x>0?'right':'left';
    if(input.press.has('dash')&&d.clock>=d.dodgeReady){
      const a=f.dodge??{},ticks=a.ticks??9;
      d.dash={dir:facing(p),burst:ticks,until:d.age+ticks,speed:a.speed??9.2,afterimages:a.afterimages??true};
      d.dodgeReady=d.clock+Math.round((a.cooldown??.35)*HZ);
      d.invulnerableUntil=Math.max(d.invulnerableUntil,d.age+(a.invulnerable??ticks));
    }else{
      const skill=f.skills?.find(k=>input.press.has(k.input)&&d.clock>=(d.ready[k.input]??0));
      if(skill){
        d.skill=skill;d.skillAt=d.age;d.casting={skill,at:d.age+(skill.cast??0)};
        d.ready[skill.input]=d.clock+Math.round((skill.cooldown??0)*HZ);
      }
    }
  }
  if(d.casting&&d.age>=d.casting.at){
    cast(d,p,d.casting.skill,hooks);d.skillAt=d.age;d.casting=null;
  }
  if(blocked)move(0,{vx:d.hurtDir*2.8,lock:true});
  else if(d.dash){
    if(d.dash.afterimages)d.trail.push({x:p.x,y:p.y,face:p.face,age:d.age,frame:d.age-d.dash.until+(f.dodge?.ticks??9)});
    move(0,{vx:d.dash.dir*d.dash.speed,suspend:true,lock:true});
  }else if(d.casting||d.skillAt===d.age||d.swing){
    move(0,{vx:d.swing?.age===0?d.swing.dir*(d.swing.attack.lunge??0):0,lock:true});
  }else move(x);
}

function updatePose(d,p,input){
  const state=!d.hp?'down':d.age<d.hurtUntil?'hurt':d.dash?(d.dash.hit?'skill':'dodge'):
    d.casting||d.skillAt===d.age?'skill':d.swing?(d.swing.air?'airAttack':'attack'):
    !p.grounded?(p.vy<0?'jump':'fall'):p.walking?(input.hold.has('run')?'run':'walk'):'idle';
  if(d.state!==state){d.state=state;d.stateAt=d.age;}
}

// Swept point vs a padded rectangle. Fast shots also collide during the frame they cross a target.
function impactTime(x,y,dx,dy,e,padX=0,padY=padX){
  let lo=0,hi=1;
  for(const [pos,delta,min,max] of [[x,dx,e.x-padX,e.x+e.w+padX],[y,dy,e.y-padY,e.y+e.h+padY]]){
    if(!delta){if(pos<min||pos>max)return Infinity;continue;}
    const a=(min-pos)/delta,b=(max-pos)/delta;
    lo=Math.max(lo,Math.min(a,b));
    hi=Math.min(hi,Math.max(a,b));
    if(lo>hi)return Infinity;
  }
  return lo;
}
function crosses(x,y,dx,dy,e,pad){
  return impactTime(x,y,dx,dy,e,pad)!==Infinity;
}
function firstWall(shot,walls,padX,padY){
  let time=Infinity;
  for(const w of walls){
    if(w.oneWay&&(shot.vy<=0||shot.y+padY>w.y+.001))continue;
    time=Math.min(time,impactTime(shot.x,shot.y,shot.vx,shot.vy,w,padX,padY));
  }
  return time;
}

function graze(d,p,what){
  if(what.grazed)return;
  what.grazed=true;d.grazes++;
  d.pop={x:p.x,y:p.y-23,text:d.grazes%2?'DODGE!':'GRAZE',until:d.age+17};
  burst(d,p.x,p.y,10,['#ecffff','#65f5ff','#6b9fff'],3.1);
}

function damagePlayer(d,p,amount,x,hooks){
  if(d.age<d.invulnerableUntil||d.hp<=0)return;
  d.hp=Math.max(0,d.hp-amount);
  d.invulnerableUntil=d.age+21;
  d.hurtUntil=d.age+5;
  d.hurtDir=p.x<x?-1:1;
  hooks.shake(4);
  burst(d,p.x,p.y,11,['#ff4169','#fff2df','#ff93c7'],2.8);
  if(d.fighter){d.swing=null;d.queuedSlash=false;d.casting=null;d.dash=null;d.comboStage=0;}
  if(!d.hp){d.retryAt=d.age+24;d.swing=null;d.dash=null;}
}

function stepShots(d,p,prior,radius,live,walls,hooks){
  for(const wave of d.waves){
    const wallTime=firstWall(wave,d.fighter?walls:walls.filter(w=>w.part),wave.w/2,wave.h/2);
    const targets=[];
    for(const target of live){
      if(!target.enemy.hp||wave.hit.has(target.spec.id))continue;
      const t=impactTime(wave.x,wave.y,wave.vx,wave.vy,target.enemy,wave.w/2,wave.h/2);
      if(t<wallTime)targets.push({...target,t});
    }
    for(const {enemy,spec} of targets.sort((a,b)=>a.t-b.t)){
      wave.hit.add(spec.id);
      damageEnemy(d,enemy,spec,wave.damage,wave.dir,hooks,true,'#85fff4');
      if(!enemy.hp&&!d.fighter)stopOnHit(d,hooks,true);
      if(!wave.pierce){wave.life=0;break;}
    }
    if(wallTime!==Infinity)wave.life=0;
    wave.x+=wave.vx;wave.y+=wave.vy;wave.vy+=wave.gravity;
    wave.life--;
  }
  d.waves=d.waves.filter(w=>w.life>0);
  const player=dungeonBox(d,prior,radius),dx=p.x-prior.x,dy=p.y-prior.y;
  for(const bullet of d.bullets){
    const {x,y,vx,vy}=bullet;
    const wallTime=firstWall(bullet,walls,1,1);
    bullet.x+=vx;bullet.y+=vy;bullet.life--;
    if(wallTime!==Infinity)bullet.life=0;
    if(bullet.reflected){
      let target=null,nearest=wallTime;
      for(const candidate of live){
        if(!candidate.enemy.hp)continue;
        const t=impactTime(x,y,vx,vy,candidate.enemy,3);
        if(t<nearest){nearest=t;target=candidate;}
      }
      if(target){
        damageEnemy(d,target.enemy,target.spec,2,Math.sign(vx)||1,hooks,false,'#fff4a4');
        if(!target.enemy.hp)stopOnHit(d,hooks,true);
        bullet.life=0;
      }
    }else if(impactTime(x,y,vx-dx,vy-dy,player,3)<wallTime){
      if(d.dash&&d.age<d.invulnerableUntil)graze(d,p,bullet);
      else{damagePlayer(d,p,bullet.damage,x,hooks);bullet.life=0;}
    }
  }
  d.bullets=d.bullets.filter(b=>b.life>0);
}

export function stepDungeon(d,p,input,{room,active,radius,move,interact,retry,shake,defeated}){
  d.clock++;
  for(const key of d.buffer)input.press.add(key);
  d.buffer.clear();
  if(d.hitstop>0){
    d.hitstop--;
    for(const key of input.press)d.buffer.add(key);
    return;
  }
  d.age++;
  if(d.healFx&&d.age>=d.healFx.until)d.healFx=null;
  d.areas=d.areas.filter(a=>a.life>0);
  if(input.press.has('tool'))input.press.add('skill1');
  if(d.age>=d.comboUntil)d.combo=0;
  if(d.age>d.chainUntil&&!d.swing)d.comboStage=0;
  if(d.dash&&d.age>=d.dash.until)d.dash=null;
  d.trail=d.trail.filter(a=>d.age-a.age<10);
  if(d.pop&&d.age>=d.pop.until)d.pop=null;
  if(d.actPop&&d.age>=d.actPop.until)d.actPop=null;
  if(d.parry&&++d.parry.age>=Math.max(13,d.parry.window))d.parry=null;
  d.particles=d.particles.filter(part=>{
    part.x+=part.vx;part.y+=part.vy;part.vy+=.24;return --part.life>0;
  });

  if(d.retryAt){if(d.age>=d.retryAt)retry();return;}
  const hooks={shake,defeated};
  const walls=active.filter(solid),visible=syncEnemies(d,active,hooks);
  // Spared enemies float away for SPARE_TICKS and never fight again; they leave without counting as kills.
  for(const {enemy,spec} of visible)if(enemy.spared!=null&&d.age-enemy.spared>=SPARE_TICKS&&enemy.hp>0){enemy.hp=0;hooks.defeated(spec);}
  const live=visible.filter(v=>v.enemy.spared==null&&v.enemy.hp>0);
  if(!d.soul)for(const {enemy,spec} of live){
    const s=spec.soul;
    if(!s||enemy.soulDone||(s.hpBelow!=null&&enemy.hp>s.hpBelow))continue;
    if(Math.abs(enemy.x+enemy.w/2-p.x)<=(s.range??180)){startSoul(d,p,enemy,spec);break;}
  }
  if(d.soul){
    stepSoul(d,p,input,hooks);
    if(d.fighter)updatePose(d,p,input);
    return;
  }
  if(input.press.has('spare'))trySpare(d,p,live);
  const x=Number(input.hold.has('right'))-Number(input.hold.has('left'));
  const prior={x:p.x,y:p.y};
  if(d.fighter)fighterMove(d,p,input,x,move,hooks);
  else{
    if(x)p.face=x>0?'right':'left';
    if(!d.dash&&input.press.has('dash')){
      d.dash={dir:facing(p),burst:DASH_FRAMES,until:d.age+DODGE_FRAMES};
      d.invulnerableUntil=Math.max(d.invulnerableUntil,d.dash.until);
      for(const {enemy} of live)enemy.grazed=false;
      for(const bullet of d.bullets)bullet.grazed=false;
      d.swing=null;d.queuedSlash=false;d.trail=[];
    }
    if(input.press.has('skill1')&&d.age>=d.waveReady){
      d.waveReady=d.age+d.waveCooldown;
      cast(d,p,{type:'projectile',projectile:{speed:12,life:38,w:16,h:16,damage:2,pierce:true}},hooks);
      if(d.waves.length>8)d.waves.shift();
    }
    if(input.press.has('skill2')&&d.age>=d.parryReady){
      d.parryReady=d.age+d.parryCooldown;cast(d,p,{type:'parry',parry:{window:1}},hooks);
    }
    resolveParry(d,p,live);
    if(d.dash?.burst>0){
      d.trail.push({x:p.x,y:p.y,face:d.dash.dir>0?'right':'left',age:d.age,sprite:p.sprite});
      p.face=d.trail.at(-1).face;
      move(x,{vx:d.dash.dir*(room.dungeonConfig?.dashSpeed??9.2),suspend:true});
      if(--d.dash.burst===0)p.vx=x*(room.platform?.speed??defaults.speed);
    }else if(d.swing&&d.swing.age<4){
      p.face=d.swing.dir>0?'right':'left';
      move(x,{vx:d.swing.dir*SLASHES[d.swing.stage-1].lunge});
    }else if(d.age<d.hurtUntil)move(x,{vx:d.hurtDir*2.8});
    else move(x);
  }
  if(d.fighter)resolveParry(d,p,live);
  const body=dungeonBox(d,p,radius);
  const dash=d.dash;
  for(const a of d.areas)Object.assign(a,relativeBox(p,a.dir,a.box));
  const attacks=dash?.hit?[...d.areas,dash]:d.areas;
  for(const a of attacks){
    for(const {enemy,spec} of live){
      if(!enemy.hp||a.hit.has(spec.id))continue;
      const contact=a===dash?impactTime(prior.x,prior.y-body.h/2,p.x-prior.x,p.y-prior.y,enemy,body.w/2,body.h/2)!==Infinity:overlap(a,enemy);
      if(!contact)continue;
      a.hit.add(spec.id);damageEnemy(d,enemy,spec,a.damage,a.dir,hooks);
      enemy.knock=a.dir*(a.knockback??0);
    }
  }
  for(const a of d.areas)a.life--;
  stepSlash(d,p,live,hooks);
  stepEnemies(d,live,p,room,walls,body,hooks);
  stepShots(d,p,prior,radius,live,walls,hooks);
  for(const {enemy,spec} of live){
    if(enemy.hp<=0)continue;
    if(spec.contact===false)continue;
    if(d.dash&&d.age<d.invulnerableUntil){
      if(crosses(prior.x,prior.y,p.x-prior.x,p.y-prior.y,enemy,radius))graze(d,p,enemy);
    }else if(overlap(body,enemy))damagePlayer(d,p,spec.damage??12,enemy.x+enemy.w/2,hooks);
  }
  if(d.hp>0)interact(()=>startSlash(d,p));
  if(d.fighter)updatePose(d,p,input);
}

export function clearDungeonMotion(d){
  d.dash=d.swing=d.parry=d.healFx=d.pop=d.soul=d.actPop=null;
  d.trail=[];d.waves=[];d.bullets=[];d.areas=[];d.casting=null;d.skillAt=null;
  d.queuedSlash=false;d.hitstop=0;d.buffer.clear();
  d.comboStage=d.chainUntil=0;
}
