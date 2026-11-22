import {HZ} from '../../../timing.mjs';

const DEFAULT_TRACK=[
  {length:70,curve:0,slope:.015},
  {length:105,curve:.67,slope:.055},
  {length:100,curve:-.78,slope:-.045},
  {length:97,curve:.55,slope:.07},
  {length:94,curve:-.58,slope:-.07},
  {length:114,curve:.30,slope:.01},
  {length:70,curve:0,slope:0}
];
const DEFAULT_OPPONENTS=[
  {id:'rival-gold',lane:-.43,start:18,speed:163,color:'#ffc845'},
  {id:'rival-violet',lane:.47,start:35,speed:174,color:'#cc78ff'}
];
const DEFAULT_BOXES=[{at:43,lane:0},{at:132,lane:-.46},{at:132,lane:.48},{at:258,lane:0},{at:401,lane:0}];
const DEFAULT_PADS=[{at:77,lane:0,width:.75},{at:191,lane:-.45},{at:333,lane:.44},{at:489,lane:0,width:1.25}];
const defaultPalette=['#ffc845','#cc78ff','#77f9ae'];
const ROUND_TICKS=Math.round(.85*HZ);
const THROW_TICKS=Math.round(.43*HZ);
const DROP_TICKS=Math.round(.67*HZ);
const SPIN_TICKS=Math.round(1.12*HZ);
export const KART_ROAD_HALF=4.9;
export const clampKart=(n,a,b)=>Math.max(a,Math.min(n,b));
const clamp=clampKart;
const mix=(a,b,t)=>a+(b-a)*t;

function buildTrack(segments){
  let length=0,x=0,y=0,heading=0,grade=0;
  const sections=segments.map(spec=>{
    const curve=(spec.curve??0)*.004, nextGrade=spec.slope??0;
    const part={start:length,end:length+spec.length,x,y,heading,grade,gradeChange:(nextGrade-grade)/spec.length,curve,
      gap:Boolean(spec.gap),bridge:Boolean(spec.bridge)};
    x+=heading*spec.length+curve*spec.length**2/2;
    y+=(grade+nextGrade)*spec.length/2;
    heading+=curve*spec.length;
    grade=nextGrade;
    length=part.end;
    return part;
  });
  // Adjacent gap sections can shape a single canyon with abutments only at its ends.
  for(let i=0;i<sections.length;i++){
    if(!sections[i].gap)continue;
    const first=i;
    while(sections[i+1]?.gap)i++;
    for(let j=first;j<=i;j++){
      sections[j].gapStart=sections[first].start;
      sections[j].gapEnd=sections[i].end;
    }
  }
  return {sections,length,end:{x,y,heading,grade,curve:0}};
}

export function kartSectionAt(track,distance){
  if(distance<0||distance>=track.length)return null;
  let lo=0,hi=track.sections.length-1;
  while(lo<hi){
    const mid=(lo+hi)>>1;
    if(track.sections[mid].end<=distance)lo=mid+1;else hi=mid;
  }
  return track.sections[lo]??null;
}

export function kartTrackPoint(track,distance){
  if(distance>=track.length){
    const {x,y,heading,grade}=track.end,tail=distance-track.length;
    return {x:x+heading*tail,y:y+grade*tail,heading,grade,curve:0};
  }
  const part=kartSectionAt(track,Math.max(0,distance)),d=distance-part.start;
  const bend=part.curve*d,tilt=part.gradeChange*d;
  return {x:part.x+(part.heading+bend/2)*d,y:part.y+(part.grade+tilt/2)*d,
    heading:part.heading+bend,grade:part.grade+tilt,curve:part.curve};
}

