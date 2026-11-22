
import {validateProject,HZ,rectOf,entityKind,INPUTS,BATTLE_RESULTS,isPlatformMode,PLATFORM_DEFAULTS} from './format.mjs';
import {cueDirector,stepDirector} from './trailer-fx.mjs';
import {roomTiles} from './room-art.mjs';
import {projectPlugins,invoke,resolveEntity} from './plugins.mjs';
import {createTrailerTimeline,trailerRows} from './trailer-script.mjs';
import {initialParty,encodeSave} from './campaign.mjs';
import {sceneWorld} from './ui-draw.mjs';
import {DIALOGUE_ROWS,layoutDialogue} from './ui-dialogue.mjs';
import {createSystemMenu,stepSystemMenu,createDefeatUi,stepDefeatUi} from './ui-system.mjs';
import {createTypewriter,UI_SOUNDS,UI_VOICES,uiViewport} from './ui-kit.mjs';

export const clamp=(n,a,b)=>Math.max(a,Math.min(n,b));
export const KEYPAD_KEYS=['1','2','3','4','5','6','7','8','9','⌫','0','OK'];
const empty=()=>Object.create(null);
const dict=(value={})=>Object.assign(empty(),value);
const lerp=(a,b,t)=>a+(b-a)*t;
const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
const token=(room,id)=>room+':'+id;
const clone=structuredClone;

export function testCondition(c,s){
  if(!c)return true;
  if(c.flag!==undefined){
    const a=s.flags[c.flag],b=c.is;
    switch(c.compare){
      case 'eq':return (a??(typeof b==='number'?0:false))===b;
      case 'ne':return (a??(typeof b==='number'?0:false))!==b;
      case 'lt':return Number(a??0)<b;
      case 'le':return Number(a??0)<=b;
      case 'gt':return Number(a??0)>b;
      case 'ge':return Number(a??0)>=b;
      default:return (a??false)===(b??true);
    }
  }
  if(c.item!==undefined)return (s.inventory[c.item]??0)>=(c.count??1);
  if(c.all)return c.all.every(v=>testCondition(v,s));
  if(c.any)return c.any.some(v=>testCondition(v,s));
  return !testCondition(c.not,s);
}
export function cameraFor(p,r,x,y){
  const {w,h}=r.view??p.viewport??{w:640,h:480};
  return {x:r.w<w?(r.w-w)/2:clamp(x-w/2,0,r.w-w),y:r.h<h?(r.h-h)/2:clamp(y-h/2,0,r.h-h)};
}

export function roomTransform(p,r){
  const canvas=p.viewport??{w:640,h:480}, v=r.view??canvas;
  const scale=Math.min(canvas.w/v.w,canvas.h/v.h);
  return {v,scale,x:(canvas.w-v.w*scale)/2,y:(canvas.h-v.h*scale)/2};
}

