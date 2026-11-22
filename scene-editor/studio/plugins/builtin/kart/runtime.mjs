import {createKart,stepKart} from './simulation.mjs';
import {drawKart,drawKartHud} from './view.mjs';
import {KART_POSES} from '../../../format-compat.mjs';
import {validation} from './validation.mjs';

export default {
  validation,validateRoom:ctx=>ctx.schema.room(ctx),
  roomAssets({room,needs}){
    const k=room.kartConfig;
    if(!k)return;
    const sources=[k.lancerIcon,k.lancerDrop,k.lancerSprite,k.bananaSprite,...Object.values(k.itemIcons??{}),k.skySprite,
      k.horizonSprite,k.horizonFarSprite,k.sunSprite,k.bulbSprite,k.bulbRevealSprite,k.itemBoxSprite,k.impactSprite,
      ...Object.values(k.roadSprites??{}),...KART_POSES.map(p=>k.playerSprites?.[p]),...Object.values(k.rivalSprites??{}),
      ...(k.opponents??[]).map(o=>o.sprite),...(k.scenery??[]).map(o=>o.src)];
    for(const src of sources)if(src)needs.add(src);
  },
  modes:{kart:{label:'伪 3D 赛车',toolKey:true,scriptField:'kartScript',
    help:'← → 转向 · ↑ 油门 · ↓ 刹车 · Shift/V 漂移 · Z/C 道具',
    debug:({local:k})=>({raceProgress:k.raceProgress,sunScale:k.sunScale,position:k.position,speedKmh:k.speed,finished:k.finished,
        lane:k.lane,boostTicks:k.boost,boostCount:k.boostCount,driftTicks:k.drift,item:k.item,pickups:k.pickups,
        roulette:!!k.roulette,lancerPhase:k.lancer?.phase??null,lancerHits:k.lancerHits,lastTarget:k.lastTarget}),
    enter:({room})=>createKart(room),
    step:({local,input,shake,run,room})=>stepKart(local,input,{shake,finish:()=>run(room.kartConfig?.onFinish)}),
    drawWorld:({ctx,local,art,viewport:v,room})=>drawKart(ctx,local,art,v.w,v.h,room),
    drawHud:({ctx,local,art,viewport:v})=>drawKartHud(ctx,local,art,v.w,v.h)
  }}
};
