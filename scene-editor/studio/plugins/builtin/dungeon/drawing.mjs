import {fighterAnim,drawAnim} from './data.mjs';
import {drawDungeonHud,drawDungeonFx,drawDungeonOverlay} from './view.mjs';

function dungeonPose(e,d,cfg,tick){
  if(!cfg)return null;
  if(d.swing){const sArt=cfg.slashArt?.[d.swing.stage-1];if(sArt)return {sprite:sArt,face:d.swing.dir<0?'left':'right',walking:false};}
  if(d.parry&&d.parry.age<10&&cfg.parryArt)return {sprite:cfg.parryArt,face:e.face,walking:false};
  if(d.waveReady-d.age>d.waveCooldown-9&&cfg.waveArt)return {sprite:cfg.waveArt,face:e.face,walking:false};
  if(d.dash&&cfg.dashArt)return {sprite:cfg.dashArt,face:d.dash.dir<0?'left':'right',walking:false};
  if(e.grounded===false){
    const air=(e.vy??0)<-0.5?cfg.jumpArt:cfg.fallArt;
    if(air)return {sprite:air,face:e.face,walking:false};
  }
  if(e.walking&&cfg.runArt?.length)return {sprite:cfg.runArt[Math.floor(tick/4)%cfg.runArt.length],face:e.face,walking:false};
  if(cfg.idleArt)return {sprite:cfg.idleArt,face:e.face,walking:false};
  return null;
}

export const drawing={
  groundKinds:['wall','zone','mode'],
  animationTick:({local})=>local?.age,
  feet:({local:d,project,room:r})=>d?.fighter?0:r.playerFeetOffset??(d?project.player?.radius??6:4),
  drawSprite({local,ctx,art,assets,sprite,tick,entity:e,feet}){
    return local&&assets[sprite]?.scale!==undefined&&drawAnim(ctx,art,assets,sprite,tick,e.face==='left'?-1:1,e.x,e.y+feet,true);
  },
  drawTrail({ctx,local:d,assets,art,room:r,drawPlayer}){
    if(d)for(const [i,ghost] of d.trail.entries()){
      ctx.save();ctx.globalAlpha=.69*(1-(d.age-ghost.age)/10)*(i+1)/d.trail.length;
      if(!d.fighter||!drawAnim(ctx,art,assets,fighterAnim({...d,state:'dodge'}),ghost.frame,ghost.face==='left'?-1:1,ghost.x,ghost.y))
        drawPlayer(ghost,r.dungeonConfig?.dashArt??ghost.sprite,'#62f4ff');
      ctx.restore();
    }
  },
  drawPlayer({ctx,entity:e,local:d,room:r,art,assets,drawPlayer}){
    if(!d)return false;
    const tick=d.age;
    if(e.lead&&d.fighter){
      ctx.save();
      if(d.age<d.invulnerableUntil&&d.age%4<2&&!d.dash)ctx.globalAlpha=.55;
      if(!drawAnim(ctx,art,assets,fighterAnim(d),d.age-d.stateAt,e.face==='left'?-1:1,e.x,e.y,['idle','walk','run','fall'].includes(d.state)))
        drawPlayer(e);
      ctx.restore();return true;
    }
    const dp=e.lead?dungeonPose(e,d,r.dungeonConfig,tick):null;
    const swing=e.lead?d.swing:null;
    if(e.lead&&d.age<d.hurtUntil&&tick%2===0)ctx.globalAlpha=.62;
    if(dp)drawPlayer({...e,face:dp.face,walking:dp.walking},dp.sprite);
    else drawPlayer(swing?{...e,face:swing.dir<0?'left':'right',walking:e.walking}:e,e.sprite);
    ctx.globalAlpha=1;
    return true;
  },
  drawEffects({ctx,local:d,state:s,room:r,art,viewport,cam,assets}){
    if(d)drawDungeonFx(ctx,d,s.player,r,art,viewport,cam,assets);
  },
  drawForeground({ctx,local:d,state:s,room:r,art,viewport,cam}){
    if(d)drawDungeonOverlay(ctx,d,s.player,r,art,viewport,cam);
  },
  drawHud({ctx,local:d,room:r,art,viewport:v}){if(d)drawDungeonHud(ctx,d,v.w,v.h,art.ui,r.dungeonConfig?.hud);}
};