export function createKart(room){
  const cfg=room.kartConfig??{};
  const track=buildTrack(cfg.trackSegments??DEFAULT_TRACK);
  const opponents=(cfg.opponents??DEFAULT_OPPONENTS).map((spec,i)=>{
    const id=spec.id??'rival-'+(i+1),lane=spec.lane??[-.5,.5,0][i%3],speed=spec.speed??160+i*7;
    const sprites=cfg.rivalSprites??{},key=Array.isArray(sprites)?i:id;
    return {id,baseLane:lane,lane,distance:Math.min(track.length-1,spec.start??16+i*13),speed,cruise:speed,
      sprite:spec.sprite??(Object.hasOwn(sprites,key)?sprites[key]:undefined),color:spec.color??defaultPalette[i%defaultPalette.length],
      spin:0,spinDir:1,hitAt:null,airY:0,airVy:0,boost:0,itemBubble:null};
  });
  return {
    cfg,track,age:0,distance:0,lane:cfg.startLane??0,speed:0,displaySpeed:0,steer:0,drift:0,driftDir:0,boost:0,
    boostCount:0,raceProgress:0,sunScale:.66,finished:false,position:opponents.length+1,
    countdownTicks:cfg.countdownTicks??0,braking:false,
    airY:0,airVy:0,airborne:false,jumpCount:0,landFlash:0,
    boxes:(cfg.itemBoxes??DEFAULT_BOXES).filter(e=>e.at<track.length).map((e,index)=>({...e,index,used:false})),
    pads:(cfg.boostPads??DEFAULT_PADS).filter(e=>e.at<track.length).map(e=>({...e,last:-999})),
    jumps:(cfg.jumpPads??[]).filter(e=>e.at<track.length).map(e=>({...e,last:-999})),
    opponents,
    rivalActions:(cfg.rivalActions??[]).map(a=>({...a,fired:false})),
    projectiles:[],hazards:[],bursts:[],rivalItemCount:0,
    item:null,roulette:null,pickups:0,lancer:null,lancerHits:0,bananaHits:0,star:null,starHits:0,
    itemBanner:null,cardPop:null,impact:null,lastTarget:null
  };
}

function boost(k,ticks){
  k.boost=Math.max(k.boost,ticks);
  k.boostCount++;
}

function drive(k,input){
  const cfg=k.cfg,maxSpeed=cfg.maxSpeed??208;
  const turn=Number(input.hold.has('right'))-Number(input.hold.has('left'));
  const drifting=input.hold.has('dash')&&k.speed>maxSpeed*.32&&(turn||k.drift);
  if(drifting){
    if(!k.drift||turn)k.driftDir=turn;
    k.drift++;
  }else if(k.drift){
    if(k.drift>=9)boost(k,k.drift>=21?29:19);
    k.drift=0;k.driftDir=0;
  }
  const gas=(cfg.autoAccelerate??true)||input.hold.has('up'), brake=input.hold.has('down');
  const fullStopBrake=brake&&k.raceProgress>.78;
  k.braking=fullStopBrake&&k.speed>4;
  const limit=maxSpeed*(k.boost>0?1.29:Math.abs(k.lane)>1?.67:1);
  const rate=cfg.acceleration??118;
  const speedTarget=fullStopBrake?0:brake?maxSpeed*.29:k.boost>0||gas?limit:0;
  const decel=fullStopBrake?rate*3.4:brake?rate*1.65:rate*.77;
  k.speed+=clamp(speedTarget-k.speed,-decel/HZ,rate*(k.boost>0?2.6:1)/HZ);
  if(fullStopBrake&&k.speed<2)k.speed=0;
  const steer=turn||(k.drift?k.driftDir*.51:0);
  k.steer=mix(k.steer,k.drift?steer*1.55:steer,.33);
  const point=kartTrackPoint(k.track,k.distance), travel=clamp(k.speed/maxSpeed,0,1.28);
  const inertia=point.curve*(k.drift?2.65:1.65)*travel;
  const lateral=(cfg.steering??1)*(k.drift?.079:.056)*steer*travel-inertia*(k.airborne?.25:1);
  // Keep kart strictly on the paved highway inside the painted curbs (never off-map into grass/props!)
  k.lane=clamp(k.lane+lateral,-.88,.88);
  k.distance=Math.min(k.track.length,k.distance+k.speed/(3.6*HZ));
  k.displaySpeed=k.speed<=.5?0:mix(k.displaySpeed??k.speed,k.speed,.24);
}

function crosses(at,from,to){
  return to>from&&at<=to&&(at>from||(at===0&&from===0));
}

function entersGap(track,from,to){
  const section=kartSectionAt(track,to);
  return section?.gap&&crosses(section.gapStart,from,to);
}

function stepAir(kart){
  kart.airVy-=.028;
  kart.airY+=kart.airVy;
  if(kart.airY>0)return false;
  kart.airY=0;kart.airVy=0;
  return true;
}

function stepJump(k,prevDistance,prevLane,hooks){
  if(!k.airborne){
    const pad=k.jumps.find(p=>crosses(p.at,prevDistance,k.distance)&&
      Math.abs(mix(prevLane,k.lane,(p.at-prevDistance)/(k.distance-prevDistance))-p.lane)<=(p.width??.8)/2);
    if(pad||entersGap(k.track,prevDistance,k.distance)){
      if(pad)pad.last=k.age;
      k.airVy=.62*(pad?.power??1);
      k.airborne=true;k.jumpCount++;
      boost(k,42);
      hooks.shake(5);
    }
  }
  if(k.airborne&&stepAir(k)){
    k.airborne=false;k.landFlash=10;
    hooks.shake(6);
  }
}