export function createWorld(project,{validated=false,onDialogueSound,autoplay=false}={}) {
  if(!validated){
    const check=validateProject(project);
    if(!check.ok) throw Object.assign(new Error(check.errors[0].path+'：'+check.errors[0].message),{issues:check.errors});
  }
  const radius=project.player?.radius??6, speed=project.player?.speed??2.35, reach=project.player?.reach??17;
  const events=project.events??{}, battles=project.battles??{}, original=project.rooms;
  const plugins=projectPlugins(project);
  const rooms=Object.fromEntries(Object.entries(original).map(([k,r])=>[k,(r.entities??[]).map(e=>resolveEntity(plugins,project,e)).map(e=>({...e,kind:entityKind(e),...rectOf(e)}))]));
  const s={tick:0,room:'',player:{x:0,y:0,face:'down',vx:0,vy:0,walking:false,sprite:project.player?.sprite},
    followers:[],flags:dict(project.flags),inventory:dict(project.inventory),party:initialParty(project),changed:empty(),used:empty(),
    mode:'walk',grip:0,maxGrip:0,camera:{x:0,y:0,follow:true},prompt:null,dialogue:null,rhythm:null,keypad:null,beams:[],
    hold:null,tool:null,choice:null,battle:null,lastBattle:null,menu:null,saveRequest:null,defeat:null,saveSerial:0,fade:0,note:null,checkpoint:null,locked:false};
  let active=[],previous=new Set(),occupied=new Set(),pending=[],program=[],blocker=null,timers=[],contact=null,checkpoint=null;
  let platformEntry=null,dashTicks=0,dashReady=true,hoverTicks=0,hovering=false;
  let switchFlags=new Set(),runaway=0,battleSerial=0,saveRecord=null,defeatEvent=null;
  let playTicks=0,systemUi=null;
  let slidingBlocks=new Map(),beamCooldown=0;
  let trailerEnabled=autoplay,timeline=null;
  function resetTimeline(){
    const rows=trailerEnabled?trailerRows(project,s.room,s.mode):[];
    timeline=rows.length?createTrailerTimeline(rows):null;
  }
  function startTrailerScript(){
    trailerEnabled=true;resetTimeline();
    return !!timeline;
  }
  function stopTrailerScript(){
    trailerEnabled=false;timeline=null;
  }
  function triggerFx(action){
    cueDirector(s.director??={},action,s.tick);
  }
  function gameShake(intensity){
    const current=s.director?.shake;
    if(current&&current.intensity*(1-(s.tick-current.start)/current.ticks)>=intensity)return;
    triggerFx({op:'shake',intensity,duration:.23});
  }
  const defeatInput=new Set();
  const playUiSound=name=>systemUi?.playSound(name);
  function connectSystemUi(ui){
    systemUi=ui;
    return ()=>{if(systemUi===ui)systemUi=null;};
  }
  const trail=[];
  function followParty(reset=false){
    const specs=original[s.room].followers??[];
    if(reset)trail.length=0;
    if(!specs.length){s.followers=[];return;}
    const {x,y,face,walking}=s.player;
    const older=trail.at(-1);
    // A stationary player doesn't make the rest of the party stack on top of them.
    if(!older||older.x!==x||older.y!==y){
      trail.push({x,y,face});
      if(trail.length>121)trail.shift();
    }
    s.followers=specs.flatMap((a,slot)=>{
      if(!testCondition(a.when,s)||trail.length<=a.delay)return [];
      const point=trail[trail.length-1-a.delay];
      return [{...point,id:a.id,slot,sprite:a.sprite,depth:a.depth??0,walking}];
    });
  }
  const tileWalls=Object.fromEntries(Object.entries(original).map(([key,r])=>[key,roomTiles(project,r)
    .filter(t=>t.solid==='solid'||t.solid==='oneway').map((t,i)=>({...t,id:'@tile/'+i,kind:'wall',oneWay:t.solid==='oneway',draw:false}))]));
  function entities(){return rooms[s.room].map(e=>({...e,...s.changed[e.id]})).concat(tileWalls[s.room]);}
  function activeEntities(){return entities().filter(e=>!e.hidden&&testCondition(e.activeWhen,s));}
  const initialSeed=0x9e3779b9;
  let modePlugin,modeRoom,seed=initialSeed;
  const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  function context(input){
    return {project,state:s,player:s.player,room:original[s.room],local:s[s.mode],tick:s.tick,rng,active,radius,input,
      run,mark,shake:gameShake,retry:()=>retryPlatform(original[s.room]),cameraSnap,
      move:()=>{movement(input);updateRoomContacts();worldInteractions(input);},
      platformMove:(x,drive)=>{platformMove(input,x,drive);updateRoomContacts();},
      interact:onAct=>worldInteractions(input,onAct)};
  }
  const playerBox=()=>(modePlugin?.hooks.playerBox&&invoke(modePlugin,'playerBox',context()))??{x:s.player.x-radius,y:s.player.y-radius,w:2*radius,h:2*radius};
  function exitMode(){
    if(modePlugin){
      invoke(modePlugin,'exit',{...context(),room:modeRoom});
      delete s[s.mode];modePlugin=null;
    }
  }
  function resetMotion(){s.player.vx=s.player.vy=0;s.player.walking=false;}
  function cameraSnap(){
    const r=original[s.room], point=r.camera??s.player;
    s.camera={...cameraFor(project,r,point.x,point.y),follow:!r.camera};
  }
  function setMode(mode,grip,entering=false){
    if(mode!==s.mode||entering){
      if(mode!==s.mode)resetMotion();
      exitMode();
      s.mode=mode;
      modePlugin=plugins.modes.get(mode);modeRoom=original[s.room];
      if(modePlugin)s[mode]=invoke(modePlugin,'enter',{...context(),active:activeEntities()});
    }
    s.mode=mode;s.maxGrip=mode==='climb'?(grip??180):0;s.grip=s.maxGrip;
  }
  function announce(text,ticks=62){s.note={text,until:s.tick+ticks};}
  function roomEnter(room,entry,{event=true}={}){
    exitMode();
    if(s.room)timers=timers.filter(t=>!t.room);
    for(const k of switchFlags)if(!rooms[s.room]?.some(e=>e.kind==='switch'&&e.flag===k&&e.latch))s.flags[k]=false;
    switchFlags=new Set();previous=new Set();s.room=room;
    const r=original[room],point=r.entries[entry];
    platformEntry=entry;dashTicks=0;dashReady=true;hoverTicks=0;hovering=false;slidingBlocks=new Map();beamCooldown=12;
    Object.assign(s.player,{x:point.x,y:point.y,face:point.face??plugins.modes.get(r.mode)?.hooks.face??'down',sprite:r.playerArt??project.player?.sprite});
    resetMotion();followParty(true);setMode(r.mode??'walk',undefined,true);cameraSnap();s.hold=s.prompt=s.tool=s.keypad=null;s.beams=[];
    resetTimeline();
    contact=null;active=activeEntities();
    occupied=new Set(active.filter(e=>overlap(playerBox(),e)).map(e=>e.id)); // Arrival is never an immediate door/zone bounce.
    if(event&&r.onEnter)pending.unshift(r.onEnter);
  }
  function snapshot(point=null){
    let player=s.player,camera=s.camera,mode=s.mode,grip=s.grip,maxGrip=s.maxGrip;
    if(point?.entry){
      const r=original[s.room],dest=r.entries[point.entry];
      player={...player,x:dest.x,y:dest.y,face:dest.face??'down'};
      const focus=r.camera??player;
      camera={...cameraFor(project,r,focus.x,focus.y),follow:!r.camera};
      mode=r.mode??'walk';grip=maxGrip=mode==='climb'?180:0;
    }
    return clone({room:s.room,platformEntry,player,mode,grip,maxGrip,camera,rngState:seed,party:{...s.party},
      flags:{...s.flags},inventory:{...s.inventory},used:{...s.used},changed:{...s.changed},switchFlags:[...switchFlags],pressedSwitches:[...previous],
      pending:point?[...pending]:[],
      timers:timers.map(t=>({room:t.room,event:t.event,delay:Math.max(0,t.at-s.tick)})),lastBattle:s.lastBattle});
  }
  function savePoint(name='检查点'){
    checkpoint=snapshot();
    s.checkpoint={room:s.room,name};announce('已记录：'+name);
  }
  function restoreSnapshot(saved,name){
    exitMode();
    s.room=saved.room;platformEntry=saved.platformEntry??null;dashTicks=0;dashReady=true;hoverTicks=0;hovering=false;s.player={...saved.player};s.camera={...saved.camera};s.changed=dict(clone(saved.changed));
    s.flags=dict(saved.flags);s.inventory=dict(saved.inventory);s.used=dict(saved.used);s.party=dict(clone(saved.party));
    s.lastBattle=saved.lastBattle?{...saved.lastBattle}:null;previous=new Set(saved.pressedSwitches);
    seed=saved.rngState??initialSeed;
    switchFlags=new Set(saved.switchFlags);setMode(saved.mode,saved.maxGrip,true);s.grip=saved.grip;resetMotion();followParty(true);
    // Re-entering a mode may draw random numbers while reconstructing its local state.
    seed=saved.rngState??initialSeed;
    delete s.director;resetTimeline();
    program=[];pending=[...(saved.pending??[])];timers=saved.timers.map(t=>({room:t.room,event:t.event,at:s.tick+t.delay}));
    saveRecord=null;defeatEvent=null;slidingBlocks=new Map();beamCooldown=18;
    defeatInput.clear();
    blocker=null;s.battle=s.defeat=s.menu=s.saveRequest=s.dialogue=s.rhythm=s.keypad=s.choice=s.hold=s.prompt=s.tool=null;s.fade=0;contact=null;s.beams=[];
    active=activeEntities();
    const overlaps=active.filter(e=>overlap(playerBox(),e));
    occupied=new Set(overlaps.map(e=>e.id));
    contact=s.mode==='climb'?overlaps.find(e=>e.kind==='mode'&&e.mode==='climb')?.id??null:null;
    s.locked=!!pending.length;announce('已回到'+name);
  }
  function restorePoint(){
    if(checkpoint)restoreSnapshot(checkpoint,s.checkpoint.name);
  }
  function restoreSave(save){
    restoreSnapshot(save.snapshot,save.point.name);
    const elapsed=save.snapshot.playTicks;
    playTicks=Number.isSafeInteger(elapsed)&&elapsed>=0?elapsed:0;
    checkpoint=clone(save.snapshot);s.checkpoint={room:s.room,name:save.point.name};
    return s;
  }
  function changeHp(member,delta,full){
    const people=member==='party'?Object.values(s.party):[s.party[member]];
    for(const p of people)p.hp=full?p.maxHp:clamp(p.hp+delta,0,p.maxHp);
  }
  function recordSave(e){
    if(e.once)s.used[token(s.room,e.id)]=true;
    const name=e.name??'存档点';
    checkpoint={...snapshot(e),playTicks};s.checkpoint={room:s.room,name};
    s.saveSerial++;saveRecord=encodeSave(project,{id:e.id,name},checkpoint);
    playUiSound(UI_SOUNDS.save);
    run(e.event);
  }
  function resolveSave(accepted){
    const request=s.saveRequest;
    if(!request)return false;
    if(accepted&&!request.saved){
      recordSave(target(request.id));
      // The mounted player holds the acknowledgement open. Simulation callers can continue as soon as the slot is written.
      if(systemUi){
        s.saveRequest={...request,saved:true,time:playTicks,dismissAt:s.tick+4};
        return true;
      }
    }
    s.saveRequest=null;blocker=null;s.locked=!!(program.length||pending.length);
    return true;
  }
  function takeSave(){
    const saved=saveRecord;saveRecord=null;return saved;
  }
  function continueDefeat(){
    if(!s.defeat)return false;
    s.defeat=null;blocker=null;defeatInput.clear();
    if(defeatEvent)program.unshift({op:'call',event:defeatEvent});
    defeatEvent=null;s.locked=!!(program.length||pending.length);
    return true;
  }
  const mark=(e,patch)=>s.changed[e.id]={...s.changed[e.id],...patch};
  const available=e=>!e.once||!s.used[token(s.room,e.id)];
  function run(id){if(id!==undefined)pending.push(id);}
  function use(e){
    const pass=testCondition(e.when,s);
    if(!pass){if(e.otherwise)run(e.otherwise);else announce('现在还不能使用。');return;}
    if(e.kind==='door'&&!e.room){announce('这扇门没有设置去向。');return;}
    if(e.kind==='savepoint'){
      if(e.heal??true)changeHp('party',0,true);
      playUiSound(UI_SOUNDS.savePoint);
      if(e.beforeEvent){run(e.beforeEvent);run([{op:'saveChoice',actor:e.id}]);}
      else promptSave(e);
      return;
    }
    if(e.once&&!(e.kind==='enemy'&&e.battle))s.used[token(s.room,e.id)]=true;
    if(e.kind==='enemy'&&e.battle){
      run(e.event);
      run([{op:'battle',battle:e.battle,enemy:e.id,once:e.once}]);
    }else if(e.kind==='door'){
      if(e.event)run(e.event);
      pending.push([{op:'goto',room:e.room,entry:e.entry,fade:e.fade}]);
    } else if(e.kind==='checkpoint'){savePoint(e.name);run(e.event);}
    else if(e.kind==='mode'){setMode(e.mode,e.grip);run(e.event);}
    else run(e.event);
  }
  function promptSave(e){
    if(e.confirm===false){recordSave(e);announce('已保存：'+(e.name??'存档点'));return;}
    const playerName=(s.party.kris??Object.values(s.party)[0])?.name??'Kris';
    resetMotion();s.prompt=s.hold=s.note=null;
    s.saveRequest={id:e.id,name:e.name??'存档点',heal:e.heal??true,index:0,playerName,time:playTicks,saved:false};
    blocker={kind:'savepoint'};
  }
  function target(actor){
    if(actor==='player')return s.player;
    return entities().find(e=>e.id===actor);
  }
  function dialogueSide(threshold){
    const room=original[s.room];
    const cameraY=s.camera.follow?cameraFor(project,room,s.player.x,s.player.y).y:s.camera.y;
    const {w,h}=project.viewport??{w:640,h:480};
    const viewport=uiViewport(w,h), logical=roomTransform(project,room);
    const screenY=(logical.y+(s.player.y-cameraY)*logical.scale-viewport.y)/viewport.scale;
    return screenY>threshold?0:1;
  }
  function showDialogueRows(firstRow){
    const d=s.dialogue, b=blocker, page=d.pages[d.page];
    const name=page.speaker?.trim().toLowerCase();
    const voice=Object.hasOwn(UI_VOICES,name)?UI_VOICES[name]:UI_VOICES.narrator;
    d.lines=b.rows.slice(firstRow,firstRow+DIALOGUE_ROWS);
    d.age=0;d.visible='';
    b.firstRow=firstRow;
    b.pauses=new Map();
    let text='';
    for(const row of d.lines){
      for(const [i,ticks] of row.pauses){
        const offset=text.length+i;
        b.pauses.set(offset,(b.pauses.get(offset)??0)+ticks);
      }
      text+=row.text;
    }
    b.writer=createTypewriter(text,{voice,onVoice:({name})=>onDialogueSound?.(name)});
  }
  function showDialoguePage(){
    const page=s.dialogue.pages[s.dialogue.page];
    blocker.rows=layoutDialogue(page.text,Boolean(page.portrait));
    showDialogueRows(0);
  }
  function openDialogue(pages,side=dialogueSide(sceneWorld(project,original[s.room])==='light'?260:250)){
    s.dialogue={page:0,pages:pages.map(p=>typeof p==='string'?{text:p}:p),side,boxAge:0};
    blocker={kind:'say'};
    showDialoguePage();
  }
  function openChoice(action,questionLines,side,boxAge){
    s.choice={question:action.question,options:action.options,index:0,selected:false,side,boxAge,
      questionLines,cursorWeights:action.options.map(()=>0)};
    blocker={kind:'choose'};
  }
  function startChoice(action,previousDialogue){
    const side=previousDialogue?.side??dialogueSide(260);
    // scr_readychoicer queues "\C2" as its own message: the question is an ordinary page (Z to go on),
    // then the choices appear alone in the same box.
    if(!action.question?.trim()){openChoice(action,[],side,previousDialogue?.boxAge??0);return;}
    // Overworld questions are ordinary asterisk lines.
    const question=action.question.trimStart().startsWith('*')?action.question:'* '+action.question;
    openDialogue([question],side);
    blocker.choiceAfter={action,questionLines:[]};
  }
  function stepDialogue(input){
    const d=s.dialogue, b=blocker;
    ++d.age;++d.boxAge;
    const confirm=input.press.has('act');
    if(confirm&&b.writer.done&&!b.pauses.size){
      const nextRow=b.firstRow+DIALOGUE_ROWS;
      if(nextRow<b.rows.length)showDialogueRows(nextRow);
      else if(d.page+1<d.pages.length){
        ++d.page;
        showDialoguePage();
      }else{
        s.dialogue=null;blocker=null;
        if(b.choiceAfter)openChoice(b.choiceAfter.action,b.choiceAfter.questionLines,d.side,d.boxAge);
      }
    }else if(confirm||input.hold.has('cancel')||input.press.has('cancel')){
      b.pauses.clear();
      d.visible=b.writer.skip();
    }else{
      const offset=d.visible.length, delay=b.pauses.get(offset);
      if(delay===1)b.pauses.delete(offset);
      else if(delay)b.pauses.set(offset,delay-1);
      else d.visible=b.writer.advance();
    }
  }
  const choiceDirections=['left','right','up','down'];
  function choiceTarget(c,input){
    let direction=choiceDirections.find(key=>input.press.has(key));
    if(!direction&&!c.selected)direction=choiceDirections.find(key=>input.hold.has(key));
    if(!direction)return null;
    const index=choiceDirections.indexOf(direction), count=c.options.length;
    // The scene navigator and existing keyboard routes can still cycle through all options.
    const cycleDown=direction==='down'&&blocker.lastDirection==='down';
    blocker.lastDirection=direction;
    if(cycleDown)return (c.index+1)%count;
    // The extra lower corners extend the original four directional slots for six-option scenes.
    if(direction==='down'&&c.selected&&c.index<2&&count>c.index+4)return c.index+4;
    if(direction==='up'&&c.index>=4)return c.index-4;
    if(index<count)return index;
    return (c.index+(direction==='down'?1:count-1))%count;
  }
  function stepChoice(input){
    const c=s.choice;
    ++c.boxAge;
    const target=choiceTarget(c,input);
    if(target!==null&&target>=0&&target<c.options.length&&(!c.selected||target!==c.index)){
      // obj_choicer_neo has no generic move or confirm sound.
      c.index=target;c.selected=true;
    }
    if(c.selected){
      // Interpolate the target weights at 30 Hz so late font loading can change the measured positions.
      c.cursorWeights.forEach((weight,i)=>{c.cursorWeights[i]=lerp(weight,Number(i===c.index),0.8);});
    }
    if(input.press.has('act')){
      program.unshift(...c.options[c.index].actions);
      s.choice=null;blocker=null;
    }
  }
  function startEvent(id){
    const script=Array.isArray(id)?id:events[id];
    if(Array.isArray(script))program.unshift(...script);
    else if(script?.type==='rhythm'){
      const lead=script.lead??28;
      s.rhythm={title:script.title??'节奏机关',age:-lead,window:script.window??4,lead,beats:script.beats,
        results:script.beats.map(()=>null),cursor:0,hits:0,feedback:null,done:null};
      blocker={kind:'rhythm',spec:script};
    }else if(script?.type==='keypad'){
      s.keypad={title:script.title??'密码锁',hint:script.hint??'',code:script.code,entry:'',cursor:0,status:null,done:null,passed:false};
      blocker={kind:'keypad',spec:script};
    }
  }
  function advanceProgram(previousDialogue=null){
    let budget=128;
    while(!blocker&&(program.length||pending.length)&&budget-->0){
      if(!program.length){startEvent(pending.shift());continue;}
      const a=program.shift();
      switch(a.op){
        default:invoke(plugins.actions.get(a.op),'execute',{...context(),action:a});break;
        case 'flag':s.flags[a.id]=a.value;break;
        case 'item':s.inventory[a.id]=clamp((s.inventory[a.id]??0)+a.delta,0,999999);break;
        case 'hp':changeHp(a.member,a.delta,a.full===true);break;
        case 'say':openDialogue(a.pages);break;
        case 'choose':startChoice(a,previousDialogue);break;
        case 'wait':blocker={kind:'wait',until:s.tick+a.ticks};break;
        case 'show':{const e=target(a.actor);if(e)mark(e,{hidden:!a.value});break;}
        case 'sprite':{const e=target(a.actor);if(e===s.player)e.sprite=a.sprite;else if(e)mark(e,{sprite:a.sprite});break;}
        case 'move':{
          const e=target(a.actor);
          if(e)blocker={kind:'move',actor:a.actor,fromX:e.x,fromY:e.y,toX:a.x,toY:a.y,face:a.face,age:0,ticks:a.ticks??1};
          break;
        }
        case 'camera':{
          if(a.follow){s.camera.follow=true;break;}
          const point=cameraFor(project,original[s.room],a.x,a.y);
          s.camera.follow=false;blocker={kind:'camera',fromX:s.camera.x,fromY:s.camera.y,toX:point.x,toY:point.y,age:0,ticks:a.ticks??1};break;
        }
        case 'branch':program.unshift(...(testCondition(a.if,s)?a.then:a.else??[]));break;
        case 'call':startEvent(a.event);break;
        case 'timer':timers.push({room:a.global?null:s.room,event:a.event,at:s.tick+a.ticks});break;
        case 'goto':{
          if(a.fade===0){program=[];pending=[];previousDialogue=null;roomEnter(a.room,a.entry);break;}
          // Ordinary doors switch rooms at frame 8. Explicit script/door fades keep their authored duration.
          const switchAt=a.fade??8,fadeStep=a.fade===undefined ? .08 : 1/a.fade;
          blocker={kind:'goto',room:a.room,entry:a.entry,switchAt,fadeStep,fadeInTicks:a.fade??13,age:0};
          break;
        }
        case 'saveChoice':promptSave(target(a.actor));break;
        case 'checkpoint':savePoint();break;
        case 'restore':restorePoint();break;
        case 'mode':setMode(a.mode,a.grip);break;
        case 'flash':case 'shake':case 'titlecard':case 'fade':triggerFx(a);break;
        case 'battle':{
          resetMotion();s.hold=s.prompt=null;
          s.battle={id:a.battle,serial:++battleSerial,room:s.room,enemy:a.enemy??null};
          blocker={kind:'battle',once:a.once===true};
          break;
        }
      }
    }
    if(!blocker&&(program.length||pending.length)){
      if(++runaway>=64){pending=[];program=[];runaway=0;announce('同一时刻的事件执行过长，已结束。');}
    }else runaway=0;
  }
  function stepRhythm(input){
    const r=s.rhythm,a=blocker.spec;
    if(r.done!==null){
      if(s.tick>=r.done){const evt=r.passed?a.onWin:a.onLose;s.rhythm=null;blocker=null;if(evt)startEvent(evt);}
      return;
    }
    ++r.age;
    while(r.cursor<r.beats.length&&r.age>r.beats[r.cursor].at+r.window){
      r.results[r.cursor++]='miss';r.feedback={text:'漏拍',until:r.age+13,ok:false};
    }
    const beat=r.beats[r.cursor];
    if(beat&&INPUTS.slice(0,5).some(k=>input.press.has(k))){
      const offset=r.age-beat.at;
      if(Math.abs(offset)<=r.window){
        const good=input.press.has(beat.key);
        r.results[r.cursor++]=good?'hit':'miss';r.hits+=Number(good);
        r.feedback={text:good?(Math.abs(offset)<=1?'正中':'命中'):'按错',until:r.age+13,ok:good};
      }else if(offset<0)r.feedback={text:'太早',until:r.age+13,ok:false};
    }
    if(r.cursor>=r.beats.length){
      r.passed=r.hits>=(a.minHits??r.beats.length);
      r.done=s.tick+(a.resultTicks??30);
    }
  }
  function stepKeypad(input){
    const k=s.keypad,spec=blocker.spec;
    if(k.done!==null){
      if(s.tick>=k.done){const evt=k.passed?spec.onWin:spec.onLose;s.keypad=null;blocker=null;if(evt)startEvent(evt);}
      return;
    }
    const col=k.cursor%3,row=Math.floor(k.cursor/3);
    if(input.press.has('left'))k.cursor=row*3+(col+2)%3;
    if(input.press.has('right'))k.cursor=row*3+(col+1)%3;
    if(input.press.has('up'))k.cursor=((row+3)%4)*3+col;
    if(input.press.has('down'))k.cursor=((row+1)%4)*3+col;
    if(input.press.has('cancel')){
      if(k.entry.length){k.entry=k.entry.slice(0,-1);k.status=null;}
      else{s.keypad=null;blocker=null;if(spec.onLose)startEvent(spec.onLose);}
      return;
    }
    if(input.press.has('act')){
      const ch=KEYPAD_KEYS[k.cursor];
      if(ch==='⌫'){k.entry=k.entry.slice(0,-1);k.status=null;}
      else if(ch==='OK'){
        if(k.entry===k.code){k.passed=true;k.status='密码正确 · 已解锁！';k.done=s.tick+22;}
        else{k.passed=false;k.status='密码错误，请重试';k.entry='';}
      }else if(k.entry.length<k.code.length){
        k.entry+=ch;k.status=null;
        if(k.entry.length===k.code.length){
          if(k.entry===k.code){k.passed=true;k.status='密码正确 · 已解锁！';k.done=s.tick+22;}
          else{k.passed=false;k.status='密码错误，请重试';k.entry='';}
        }
      }
    }
  }
  function stepBlocker(input){
    const b=blocker;
    if(!b)return;
    if(b.kind==='savepoint'){
      const request=s.saveRequest;
      const act=input.press.has('act'),cancel=input.press.has('cancel');
      if(request.saved){
        if(s.tick>=request.dismissAt&&(act||cancel))resolveSave(false);
      }else{
        request.time=playTicks;
        if(input.press.has('left')||input.press.has('right'))request.index=1-request.index;
        if(cancel)resolveSave(false);
        else if(act)resolveSave(request.index===0);
      }
    }else if(b.kind==='say')stepDialogue(input);
    else if(b.kind==='choose')stepChoice(input);
    else if(b.kind==='rhythm')stepRhythm(input);
    else if(b.kind==='keypad')stepKeypad(input);
    else if(b.kind==='wait'){if(s.tick>=b.until)blocker=null;}
    else if(b.kind==='goto'){
      const relative=++b.age-b.switchAt;
      if(relative>=b.fadeInTicks){s.fade=0;blocker=null;return;}
      s.fade=relative<0?b.age*b.fadeStep:Math.max(0,1-relative*b.fadeStep);
      if(relative===0){program=[];pending=[];roomEnter(b.room,b.entry);}
    }else{
      const t=++b.age/b.ticks,e=b.kind==='camera'?s.camera:target(b.actor);
      if(e){
        const x=lerp(b.fromX,b.toX,t),y=lerp(b.fromY,b.toY,t);
        if(b.kind==='camera')Object.assign(s.camera,{x,y});
        else if(e===s.player){
          const r=original[s.room];
          const face=b.face??(Math.abs(b.toX-b.fromX)>Math.abs(b.toY-b.fromY)?b.toX>b.fromX?'right':'left':b.toY>b.fromY?'down':'up');
          Object.assign(s.player,{x:clamp(x,radius,r.w-radius),y:clamp(y,radius,r.h-radius),face,walking:t<1});
        } else {
          const r=original[s.room];mark(e,{x:clamp(x,0,r.w-e.w),y:clamp(y,0,r.h-e.h)});
        }
      }
      if(t>=1)blocker=null;
    }
  }

  function solidsFor(e){return !plugins.entities.get(e.kind)?.hooks.ignoreSolid&&(e.kind==='wall'||e.kind==='block'||e.solid);}
  function slideAxis(axis,amount){
    if(!amount)return 0;
    const r=original[s.room], limit=axis==='x'?r.w:r.h;
    let moved=0;
    // At most one pixel per substep: no tunnelling through one-pixel walls.
    for(let i=0,n=Math.ceil(Math.abs(amount));i<n;i++){
      const d=amount/n,p=s.player,current=playerBox();
      const lower=p[axis]-current[axis],extent=axis==='x'?current.w:current.h;
      const goal=clamp(p[axis]+d,lower,limit-extent+lower);
      if(goal===p[axis])break;
      const b={...current,[axis]:current[axis]+goal-p[axis]};
      const hit=active.filter(e=>solidsFor(e)&&overlap(b,e)&&
        !(isPlatformMode(s.mode,project)&&e.oneWay&&(axis!=='y'||d<0||current.y+current.h>e.y+0.001)));
      if(hit.length){
        if(hit.length!==1||hit[0].kind!=='block')break;
        const e=hit[0],next={...e,[axis]:e[axis]+d};
        if(next.x<0||next.y<0||next.x+next.w>r.w||next.y+next.h>r.h||
          active.some(o=>o!==e&&solidsFor(o)&&overlap(next,o)))break;
        e[axis]=next[axis];mark(e,{[axis]:next[axis]});
        // If the pushed block sits on an active slide (ice) tile, launch it gliding across the ice!
        if(active.some(m=>m.kind==='mode'&&m.mode==='slide'&&overlap(e,m))){
          slidingBlocks.set(e.id,{axis,dir:Math.sign(d)});
        }
        if(overlap(b,e))break;
      }
      const before=p[axis];p[axis]=goal;moved+=goal-before;
    }
    return moved;
  }
  function stepSlidingBlocks(){
    if(!slidingBlocks.size)return;
    const r=original[s.room];
    for(const [id,vel] of [...slidingBlocks.entries()]){
      const e=active.find(o=>o.id===id&&o.kind==='block');
      if(!e||!active.some(m=>m.kind==='mode'&&m.mode==='slide'&&overlap(e,m))){slidingBlocks.delete(id);continue;}
      let stopped=false;
      for(let k=0;k<5;k++){
        const next={...e,[vel.axis]:e[vel.axis]+vel.dir};
        if(next.x<0||next.y<0||next.x+next.w>r.w||next.y+next.h>r.h||
          active.some(o=>o!==e&&solidsFor(o)&&overlap(next,o))||overlap(next,playerBox())){stopped=true;break;}
        e[vel.axis]=next[vel.axis];mark(e,{[vel.axis]:next[vel.axis]});
        if(!active.some(m=>m.kind==='mode'&&m.mode==='slide'&&overlap(e,m))){stopped=true;break;}
      }
      if(stopped)slidingBlocks.delete(id);
    }
  }
  function rayDist(ox,oy,ang,maxRange,occluders){
    const dx=Math.cos(ang),dy=Math.sin(ang);
    let best=maxRange;
    for(const o of occluders){
      // Ray vs AABB slab test
      let tmin=0,tmax=best;
      if(Math.abs(dx)<1e-6){if(ox<o.x||ox>o.x+o.w)continue;}
      else{let t1=(o.x-ox)/dx,t2=(o.x+o.w-ox)/dx;if(t1>t2)[t1,t2]=[t2,t1];tmin=Math.max(tmin,t1);tmax=Math.min(tmax,t2);if(tmin>tmax)continue;}
      if(Math.abs(dy)<1e-6){if(oy<o.y||oy>o.y+o.h)continue;}
      else{let t1=(o.y-oy)/dy,t2=(o.y+o.h-oy)/dy;if(t1>t2)[t1,t2]=[t2,t1];tmin=Math.max(tmin,t1);tmax=Math.min(tmax,t2);if(tmin>tmax)continue;}
      if(tmin>0&&tmin<best)best=tmin;
    }
    return best;
  }
  function updateBeams(canCatch){
    const casters=active.filter(e=>e.beam);
    if(!casters.length){s.beams=[];return;}
    const occluders=active.filter(e=>solidsFor(e)&&!e.beam);
    const out=[];let caught=null;
    const px=s.player.x,py=s.player.y;
    for(const e of casters){
      const b=e.beam,ox=e.x+e.w/2,oy=e.y+e.h/2;
      const sweep=(b.sweep??0)*Math.sin(s.tick*2*Math.PI/(b.period??120));
      const mid=(b.angle+sweep)*Math.PI/180,half=((b.spread??30)/2)*Math.PI/180;
      const rays=16,pts=[[ox,oy]];
      for(let i=0;i<=rays;i++){
        const a=mid-half+(2*half*i/rays);
        const d=rayDist(ox,oy,a,b.range,occluders);
        pts.push([ox+Math.cos(a)*d,oy+Math.sin(a)*d]);
      }
      out.push({id:e.id,ox,oy,pts,color:b.color??'#ffe078'});
      if(canCatch&&beamCooldown<=0&&b.onCatch&&!caught){
        const vx=px-ox,vy=py-oy,dist=Math.hypot(vx,vy);
        if(dist>4&&dist<=b.range-4){
          let diff=Math.atan2(vy,vx)-mid;
          while(diff>Math.PI)diff-=2*Math.PI;while(diff<-Math.PI)diff+=2*Math.PI;
          if(Math.abs(diff)<=half){
            const hitD=rayDist(ox,oy,Math.atan2(vy,vx),b.range,occluders);
            if(dist<hitD+radius*0.4){caught=b.onCatch;}
          }
        }
      }
    }
    s.beams=out;
    if(caught){beamCooldown=45;run(caught);}
  }
  function platformMove(input,x,drive){
    const p=s.player,r=original[s.room],cfg=r.platform??{};
    const defaults=modePlugin?.hooks.platform??PLATFORM_DEFAULTS.platform;
    const fighter=invoke(modePlugin,'movementProfile',context(input));
    const speedX=(input.hold.has('run')?fighter?.runSpeed:null)??fighter?.walkSpeed??cfg.speed??defaults.speed, accel=cfg.acceleration??defaults.acceleration, gravity=cfg.gravity??defaults.gravity;
    const groundBelow=()=>{
      const b=playerBox(),bottom=b.y+b.h;
      let top=Infinity;
      for(const e of active)if(solidsFor(e)&&b.x+b.w>e.x&&b.x<e.x+e.w&&bottom<=e.y+.001&&bottom+1>=e.y)top=Math.min(top,e.y);
      return top;
    };
    const ground=Number.isFinite(groundBelow());
    if(ground){hoverTicks=cfg.hoverTicks??0;hovering=false;if(!dashTicks)dashReady=true}
    else if(input.press.has('up')&&hoverTicks>0)hovering=true;
    if(!input.hold.has('up')||hoverTicks<=0)hovering=false;
    if(drive)p.vx=drive.vx;
    else if(!modePlugin?.hooks.customDash&&cfg.dashSpeed&&dashReady&&input.press.has('dash')){
      dashReady=false;dashTicks=cfg.dashTicks??12;
      p.vx=(x||(p.face==='left'?-1:1))*cfg.dashSpeed;
    }else if(!dashTicks)p.vx+=clamp(x*speedX-p.vx,-accel,accel);
    if(dashTicks)dashTicks--;
    if(x&&!drive)p.face=x>0?'right':'left';
    p.vy=ground&&!drive?.lock&&input.press.has('up')?-(fighter?.jump??cfg.jump??defaults.jump):Math.min(p.vy+gravity,cfg.fallSpeed??defaults.fallSpeed);
    if(drive?.suspend)p.vy=0;
    if(hovering){p.vy=0;hoverTicks--}
    const dx=slideAxis('x',p.vx),dy=slideAxis('y',p.vy);
    if(Math.abs(dx-p.vx)>.01)p.vx=0;
    if(Math.abs(dy-p.vy)>.01)p.vy=0;
    if(!p.vx)dashTicks=0;
    if(fighter){
      const top=groundBelow();
      p.grounded=Number.isFinite(top);
      // Collision substeps can stop just short of the surface. Keep resting feet flush with it.
      if(p.grounded&&p.vy===0&&!drive?.suspend&&!hovering)p.y=top;
    }
    p.walking=Math.abs(dx)>.04;followParty();
  }
  function movement(input){
    const p=s.player,x=Number(input.hold.has('right'))-Number(input.hold.has('left')),
      y=Number(input.hold.has('down'))-Number(input.hold.has('up'));
    if(isPlatformMode(s.mode,project)){platformMove(input,x);return}
    const norm=Math.hypot(x,y)||1;
    if(x||y) p.face=x?x>0?'right':'left':y>0?'down':'up';
    const factor=s.mode==='climb'?.66:1;
    if(s.mode==='slide'){
      p.vx=(p.vx+x/norm*speed*.25)*.84;p.vy=(p.vy+y/norm*speed*.25)*.84;
      if(Math.abs(p.vx)<.035)p.vx=0;
      if(Math.abs(p.vy)<.035)p.vy=0;
    }else{p.vx=x/norm*speed*factor;p.vy=y/norm*speed*factor;}
    const dx=slideAxis('x',p.vx),dy=slideAxis('y',p.vy);
    if(Math.abs(dx-p.vx)>.01)p.vx=0;
    if(Math.abs(dy-p.vy)>.01)p.vy=0;
    p.walking=Math.abs(dx)+Math.abs(dy)>.04;followParty();
  }
  function updateSwitches(){
    const contacts=new Map();
    for(const e of active){
      if(e.kind!=='switch')continue;
      switchFlags.add(e.flag);
      const weight=overlap(playerBox(),e)||active.some(b=>b.kind==='block'&&overlap(b,e));
      const was=previous.has(e.id);
      if(weight)previous.add(e.id);else previous.delete(e.id);
      const pass=weight&&testCondition(e.when,s);
      const current=contacts.get(e.flag)??false;
      contacts.set(e.flag,current||pass||e.latch===true&&s.flags[e.flag]===true);
      if(pass&&!was&&available(e)){
        if(e.once)s.used[token(s.room,e.id)]=true;
        run(e.event);
      }
    }
    // A disabled switch must release its pressure even if it disappears.
    for(const flag of switchFlags)if(contacts.has(flag))s.flags[flag]=contacts.get(flag);
    else if(!entities().some(e=>e.kind==='switch'&&e.flag===flag&&e.latch))s.flags[flag]=false;
  }
  function reachable(e){
    const p=s.player,cx=clamp(p.x,e.x,e.x+e.w),cy=clamp(p.y,e.y,e.y+e.h);
    const dx=cx-p.x,dy=cy-p.y;
    if(dx*dx+dy*dy>(reach+radius)**2)return Infinity;
    if(e.facing!==false&&Math.abs(dx)+Math.abs(dy)>2){
      const front=p.face==='up'?-dy:p.face==='down'?dy:p.face==='left'?-dx:dx;
      const across=p.face==='up'||p.face==='down'?Math.abs(dx):Math.abs(dy);
      if(front<0||across>Math.max(front*1.35,radius+2))return Infinity;
    }
    return Math.hypot(dx,dy);
  }
  function automatic(e){return e.auto??['zone','mode','checkpoint','enemy'].includes(e.kind);}
  function toolSweep(input){
    const tool=original[s.room].tool, p=s.player;
    if(!tool||!s.inventory[tool.item]){s.tool=null;return false;}
    const {range,width}=tool.variants?.find(v=>testCondition(v.when,s))??tool;
    const ahead=p.face==='down'||p.face==='right';
    const vertical=p.face==='up'||p.face==='down',half=width/2;
    const area=vertical?{x:p.x-half,y:ahead?p.y:p.y-range,w:width,h:range}:
      {x:ahead?p.x:p.x-range,y:p.y-half,w:range,h:width};
    const held=input.hold.has('tool')||input.press.has('tool');
    const age=held?(s.tool?.age??0)+1:0;
    s.tool={area,age,sprite:tool.sprite};
    if(age>0&&age%tool.ticks===0){
      for(const e of active){
        if(e.toolTarget&&available(e)&&overlap(area,e)&&testCondition(e.when,s))use(e);
      }
    }
    return held;
  }
  function worldInteractions(input,onAct){
    const under=active.filter(e=>overlap(playerBox(),e));
    let exclusive=false;
    for(const e of under){
      if(!available(e)||!automatic(e)||!['zone','door','mode','checkpoint','savepoint','enemy'].includes(e.kind)||occupied.has(e.id))continue;
      use(e);
      if((e.kind==='door'||e.kind==='enemy'||e.kind==='savepoint')&&testCondition(e.when,s)){exclusive=true;break;}
    }
    occupied=new Set(under.map(e=>e.id));
    if(exclusive){s.prompt=s.hold=null;return;}
    const climb=under.find(e=>e.kind==='mode'&&e.mode==='climb'&&automatic(e)&&testCondition(e.when,s));
    const rest=under.some(e=>e.kind==='mode'&&e.mode==='climb'&&e.rest&&testCondition(e.when,s));
    const slideZone=under.some(e=>e.kind==='mode'&&e.mode==='slide'&&automatic(e)&&testCondition(e.when,s));
    if(contact&&!climb&&s.mode==='climb')setMode(original[s.room].mode??'walk');
    if(s.mode==='slide'&&(original[s.room].mode??'walk')!=='slide'&&!slideZone)setMode(original[s.room].mode??'walk');
    contact=climb?.id??null;
    if(s.mode==='climb'){
      if(rest) s.grip=s.maxGrip;
      else if(--s.grip<=0){
        if(checkpoint)restorePoint();
        else {setMode('walk');announce('抓力用完了。');}
        return;
      }
    }
    if(onAct)s.tool=null;
    const usingTool=!onAct&&toolSweep(input);
    let selected=null,best=Infinity;
    for(const e of active){
      if(e.toolTarget||!['npc','enemy','door','prop','zone','checkpoint','savepoint','mode','hold'].includes(e.kind)||automatic(e)||!available(e)||e.kind==='prop'&&!e.event&&!e.otherwise)continue;
      const d=reachable(e);
      if(d<best){selected=e;best=d;}
    }
    s.prompt=selected?{id:selected.id,name:selected.name??'互动',hold:selected.kind==='hold'}:null;
    if(selected?.kind==='hold'){
      const e=selected;
      if(!s.hold||s.hold.id!==e.id)s.hold={id:e.id,ticks:e.ticks,progress:0,complete:false};
      const h=s.hold,pressed=input.press.has('act'),held=input.hold.has('act');
      if(!held&&!pressed){h.progress=h.complete?0:Math.max(0,h.progress-(e.decay??2));h.complete=false;}
      else if(!h.complete&&testCondition(e.when,s)){
        if(++h.progress>=e.ticks){h.progress=e.ticks;h.complete=true;use(e);}
      }else if(pressed&&!testCondition(e.when,s)){if(e.otherwise)run(e.otherwise);else announce('现在还不能使用。');}
    }else{
      s.hold=null;
      if(input.press.has('act')){
        if(selected&&!usingTool)use(selected);
        else if(!selected)onAct?.();
      }
    }
  }
  function completeBattle(serial,outcome){
    const request=s.battle;
    if(!request||request.serial!==serial||!BATTLE_RESULTS.includes(outcome?.result))return false;
    const ref=battles[request.id],result=outcome.result;
    if(Number.isSafeInteger(outcome.frame)&&outcome.frame>0)playTicks+=outcome.frame;
    if(blocker.once&&(result==='victory'||result==='spared'))s.used[token(s.room,request.enemy)]=true;
    if(ref.resultFlag)s.flags[ref.resultFlag]=result;
    s.lastBattle={id:request.id,result,frame:outcome.frame??null,turn:outcome.turn??null};
    if(outcome.progress){
      for(const [id,hp] of Object.entries(outcome.progress.hp))s.party[id].hp=clamp(hp,0,s.party[id].maxHp);
      for(const [id,n] of Object.entries(outcome.progress.items))s.inventory[id]=n;
    }
    for(const [id,count] of Object.entries(ref.rewards?.[result]??{}))
      s.inventory[id]=clamp((s.inventory[id]??0)+count,0,999999);
    clearBattle();
    if(result==='defeat'&&(ref.defeat??project.campaign?.defeat)==='load'){
      s.defeat=createDefeatUi(request.id,s.party);defeatEvent=ref.on?.defeat;
      blocker={kind:'defeat'};s.locked=true;
      playUiSound(UI_SOUNDS.hurt);
    }else if(ref.on?.[result])program.unshift({op:'call',event:ref.on[result]});
    s.locked=!!(blocker||program.length||pending.length);
    return true;
  }
  function clearBattle(){
    s.battle=null;blocker=null;
    occupied=new Set(activeEntities().filter(e=>overlap(playerBox(),e)).map(e=>e.id));
    s.locked=!!(program.length||pending.length);
  }
  function abortBattle(serial){
    if(s.battle?.serial!==serial)return false;
    program=[];pending=[];clearBattle();
    return true;
  }
  function retryPlatform(room){
    const point=room.entries[room.platform?.retryEntry]??room.entries[platformEntry]??Object.values(room.entries)[0];
    Object.assign(s.player,{x:point.x,y:point.y,face:point.face??'right'});
    resetMotion();dashTicks=0;dashReady=true;hoverTicks=0;hovering=false;followParty(true);cameraSnap();
    occupied=new Set(activeEntities().filter(e=>overlap(playerBox(),e)).map(e=>e.id));
  }
  function updateRoomContacts(){
    stepSlidingBlocks();
    updateSwitches();
    active=activeEntities();
    updateBeams(true);
  }
  function step(input={}){
    if(s.battle)return s;
    input={hold:new Set(input.hold??[]),press:new Set(input.press??[])};
    // C is the original menu key. In a room whose hand-held tool the party carries, C works the tool instead,
    // so scenes that teach "hold C" keep working; the menu is still one press away anywhere else.
    const roomTool=original[s.room]?.tool;
    if(!s.menu&&(modePlugin?.hooks.toolKey||roomTool&&s.inventory[roomTool.item])){
      if(input.press.delete('menu'))input.press.add('tool');
      if(input.hold.delete('menu'))input.hold.add('tool');
    }
    if(s.defeat){
      for(const key of defeatInput)input.press.add(key);
      defeatInput.clear();
      const action=stepDefeatUi(s.defeat,input.press,playUiSound);
      if(action)systemUi?.resolveDefeat(action);
      return s;
    }
    ++playTicks;
    if(s.menu){
      s.menu=stepSystemMenu(s.menu,s,input.press,playUiSound);
      s.locked=!!s.menu;
      return s;
    }
    if(!blocker&&!program.length&&!pending.length&&input.press.has('menu')){
      s.menu=createSystemMenu(sceneWorld(project,original[s.room]));
      s.player.walking=false;s.prompt=s.hold=null;s.locked=true;
      return s;
    }
    ++s.tick;
    if(s.director)stepDirector(s.director,s.tick);
    if(timeline)input=timeline.step(triggerFx);
    if(s.note&&s.tick>=s.note.until)s.note=null;
    if(blocker?.kind!=='goto'){
      for(const t of timers)if(t.at<=s.tick&&(!t.room||s.room===t.room))run(t.event);
      timers=timers.filter(t=>t.at>s.tick);
    }
    if(blocker){
      resetMotion();s.prompt=null;
      active=activeEntities();updateBeams(false);
      const previousDialogue=s.dialogue;
      stepBlocker(input);advanceProgram(previousDialogue);
    }else if(input.press.has('cancel')&&checkpoint){
      restorePoint();
    }else if(pending.length||program.length){
      resetMotion();s.prompt=null;active=activeEntities();updateBeams(false);advanceProgram();
    }else{
      if(beamCooldown>0)beamCooldown--;
      active=activeEntities();
      const frame=context(input);
      if(modePlugin?.hooks.step)invoke(modePlugin,'step',frame);
      else frame.move();
      if(plugins.entities.size)for(const entity of active){
        const ext=plugins.entities.get(entity.kind);
        if(ext?.hooks.step)invoke(ext,'step',{...context(input),entity});
      }
      advanceProgram();
      const room=original[s.room];
      if(isPlatformMode(s.mode,project)&&!blocker&&!program.length&&!pending.length&&playerBox().y+playerBox().h>=room.h-.001){
        retryPlatform(room);
        invoke(modePlugin,'retry',context(input));
      }
    }
    s.locked=!!(blocker||pending.length||program.length);
    if(s.camera.follow){
      const point=cameraFor(project,original[s.room],s.player.x,s.player.y);
      s.camera.x=point.x;s.camera.y=point.y;
    }
    return s;
  }
  roomEnter(project.start.room,project.start.entry);
  return {state:s,step,playerBox,solidsFor,dispose:exitMode,completeBattle,abortBattle,restoreSave,continueDefeat,resolveSave,takeSave,connectSystemUi,
    pressDefeat:key=>{if(s.defeat)defeatInput.add(key);},
    startTrailerScript,stopTrailerScript,trailerStatus:()=>timeline?.status()??null,
    entities:activeEntities,room:()=>original[s.room],project,radius,viewport:project.viewport??{w:640,h:480},hz:HZ};
}
