// Input controller for editable scene projects. The world alone owns motion and events.
// Supports:
//  - Free room-to-room BFS exploration & target routing
//  - Scene-specific interaction rules (project.navScript): interact, tool (C), hold (Z),
//    push (ice/crate sliding), zone trigger, door transition
//  - Live sweeping spotlight beam avoidance (s.beams)
//  - Automated input solvers for keypad, rhythm, choices, and dialogue when running script mode
import {testCondition} from './world.mjs';
import {isTimedInput,isPlatformMode} from './format.mjs';

const empty=()=>({hold:[],press:[]});
const dir=(dx,dy)=>Math.abs(dx)>Math.abs(dy)?dx>0?'right':'left':dy>0?'down':'up';
const gap=(x,y,e)=>Math.max(e.x-x,0,x-e.x-e.w)+Math.max(e.y-y,0,y-e.y-e.h);
const KEYPAD_KEYS=['1','2','3','4','5','6','7','8','9','⌫','0','OK'];

function pointInPoly(x,y,pts){
  let inside=false;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    const xi=pts[i][0],yi=pts[i][1],xj=pts[j][0],yj=pts[j][1];
    if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi+1e-9)+xi))inside=!inside;
  }
  return inside;
}

function destinations(world,goal,seen,omit,allowLocked=false){
  const s=world.state,rooms=world.project.rooms,q=[[s.room,[]]],found=new Set([s.room]);
  for(let i=0;i<q.length;i++){
    const [room,path]=q[i];
    if(path.length&&(goal?room===goal:!seen.has(room)))return path;
    const all=room===s.room?world.entities():rooms[room].entities??[];
    for(const e of all){
      if(e.kind!=='door'||!rooms[e.room]||found.has(e.room)||omit.has(room+'|'+e.id)||e.once&&s.used[room+':'+e.id])continue;
      if(!allowLocked&&!testCondition(e.when,s))continue;
      found.add(e.room);q.push([e.room,[...path,e.room]]);
    }
  }
  return [];
}

function walkPathTo(world,target,{ignoreIds=new Set(),threshold=null,avoidBeams=true}={}){
  const {player:p,beams}=world.state,r=world.room(),rad=world.radius;
  const cell=Math.max(4,Math.ceil(Math.sqrt(r.w*r.h/70000)));
  const w=Math.ceil(r.w/cell),h=Math.ceil(r.h/cell),N=w*h;
  const field=new Uint8Array(N),prev=new Int32Array(N).fill(-1),queue=new Int32Array(N);
  const X=i=>i%w*cell+cell/2,Y=i=>Math.floor(i/w)*cell+cell/2;
  const pad=rad+2.5;
  for(const e of world.entities()){
    if(ignoreIds.has(e.id))continue;
    if(!world.solidsFor(e)&&e.kind!=='enemy'&&!(e.kind==='door'&&e.auto))continue;
    const x1=Math.max(0,Math.floor((e.x-pad-cell/2)/cell)),x2=Math.min(w-1,Math.ceil((e.x+e.w+pad-cell/2)/cell));
    const y1=Math.max(0,Math.floor((e.y-pad-cell/2)/cell)),y2=Math.min(h-1,Math.ceil((e.y+e.h+pad-cell/2)/cell));
    if(x1<=x2)for(let y=y1;y<=y2;y++)field.fill(1,y*w+x1,y*w+x2+1);
  }
  if(avoidBeams&&beams?.length){
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=y*w+x;if(field[i])continue;
      const px=X(i),py=Y(i);
      for(const b of beams){if(b.pts.length>=3&&pointInPoly(px,py,b.pts)){field[i]=1;break;}}
    }
  }
  function ok(i){return i>=0&&i<N&&!field[i]&&X(i)>=rad&&Y(i)>=rad&&X(i)<=r.w-rad&&Y(i)<=r.h-rad}
  let seed=-1,dist=Infinity;const sx=Math.floor(p.x/cell),sy=Math.floor(p.y/cell);
  for(let y=sy-3;y<=sy+3;y++)for(let x=sx-3;x<=sx+3;x++){
    const i=y*w+x,d=Math.hypot(X(i)-p.x,Y(i)-p.y);if(x>=0&&x<w&&ok(i)&&d<dist){dist=d;seed=i}
  }
  if(seed<0)return null;
  let n=1,head=0,best=seed,bestGap=Infinity;prev[seed]=seed;queue[0]=seed;
  const reach=threshold??(target.auto?rad-.25:rad+(world.project.player?.reach??17)-4);
  while(head<n){
    const i=queue[head++],v=gap(X(i),Y(i),target);if(v<bestGap){best=i;bestGap=v}
    if(v<=reach){best=i;break}
    for(const j of [i-w,i+w,i%w?i-1:-1,i%w<w-1?i+1:-1])if(ok(j)&&prev[j]===-1){queue[n++]=j;prev[j]=i}
  }
  if(bestGap>reach+cell*3)return null;
  const cells=[];for(let i=best;;i=prev[i]){cells.push([X(i),Y(i)]);if(i===seed)break}
  return cells.reverse().filter((v,k,a)=>!k||k===a.length-1||!(a[k-1][0]===a[k+1][0]||a[k-1][1]===a[k+1][1]));
}