function spinRival(k,o,text,color,hooks,shakeAmt=5){
  o.spin=SPIN_TICKS;
  o.spinDir=o.lane<0?-1:1;
  o.speed*=.28;
  o.boost=0;
  o.hitAt=k.age;
  k.bursts.push({age:0,maxAge:22,distance:o.distance,lane:o.lane,airY:o.airY,text,color});
  if(Math.abs(o.distance-k.distance)<90)hooks.shake(shakeAmt);
}

function stepRivalItems(k,hooks){
  for(const act of k.rivalActions){
    if(act.fired||k.age<act.tick)continue;
    act.fired=true;
    const actor=k.opponents.find(o=>o.id===act.actor);
    if(!actor)continue;
    k.rivalItemCount++;
    if(act.type==='boost'){
      actor.boost=Math.max(actor.boost,act.ticks??44);
      actor.itemBubble={kind:'boost',age:0,maxAge:26};
    }else if(act.type==='trap'){
      actor.itemBubble={kind:'trap',age:0,maxAge:26};
      k.hazards.push({
        owner:actor.id,born:k.age,used:false,
        distance:Math.max(2,actor.distance-(act.behind??2.4)),
        lane:act.lane??actor.lane,kind:'wax'
      });
    }else if(act.type==='shell'){
      actor.itemBubble={kind:'shell',age:0,maxAge:26};
      const target=act.targetId?k.opponents.find(o=>o.id===act.targetId):null;
      k.projectiles.push({
        kind:'shell',owner:actor.id,targetId:act.targetId??null,age:0,maxAge:act.maxAge??70,
        distance:actor.distance+(act.forward===false?-2.2:2.4),
        lane:actor.lane,speed:act.speed??(target?Math.max(320,actor.speed+130):310),
        airY:0,done:false
      });
    }else if(act.type==='lob'){
      actor.itemBubble={kind:'lob',age:0,maxAge:28};
      const target=k.opponents.find(o=>o.id===act.targetId);
      if(target){
        k.projectiles.push({
          kind:'lob',owner:actor.id,targetId:target.id,age:0,maxAge:act.flightTicks??28,
          startDist:actor.distance,startLane:actor.lane,
          distance:actor.distance,lane:actor.lane,airY:.35,done:false
        });
      }
    }
  }
  for(const p of k.projectiles){
    if(p.done)continue;
    p.age++;
    if(p.kind==='lob'||p.kind==='banana'){
      const t=clamp(p.age/p.maxAge,0,1);
      const target=k.opponents.find(o=>o.id===p.targetId);
      if(target){
        p.distance=mix(p.startDist,target.distance,t);
        p.lane=mix(p.startLane,target.lane,t);
        p.airY=Math.sin(t*Math.PI)*(p.kind==='banana'?2.6:3.4)+target.airY*t;
        if(t>=1){
          p.done=true;
          if(p.kind==='banana'){
            k.bananaHits++;
            spinRival(k,target,'SLIP!','#ffe854',hooks,6);
          }else{
            spinRival(k,target,'BOOM!','#ff7c3a',hooks,7);
          }
        }
      }else p.done=true;
    }else{
      p.distance+=p.speed/(3.6*HZ);
      const target=p.targetId?k.opponents.find(o=>o.id===p.targetId):null;
      if(target)p.lane=mix(p.lane,target.lane,.16);
      const hit=k.opponents.find(o=>o.id!==p.owner&&(!p.targetId||o.id===p.targetId)&&
        Math.abs(o.distance-p.distance)<3.6&&Math.abs(o.lane-p.lane)<.48);
      if(hit){
        p.done=true;
        spinRival(k,hit,'POW!','#ff587a',hooks,5);
      }else if(p.age>=p.maxAge||p.distance>k.track.length||p.distance<0)p.done=true;
    }
  }
  k.projectiles=k.projectiles.filter(p=>!p.done);
  for(const h of k.hazards){
    if(h.used)continue;
    if(k.age-h.born<10)continue;
    const victim=k.opponents.find(o=>o.id!==h.owner&&o.spin<=0&&o.airY<.2&&
      Math.abs(o.distance-h.distance)<3.2&&Math.abs(o.lane-h.lane)<.36);
    if(victim){
      h.used=true;
      spinRival(k,victim,'SLIP!','#ffe052',hooks,4);
    }
  }
  k.hazards=k.hazards.filter(h=>!h.used&&h.distance>k.distance-12);
  for(const b of k.bursts)b.age++;
  k.bursts=k.bursts.filter(b=>b.age<b.maxAge);
}

