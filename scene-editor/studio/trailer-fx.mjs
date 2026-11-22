import {HZ} from './format.mjs';
import {tile} from './ui-draw.mjs';

const clamp01=n=>Math.max(0,Math.min(1,n));
const ticks=seconds=>Math.round(seconds*HZ);
const progress=(fx,tick)=>fx.ticks?clamp01((tick-fx.start)/fx.ticks):1;
const mix=(a,b,f)=>a+(b-a)*f;

function fadeAt(fx,tick){
  if(!fx)return {alpha:0,shade:0};
  const f=progress(fx,tick);
  return {alpha:mix(fx.from.alpha,fx.to.alpha,f),shade:mix(fx.from.shade,fx.to.shade,f)};
}

export function cueDirector(fx,a,tick){
  switch(a.op){
    case 'flash':
      fx.flash={start:tick,ticks:Math.max(1,ticks(a.duration??.6)),hold:ticks(a.hold??.15),color:a.color??'#ffffff'};
      break;
    case 'shake':
      fx.shake={start:tick,ticks:Math.max(1,ticks(a.duration??.35)),intensity:a.intensity??8};
      break;
    case 'titlecard':
      fx.title={start:tick,ticks:Math.max(1,ticks(a.duration??2)),fadeIn:ticks(a.fadeIn??.2),fadeOut:ticks(a.fadeOut??.3),
        title:a.title,subtitle:a.subtitle,bg:a.bg??'#000000'};
      break;
    case 'fade':{
      const from=fadeAt(fx.fade,tick);
      fx.fade={start:tick,ticks:ticks(a.duration??.45),from,
        to:{alpha:Number(a.to!=='clear'),shade:a.to==='clear'?from.shade:Number(a.to==='white')}};
      break;
    }
  }
}

export function stepDirector(fx,tick){
  if(fx.fade?.to.alpha===0&&progress(fx.fade,tick)>=1)delete fx.fade;
  for(const key of ['flash','shake','title']){
    const effect=fx[key];
    if(effect&&tick-effect.start>=effect.ticks)delete fx[key];
  }
}

export function shakeOffset(fx,tick){
  const effect=fx?.shake;
  if(!effect)return [0,0];
  const age=tick-effect.start, strength=effect.intensity*(1-progress(effect,tick));
  return [Math.round(Math.sin(age*2.41+.8)*strength),Math.round(Math.cos(age*2.95+.2)*strength*.62)];
}

export function drawDirector(ctx,fx,tick,w,h){
  if(!fx)return;
  const fade=fadeAt(fx.fade,tick);
  ctx.save();
  if(fade.alpha>0){
    const shade=Math.round(fade.shade*255);
    ctx.globalAlpha=fade.alpha;
    tile(ctx,'rgb('+shade+','+shade+','+shade+')',0,0,w,h);
  }
  const flash=fx.flash;
  if(flash){
    const hold=Math.min(flash.ticks,flash.hold);
    ctx.globalAlpha=1-clamp01((tick-flash.start-hold)/Math.max(1,flash.ticks-hold));
    tile(ctx,flash.color,0,0,w,h);
  }
  const card=fx.title;
  if(card){
    const age=tick-card.start;
    ctx.globalAlpha=Math.min(1,card.fadeIn?age/card.fadeIn:1,card.fadeOut?(card.ticks-age)/card.fadeOut:1);
    if(card.bg!=='transparent')tile(ctx,card.bg,0,0,w,h);
    ctx.textAlign='center';ctx.textBaseline='middle';
    const size=Math.max(13,Math.round(Math.min(w*.095,h*.115)));
    const text=(line,y,px,color)=>{
      ctx.font='bold '+px+'px "Consolas","Microsoft JhengHei","Microsoft YaHei UI",monospace';
      ctx.fillStyle='#100d1c';ctx.fillText(line,Math.round(w/2)+1,Math.round(y)+2,w-16);
      ctx.fillStyle=color;ctx.fillText(line,Math.round(w/2),Math.round(y),w-16);
    };
    text(card.title,h/2-(card.subtitle?size*.55:0),size,'#ffffff');
    if(card.subtitle)text(card.subtitle,h/2+size*.62,Math.max(9,Math.round(size*.47)),'#ffe9ae');
  }
  ctx.restore();
}