function walkPath(world,door){
  return walkPathTo(world,door,{ignoreIds:new Set([door.id])});
}

function standRectFor(world,e,task){
  const rad=world.radius;
  if(task.action==='push'){
    const d=task.pushDir??'left',pad=rad+10;
    if(d==='left')return {x:e.x+e.w+4,y:e.y+e.h/2-6,w:pad,h:12};
    if(d==='right')return {x:e.x-pad-4,y:e.y+e.h/2-6,w:pad,h:12};
    if(d==='up')return {x:e.x+e.w/2-6,y:e.y+e.h+4,w:12,h:pad};
    return {x:e.x+e.w/2-6,y:e.y-pad-4,w:12,h:pad};
  }
  if(task.action==='tool'){
    const f=task.face??'up';
    if(f==='up')return {x:e.x+e.w/2-8,y:e.y+e.h+8,w:16,h:28};
    if(f==='down')return {x:e.x+e.w/2-8,y:e.y-36,w:16,h:28};
    if(f==='left')return {x:e.x+e.w+8,y:e.y+e.h/2-8,w:28,h:16};
    return {x:e.x-36,y:e.y+e.h/2-8,w:28,h:16};
  }
  if((task.action==='interact'||task.action==='hold')&&task.face){
    const f=task.face,cx=e.x+e.w/2,cy=e.y+e.h/2,pad=rad+14;
    if(f==='up')return {x:cx-8,y:e.y+e.h+2,w:16,h:pad};
    if(f==='down')return {x:cx-8,y:e.y-pad-2,w:16,h:pad};
    if(f==='left')return {x:e.x+e.w+2,y:cy-8,w:pad,h:16};
    return {x:e.x-pad-2,y:cy-8,w:pad,h:16};
  }
  return e;
}