function stepRivals(k,hooks){
  for(const [i,o] of k.opponents.entries()){
    if(o.boost>0)o.boost--;
    if(o.itemBubble&&++o.itemBubble.age>=o.itemBubble.maxAge)o.itemBubble=null;
    if(o.spin>0){
      o.spin--;
      o.lane=clamp(o.lane+.020*o.spinDir,-.82,.82);
    }else o.lane=clamp(mix(o.lane,o.baseLane+.10*Math.sin(k.age*.033+i*2.4),.09),-.84,.84);
    const target=o.cruise*(o.spin?.28:o.boost>0?1.36:1);
    o.speed+=clamp(target-o.speed,-7,o.boost>0?4.5:2.1);
    const prevDistance=o.distance;
    o.distance+=o.speed/(3.6*HZ);
    if(!o.airY&&!o.airVy){
      // Rivals automatically take ramps & boost pads they cross!
      const pad=k.jumps.find(p=>crosses(p.at,prevDistance,o.distance));
      if(pad||entersGap(k.track,prevDistance,o.distance)){
        o.airVy=.62*(pad?.power??1);
        o.boost=Math.max(o.boost,24);
      }
      const bpad=k.pads.find(p=>crosses(p.at,prevDistance,o.distance)&&Math.abs(o.lane-p.lane)<=(p.width??.8)/2+.15);
      if(bpad)o.boost=Math.max(o.boost,26);
    }
    if(o.airY||o.airVy)stepAir(o);
  }
  stepRivalItems(k,hooks);
}

function itemAtBox(k,box){
  if(Array.isArray(k.cfg.itemSequence)&&k.cfg.itemSequence.length){
    return k.cfg.itemSequence[k.pickups%k.cfg.itemSequence.length];
  }
  const list=k.cfg.items??['lancer'];
  const index=(Math.imul(box.index+1,2654435761)+(k.cfg.seed??7))>>>0;
  return k.cfg.forceItem??list[index%list.length];
}

function stepPickups(k,prevDistance,prevLane){
  const crossed=object=>object.at>=prevDistance&&object.at<=k.distance;
  const laneAt=object=>mix(prevLane,k.lane,(object.at-prevDistance)/Math.max(.001,k.distance-prevDistance));
  for(const pad of k.pads)if(crossed(pad)&&k.age-pad.last>30&&Math.abs(laneAt(pad)-pad.lane)<=(pad.width??.8)/2){
    pad.last=k.age;
    boost(k,31);
  }
  // Visually grounded bumper-contact pickup: player kart visually sits ~3.5 units ahead of camera!
  if(k.airY<.45&&!k.item&&!k.roulette&&!k.lancer){
    for(const box of k.boxes){
      if(box.used)continue;
      const reach=Math.min(3.5,Math.max(0,box.at-1));
      const d0=prevDistance+reach,d1=k.distance+reach;
      if(box.at>=d0&&box.at<=d1){
        const hitLane=mix(prevLane,k.lane,(box.at-d0)/Math.max(.001,d1-d0));
        if(Math.abs(hitLane-box.lane)<=.25){
          box.used=true;
          const pool=k.cfg.roulettePool??['lancer','banana','dogcar','starwalker','nubert','pipis'];
          k.roulette={age:0,reward:itemAtBox(k,box),pool};
          k.cardPop={age:0,maxAge:14,lane:box.lane};
          k.pickups++;
          break;
        }
      }
    }
  }
}

