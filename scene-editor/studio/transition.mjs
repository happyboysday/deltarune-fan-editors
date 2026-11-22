
import {drawScene} from './view.mjs';
import {sceneWorld} from './ui-draw.mjs';
import {roomTransform} from './world.mjs';

const entryClamp=(v,a,b)=>Math.max(a,Math.min(v,b));
const mix=(a,b,t)=>a+(b-a)*t;
const smooth=t=>t*t*(3-2*t);
// Chapter 5 obj_encounterbasic uses fixed jump poses and half-speed weapon draws.
// These offsets attach those sprites' canvases to the battle renderer's feet anchors.
const partyPoses={
  spr_krisb_idle:{
    jump:['spr_kris_sword_jump_down',13,46,1],
    land:['spr_krisb_attack',17,49,7]
  },
  spr_susieb_idle:{
    jump:['spr_susier_wall',11,45,1],
    land:['spr_susieb_attack',49,71,6]
  },
  spr_ralseib_idle:{land:['spr_ralseib_battleintro',16,45,9]}
};
export function transitionFor(project,ref){
  return {style:'classic',ticks:25,sound:true,...project.battleTransition,...ref.transition,
    actors:{...project.battleTransition?.actors,...ref.transition?.actors}};
}
function entryFit(source,out){
  const scale=Math.min(out.width/source.width,out.height/source.height);
  return {scale,x:(out.width-source.width*scale)/2,y:(out.height-source.height*scale)/2};
}
export function prepareEntry(stage,source,project,world,art,request,config,playCue){
  const state=world.state,entities=world.entities(),cam=state.camera;
  const before=document.createElement('canvas'),back=document.createElement('canvas');
  before.width=back.width=source.width;before.height=back.height=source.height;
  drawScene(before.getContext('2d'),project,state.room,art,{state:{...state,entities},hideHud:true});
  const exclude=new Set([request.enemy,...Object.values(config.actors)]);
  if(request.enemy===null)exclude.delete(null);
  drawScene(back.getContext('2d'),project,state.room,art,{
    state:{...state,player:null,followers:[],entities:entities.filter(e=>!exclude.has(e.id))},hideHud:true
  });
  stage.entry.width=source.width;stage.entry.height=source.height;
  const fit=entryFit(stage.canvas,stage.entry);
  const r=project.rooms[state.room],layout=roomTransform(project,r);
  const dark=sceneWorld(project,r)==='dark';
  const contact=dark&&request.enemy!=null;
  const view=(x,y)=>({
    x:entryClamp((layout.x+(x-Math.round(cam.x))*layout.scale-fit.x)/fit.scale,8,stage.canvas.width-8),
    y:entryClamp((layout.y+(y-Math.round(cam.y))*layout.scale-fit.y)/fit.scale,16,stage.canvas.height-9),
  });
  const player=view(state.player.x,state.player.y+(r.playerFeetOffset??4));
  const followers=state.followers??[];
  const feet=a=>view(a.x,a.y+(r.playerFeetOffset??4));
  const location=id=>{
    if(!id)return null;
    if(id==='player')return player;
    const actor=followers.find(a=>a.id===id);
    if(actor)return feet(actor);
    const e=entities.find(e=>e.id===id&&!e.hidden);
    return e?view(e.x+e.w/2,e.y+e.h):null;
  };
  const ctx=stage.entry.getContext('2d');
  ctx.imageSmoothingEnabled=false;
  let anchors=null,playedAlert=false,playedImpact=false;
  function positions(encounter){
    if(anchors)return anchors;
    const view=encounter.getState();
    const cast=new Map(view.actors.map(actor=>[actor.id,actor]));
    const enemies=encounter.snapshot?.()?.world?.enemies??view.enemies;
    const fighters=new Set(enemies.map(enemy=>enemy.actor??enemy.id));
    anchors=encounter.entryPositions().map(p=>{
      const actor=cast.get(p.id);
      const mapped=location(config.actors[p.id]);
      // The renderer also groups curtains, audience and other stage props as enemy actors.
      const scenery=p.kind==='enemy'&&!mapped&&!fighters.has(p.id);
      const follower=p.kind==='party'&&p.index>0
        ? followers.find(a=>a.id===p.id)??followers.find(a=>a.slot===p.index-1)
        : null;
      const from=mapped
        ??(follower?feet(follower):null)
        ??(p.kind==='party'?{x:player.x-p.index*15,y:player.y+p.index*13}:scenery?p:location(request.enemy))
        ??{x:Math.max(stage.canvas.width+32,p.x+300),y:p.y};
      const pose=dark&&p.kind==='party'&&actor?.anim==='idle'&&actor.idleSprite===actor.sprite
        ? partyPoses[actor.idleSprite] : null;
      return {...p,from,actor,scenery,pose};
    });
    return anchors;
  }
  function compose(image,alpha=1){
    ctx.globalAlpha=alpha;
    ctx.drawImage(image,0,0);
    ctx.globalAlpha=1;
  }
  function battleLayer(){
    ctx.drawImage(stage.canvas,fit.x,fit.y,stage.canvas.width*fit.scale,stage.canvas.height*fit.scale);
  }
  function place(a,progress,opacity,phase,poseTick=0){
    const x=mix(a.from.x,a.x,progress),y=mix(a.from.y,a.y,progress);
    const pose=a.pose?.[phase];
    if(art.ui&&pose&&a.actor.alpha!==0){
      const [sprite,ox,oy,frames]=pose;
      const scale=2*(a.actor.scale??1)*fit.scale,frame=entryClamp(Math.floor(poseTick/2),0,frames-1);
      ctx.save();
      ctx.translate(Math.round(fit.x+x*fit.scale),Math.round(fit.y+y*fit.scale));
      if(a.actor.flip)ctx.scale(-1,1);
      const drawn=art.ui.drawSprite(ctx,sprite,-ox*scale,-oy*scale,{
        scale,frame,alpha:opacity*(a.actor.alpha??1)
      });
      ctx.restore();
      if(drawn)return {id:a.id,hidden:true};
    }
    return {id:a.id,x:Math.round(x),y:Math.round(y),opacity};
  }
  function render(playerBridge,age,ticks){
    const encounter=playerBridge?.encounter;
    ctx.fillStyle='#000';ctx.fillRect(0,0,stage.entry.width,stage.entry.height);
    if(!encounter||config.style!=='classic'){
      compose(before,encounter&&ticks?1-smooth(entryClamp(age/ticks,0,1)):1);
      return;
    }

    // Contact encounters get the alert before the shared 10-frame rush / 15-frame settle.
    // Both phases fit within the scene author's configured transition duration.
    const alert=contact?Math.max(1,Math.round(ticks/5)):0;
    if(alert&&age>0&&config.sound&&!playedAlert){
      playedAlert=true;
      playCue?.('snd_tensionhorn');
    }
    if(age<=alert){compose(before);return;}

    const elapsed=age-alert,flight=Math.max(1,Math.round((ticks-alert)*2/5));
    const flightFrame=elapsed*10/flight;
    const advance=entryClamp(flightFrame/10,0,1);
    const enemyAdvance=contact?advance:entryClamp(elapsed/Math.max(flight,Math.round(ticks*4/5)),0,1);
    const poseTick=(elapsed-flight)*15/Math.max(1,ticks-alert-flight);
    const foregroundFade=entryClamp(poseTick/15,0,1);
    if(advance>=1&&config.sound&&!playedImpact){
      playedImpact=true;
      playerBridge.impact();
    }

    encounter.drawEntry([],{actors:false});
    battleLayer();
    compose(back,1-advance);
    ctx.save();ctx.beginPath();
    ctx.rect(fit.x,fit.y,stage.canvas.width*fit.scale,stage.canvas.height*fit.scale);
    ctx.clip();
    const p=positions(encounter),trails=[];
    for(let f=1;f<Math.min(flightFrame,10);f++){
      const alpha=.5-(flightFrame-f)*.04;
      if(alpha>0)trails.push(p.map(a=>a.kind==='party'?place(a,f/10,alpha,'jump'):{id:a.id,hidden:true}));
    }
    const actors=p.map(a=>{
      if(a.scenery){
        // Foreground curtains and blackouts close in during the settle, over a visible rush.
        return place(a,1,a.actor?.layer>0?foregroundFade:advance);
      }
      if(a.kind!=='party')return place(a,enemyAdvance,1);
      const phase=advance<1?'jump':age<ticks?'land':null;
      return place(a,advance,1,phase,poseTick);
    });
    encounter.drawEntry(actors,{background:false,trails});
    battleLayer();
    ctx.restore();
  }
  return {render};
}