export function createSceneNavigator(notify=()=>{}){
  let platformSince=0,bestX=null;
  let active=false,goal,explore,scriptMode=false,room,seen,omit,door,path,route,prevKey=new Set();
  let progress,check,attempt,approach,phase,launchY,waitTicks,falls,prevX;
  let activeTask=null,taskKey=null,pushingTicks=0,toolTicks=0,beamWait=0;
  let log=[],visitedRooms=[];

  function record(kind,detail){log.push({kind,room,detail});}
  function note(msg){notify(msg,active)}
  function stop(msg='已暂停，可手动操作。'){active=false;prevKey.clear();record('stop',msg);note(msg)}
  function send(hold=[],taps=[]){
    const press=[...new Set([...hold.filter(k=>!prevKey.has(k)),...taps])];prevKey=new Set(hold);return {hold,press}
  }
  function resetNav(t){
    door=null;path=null;route=[];progress=t;check=null;attempt=0;approach=0;phase='idle';waitTicks=0;
    pushingTicks=0;toolTicks=0;beamWait=0;
  }
  function start(target){
    active=true;scriptMode=(target==='__script__');
    goal=scriptMode?'':(target||'');explore=!target&&!scriptMode;
    room=null;seen=new Set();omit=new Set();prevKey=new Set();activeTask=null;taskKey=null;
    log=[];visitedRooms=[];
    const msg=scriptMode?'开始按剧本执行全图互动跑测':explore?'开始探索':'开始前往 '+goal;
    record('start',msg);note(msg);
  }
  function reject(s){
    if(door)omit.add(s.room+'|'+door.id);
    resetNav(s.tick);return send();
  }

  function pickScriptTask(world){
    const list=world.project.navScript;
    if(!Array.isArray(list)||!list.length)return null;
    const s=world.state;
    // Prefer an unfinished task in the current room first (or the first ordered unfinished task in scriptMode)
    const pending=list.filter(t=>!isTimedInput(t)&&(!t.when||testCondition(t.when,s))&&(!t.until||!testCondition(t.until,s)));
    if(!pending.length)return null;
    const here=pending.find(t=>t.room===s.room);
    if(here)return here;
    return scriptMode?pending[0]:null;
  }

  function chooseDoor(world,destRoom){
    const s=world.state;
    route=destinations(world,destRoom,seen,omit);
    if(!route.length){
      if(destRoom){stop('当前可用的门无法到达目的地 '+destRoom+'，可能需要先触发事件。');}
      else stop('已走完当前可达的房间。');
      return false;
    }
    const options=world.entities().filter(e=>e.kind==='door'&&e.room===route[0]&&!omit.has(s.room+'|'+e.id)&&testCondition(e.when,s))
      .sort((a,b)=>gap(s.player.x,s.player.y,a)-gap(s.player.x,s.player.y,b));
    for(const e of options){
      path=isPlatformMode(s.mode,world.project)?[]:walkPath(world,e);
      if(path){door=e;note('前往 '+(world.project.rooms[route[0]].title||route[0]));return true}
      omit.add(s.room+'|'+e.id);
    }
    return false;
  }

  function platform(world,s){
    const p=s.player,body=world.playerBox(),r=body.w/2,cfg=world.room().platform??{},cx=door.x+door.w/2,sgn=cx>p.x?1:-1,d=sgn>0?'right':'left';
    const entities=world.entities().filter(world.solidsFor);
    if(!door.auto&&s.prompt?.id===door.id)return send([],['act']);
    const remaining=Math.abs(cx-p.x);
    if(bestX===null||remaining<bestX-3){bestX=remaining;platformSince=s.tick}
    if(s.tick-platformSince>360){stop('横版关卡长时间没有前进，已交还操作。');return empty()}
    const foot=body.y+body.h;
    const grounded=entities.some(e=>body.x+body.w>e.x&&body.x<e.x+e.w&&Math.abs(foot-e.y)<1.1);
    const look=p.x+sgn*(r+Math.max(14,Math.abs(p.vx)*3));
    const ahead=entities.some(e=>look>=e.x&&look<=e.x+e.w&&e.y>=foot-2&&e.y<foot+36);
    const wall=entities.some(e=>!e.oneWay&&look>=e.x&&look<=e.x+e.w&&foot>e.y+1&&body.y<e.y+e.h);
    if(prevX!=null&&Math.abs(prevX-p.x)>Math.max(180,(cfg.dashSpeed??10)*8)){falls++;phase='idle';bestX=null}
    prevX=p.x;if(falls>=3){stop('连续落坑，需要接管。');return empty()}
    if(door.y>foot+15&&p.x>door.x+r&&p.x<door.x+door.w-r)return send();
    const hold=[d];
    if(grounded&&phase!=='launch')phase='idle';
    if(grounded&&phase==='idle'&&(!ahead||wall)){
      phase='launch';launchY=foot;hold.push('up');if(cfg.dashSpeed)hold.push('dash');return send(hold)
    }
    if(!grounded&&phase==='launch')phase='rise';
    if(phase==='rise'&&p.vy>=-1){phase='release';return send(hold)}
    if(phase==='release')phase='hover';
    if(phase==='hover'&&cfg.hoverTicks){
      const landing=entities.some(e=>p.x>=e.x&&p.x<=e.x+e.w&&e.y>=foot&&e.y<launchY+70);
      if(!landing)hold.push('up');else phase='land';
    }
    return send(hold);
  }

  function stepKeypadAI(k){
    const code=activeTask?.keypadCode??k.code;
    if(k.done!==null)return send();
    const nextChar=k.entry.length<code.length?code[k.entry.length]:'OK';
    const target=KEYPAD_KEYS.indexOf(nextChar);
    if(k.cursor===target)return send([],['act']);
    const cc=k.cursor%3,cr=Math.floor(k.cursor/3),tc=target%3,tr=Math.floor(target/3);
    if(cc!==tc)return send([],[cc<tc?'right':'left']);
    return send([],[cr<tr?'down':'up']);
  }

  function stepRhythmAI(r){
    if(r.done!==null)return send();
    const beat=r.beats[r.cursor];
    if(beat&&Math.abs(r.age-beat.at)<=1)return send([],[beat.key]);
    return send();
  }

  function stepChoiceAI(c){
    const want=Math.min(activeTask?.choice??0,c.options.length-1);
    if(c.index!==want)return send([],['down']);
    return send([],['act']);
  }

  function step(world){
    if(!active)return empty();
    const s=world.state,p=s.player;
    if(room!==s.room){
      room=s.room;seen.add(room);visitedRooms.push(room);
      record('enter',world.room().title??room);
      resetNav(s.tick);falls=0;prevX=null;bestX=null;platformSince=s.tick;
    }
    if(!scriptMode&&goal&&room===goal){stop('已抵达 '+(world.room().title??room));return empty()}

    // Handle active UI states (dialogue, keypad, rhythm, choice, battle)
    const hasScript=scriptMode||!!world.project.navScript?.some(t=>!isTimedInput(t));
    if(s.battle||s.defeat||s.saveRequest){
      stop(s.battle?'已抵达战斗遭遇（'+s.battle.id+'），等待接管。':'遇到存档确认或战败界面，等待接管。');
      return empty();
    }
    if(s.keypad){
      if(!hasScript){stop('遇到密码锁，等待你输入。');return empty();}
      return stepKeypadAI(s.keypad);
    }
    if(s.rhythm){
      if(!hasScript){stop('遇到节奏挑战，等待你接管。');return empty();}
      return stepRhythmAI(s.rhythm);
    }
    if(s.choice){
      if(!hasScript){stop('遇到剧情选择，等待你决定。');return empty();}
      return stepChoiceAI(s.choice);
    }
    if(s.dialogue)return send([],s.tick%4===0?['act']:[]);
    if(s.locked||s.fade){if(++waitTicks>3600)stop('演出长时间未结束，已交还操作。');return send()}
    waitTicks=0;

    // Evaluate scene-specific interaction script!
    const nextTask=hasScript?pickScriptTask(world):null;
    const nextKey=nextTask?(nextTask.id??(nextTask.room+':'+nextTask.target+':'+nextTask.action)):null;
    if(nextKey!==taskKey){
      activeTask=nextTask;taskKey=nextKey;resetNav(s.tick);
      if(activeTask){
        const lbl=activeTask.label??(activeTask.action+' '+activeTask.target);
        record('task',lbl);note('执行：'+lbl);
      }
    }

    // Completed all script tasks in scriptMode!
    if(scriptMode&&!activeTask){
      stop('★ 全图剧本互动跑测完成！已通关所有指定场景与互动。');
      return empty();
    }

    // If current script task is in ANOTHER room, navigate to that room via doors!
    if(activeTask&&activeTask.room!==s.room){
      if(!door&&!chooseDoor(world,activeTask.room))return send();
    }else if(activeTask&&activeTask.room===s.room){
      // Execute scene-specific task INSIDE current room!
      const ent=world.entities().find(e=>e.id===activeTask.target);
      if(!ent){
        // Target temporarily inactive/hidden -> wait briefly or re-evaluate
        if(++waitTicks>120){stop('未找到任务目标 '+activeTask.target);return empty();}
        return send();
      }
      // If currently executing a push on ice, keep nudging briefly then let block glide!
      if(pushingTicks>0){
        pushingTicks--;
        if(pushingTicks>18)return send([activeTask.pushDir??'left']);
        return send(); // pause while block slides across ice!
      }
      // If currently holding Z or C on target
      if(toolTicks>0){
        toolTicks--;
        return send([activeTask.action==='hold'?'act':'tool']);
      }

      const targetRect=standRectFor(world,ent,activeTask);
      const ignore=targetRect===ent?new Set([ent.id]):new Set();
      const thresh=(activeTask.action==='zone'||activeTask.action==='push'||activeTask.action==='tool'||activeTask.face)?4:
        Math.min(18,world.radius+(world.project.player?.reach??17)-8);

      // Recompute path if missing or if beam now blocks next waypoint!
      const nextPt=path?.[0];
      const beamBlocksNext=nextPt&&s.beams?.some(b=>b.pts.length>=3&&pointInPoly(nextPt[0],nextPt[1],b.pts));
      if(!path||beamBlocksNext){
        path=walkPathTo(world,targetRect,{ignoreIds:ignore,threshold:thresh,avoidBeams:true});
        if(!path&&s.beams?.length){
          // Safely wait in shadow for sweeping spotlight to move away!
          if(++beamWait<180)return send();
          beamWait=0;
          path=walkPathTo(world,targetRect,{ignoreIds:ignore,threshold:thresh,avoidBeams:false});
        }
        if(!path){stop('无法寻路到目标 '+activeTask.target);return empty();}
        beamWait=0;
      }

      const eps=Math.max(2.2,(world.project.player?.speed??2.35)*0.8);
      while(path.length&&Math.max(Math.abs(path[0][0]-p.x),Math.abs(path[0][1]-p.y))<=eps)path.shift();

      if(path.length){
        const [tx,ty]=path[0];
        if(!check||Math.hypot(p.x-check[0],p.y-check[1])>2.5){check=[p.x,p.y];progress=s.tick}
        if(s.tick-progress>70){path=null;progress=s.tick;}
        return send([dir(tx-p.x,ty-p.y)]);
      }

      // Arrived at target! Perform the scene-specific interaction!
      const faceDir=activeTask.face??(activeTask.action==='push'?activeTask.pushDir:dir(ent.x+ent.w/2-p.x,ent.y+ent.h/2-p.y));
      if(activeTask.action==='zone'){
        return send([dir(ent.x+ent.w/2-p.x,ent.y+ent.h/2-p.y)]);
      }
      if(p.face!==faceDir)return send([faceDir]);
      if(activeTask.action==='push'){
        pushingTicks=34;
        return send([faceDir]);
      }
      if(activeTask.action==='tool'){
        toolTicks=14;
        return send(['tool'],['tool']);
      }
      if(activeTask.action==='hold'){
        toolTicks=(ent.ticks??50)+8;
        return send(['act'],['act']);
      }
      // interact / door
      if(s.tick%4===0)return send([],['act']);
      return send();
    }else{
      // Standard door-to-door navigation (no script task active)
      if(!door&&!chooseDoor(world,goal))return send();
    }

    // Standard door walking logic
    if(!door)return send();
    if(!world.entities().some(e=>e.id===door.id)){resetNav(s.tick);return send()}
    if(isPlatformMode(s.mode,world.project))return platform(world,s);
    if(!check||Math.hypot(p.x-check[0],p.y-check[1])>3){check=[p.x,p.y];progress=s.tick}
    if(s.tick-progress>70){
      if(attempt++>=2)return reject(s);path=walkPath(world,door);if(!path)return reject(s);progress=s.tick
    }
    const epsilon=Math.max(1.7,(world.project.player?.speed??2.35)*.67);
    while(path.length&&Math.max(Math.abs(path[0][0]-p.x),Math.abs(path[0][1]-p.y))<=epsilon)path.shift();
    const [tx,ty]=path[0]??[door.x+door.w/2,door.y+door.h/2],d=dir(tx-p.x,ty-p.y);
    if(!path.length&&++approach>100)return reject(s);
    if(!path.length&&!door.auto&&s.tick%5===0)return send([d],['act']);
    return send([d]);
  }

  return {
    get active(){return active},
    get log(){return log},
    get visited(){return visitedRooms},
    start,stop,step,
  };
}