function stepItem(k,input,hooks){
  if(k.cardPop&&++k.cardPop.age>=k.cardPop.maxAge)k.cardPop=null;
  if(k.itemBanner&&++k.itemBanner.age>=k.itemBanner.maxAge)k.itemBanner=null;
  if(k.roulette&&++k.roulette.age>=ROUND_TICKS){
    k.item=k.roulette.reward;
    k.roulette=null;
  }
  if(!k.finished&&!k.lancer&&(input.press.has('act')||input.press.has('tool'))){
    if(k.item==='boost'){
      boost(k,37);
      k.item=null;
    }else if(k.item==='banana'){
      boost(k,36);
      k.itemBanner={age:0,maxAge:28,text:'POTASSIUM!'};
      const ahead=k.opponents.filter(o=>o.distance>k.distance+2&&o.distance<k.track.length).sort((a,b)=>a.distance-b.distance)[0];
      if(ahead){
        k.lastTarget=ahead.id;
        k.projectiles.push({
          kind:'banana',owner:'player',targetId:ahead.id,age:0,maxAge:20,
          startDist:k.distance+3.8,startLane:k.lane,
          distance:k.distance+3.8,lane:k.lane,airY:.55,done:false
        });
      }
      hooks.shake(4);
      k.item=null;
    }else if(k.item==='starwalker'){
      // [Starwalker]: an invincible rainbow dash that spins out any rival Kris drives through.
      boost(k,75);
      k.star={age:0,maxAge:75};
      k.itemBanner={age:0,maxAge:30,text:'STARWALKER!'};
      hooks.shake(5);
      k.item=null;
    }else if(k.item==='lancer'){
      const ahead=k.opponents.filter(o=>o.distance>k.distance&&o.distance<k.track.length).sort((a,b)=>a.distance-b.distance)[0];
      if(ahead){
        k.lastTarget=ahead.id;
        k.item=null;
        k.lancer={age:0,target:ahead,phase:'throw',progress:0,fromLane:k.lane};
      }
    }
  }
  if(k.impact&&++k.impact.age>=20)k.impact=null;
  if(k.star){
    for(const o of k.opponents){
      if(o.spin>0||o.airY>.2||Math.abs(o.distance-k.distance)>3||Math.abs(o.lane-k.lane)>.42)continue;
      o.spin=SPIN_TICKS;o.spinDir=o.lane<k.lane?-1:1;o.speed*=.3;o.hitAt=k.age;
      k.starHits=(k.starHits??0)+1;hooks.shake(4);
    }
    if(++k.star.age>=k.star.maxAge)k.star=null;
  }
  const lancer=k.lancer;
  if(!lancer)return;
  const age=++lancer.age;
  if(age<THROW_TICKS){lancer.progress=age/THROW_TICKS;return;}
  lancer.phase='drop';
  lancer.progress=(age-THROW_TICKS)/DROP_TICKS;
  if(lancer.progress<1)return;
  const o=lancer.target;
  o.spin=SPIN_TICKS;
  o.spinDir=o.lane<0?-1:1;
  o.speed*=.24;
  o.hitAt=k.age;
  k.impact={age:0,target:o};
  k.lancerHits++;
  k.lancer=null;
  hooks.shake(9);
}

export function stepKart(k,input,hooks){
  k.age++;
  if(k.boost>0)k.boost--;
  if(k.landFlash>0)k.landFlash--;
  if(k.countdownTicks>0&&k.age<=k.countdownTicks){
    k.braking=false;
    if(k.age===k.countdownTicks){
      boost(k,28);
      hooks.shake(4);
    }
    return;
  }
  const prevDistance=k.distance,prevLane=k.lane;
  if(!k.finished)drive(k,input);
  stepRivals(k,hooks);
  if(!k.finished)stepPickups(k,prevDistance,prevLane);
  stepJump(k,prevDistance,prevLane,hooks);
  stepItem(k,input,hooks);
  k.raceProgress=k.distance/k.track.length;
  k.sunScale=.66+4.85*k.raceProgress**1.55;
  if(!k.finished){
    k.position=1+k.opponents.filter(o=>o.distance>k.distance).length;
    if(k.raceProgress>=1){
      k.finished=true;
      k.steer=k.drift=k.driftDir=0;
      hooks.finish();
    }
  }else k.speed=Math.max(0,k.speed-8);
}

export function kartCamera(k,w,h){
  const at=kartTrackPoint(k.track,k.distance);
  const boost=k.boost>0?Math.min(1,k.boost/7):0;
  return {at,w,h,airY:k.airY,horizon:Math.round(h*(.417+at.grade*.10+boost*.018-k.airY*.022)),
    lane:k.lane,K:h*(.81+boost*.025),height:2.32+boost*.28+k.airY*1.55,far:210};
}

export function projectKart(k,c,d,lane=0){
  const sample=kartTrackPoint(k.track,k.distance+d);
  const scale=c.K/d;
  return {
    x:c.w/2+(sample.x-c.at.x-c.at.heading*d+(lane-c.lane)*KART_ROAD_HALF)*scale,
    y:c.horizon+(c.height-(sample.y-c.at.y-c.at.grade*d*.64))*scale,
    half:KART_ROAD_HALF*scale,scale
  };
}
