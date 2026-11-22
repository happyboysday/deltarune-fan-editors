import {relativeBox} from './data.mjs';

const intersects=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
function supported(e,walls){
  return walls.some(w=>e.x<w.x+w.w&&e.x+e.w>w.x&&e.y+e.h<=w.y+.001&&e.y+e.h+1>=w.y);
}
function slide(e,axis,delta,walls,limit){
  const count=Math.ceil(Math.abs(delta));
  for(let i=0;i<count;i++){
    const next={...e,[axis]:e[axis]+delta/count};
    if(next[axis]<0||next[axis]+(axis==='x'?e.w:e.h)>limit)return false;
    if(walls.some(w=>intersects(next,w)&&(!w.oneWay||axis==='y'&&delta>0&&e.y+e.h<=w.y+.001)))return false;
    e[axis]=next[axis];
  }
  return true;
}
export function typedEnemy(d,e,s,p,body,room,walls,hurt,fire){
  const ai=s.ai??'patrol',gravity=ai!=='flyer'&&(s.gravity??ai!=='turret');
  const dx=p.x-e.x-e.w/2,dy=body.y+body.h/2-e.y-e.h/2;
  const dist=Math.hypot(dx,dy),speed=s.speed??.9,stunned=e.stun>d.age;
  let vx=0,vy=0,attacking=false;
  if(!stunned){
    if(!e.melee&&s.melee&&ai!=='turret'&&dist<=(s.melee.range??28)){
      e.melee={age:0,hit:false};e.dir=Math.sign(dx)||e.dir;
    }
    if(e.melee){
      const m=s.melee,a=e.melee,wind=m.windup??12,end=wind+(m.active??4);
      const area=relativeBox({x:e.x+e.w/2,y:e.y+e.h},e.dir,m.hitbox??{x:0,y:-e.h,w:24,h:e.h});
      if(!a.hit&&a.age>=wind&&a.age<end&&intersects(area,body)){hurt(m.damage??s.damage??12,e.x+e.w/2);a.hit=true;}
      if(++a.age>=end+(m.recovery??18))e.melee=null;
      attacking=true;
    }else if(ai==='patrol'){
      const [lo,hi]=s.patrol??[s.x-32,s.x+32];
      if(e.x<=lo)e.dir=1;
      else if(e.x>=hi)e.dir=-1;
      vx=e.dir*Math.min(speed,Math.abs((e.dir>0?hi:lo)-e.x));
      if(gravity&&supported(e,walls)&&!supported({...e,x:e.x+(e.dir>0?e.w:0)+vx,w:1},walls)){vx=0;e.dir*=-1;}
    }else if(ai==='flyer'||ai==='chase'&&dist<=(s.aggroRange??160)){
      e.dir=Math.sign(dx)||e.dir;
      vx=e.dir*Math.min(Math.abs(dx),speed);
      if(ai==='flyer')vy=Math.max(-speed,Math.min(speed,dy))*.4+Math.sin(d.age*.12)*1.2;
    }else if(ai==='turret')e.dir=Math.sign(dx)||e.dir;
    if(s.shoot&&d.age>=e.shot&&dist<=(s.shoot.range??220)&&s.shoot.interval!==0){
      fire();e.shot=d.age+Math.max(1,Math.round((s.shoot.interval??1.6)*30));e.fired=d.age;
    }
  }else e.melee=null;
  if(Math.abs(e.knock)>.1){vx=e.knock;e.knock*=.68;}
  if(!slide(e,'x',vx,walls,room.w)){e.knock=0;if(ai==='patrol')e.dir*=-1;}
  if(gravity)vy=e.vy=Math.min((e.vy??0)+(room.platform?.gravity??.86),room.platform?.fallSpeed??14);
  if(!slide(e,'y',vy,walls,room.h))e.vy=0;
  const state=e.flash>d.age?'hurt':attacking||d.age-(e.fired??-99)<4?'attack':vx||ai==='flyer'?'move':'idle';
  if(state!==e.state){e.state=state;e.since=d.age;}
}
