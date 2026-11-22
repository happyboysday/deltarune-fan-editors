import {drawAnim} from './data.mjs';
import {SLASHES,SOUL_ENTER,SOUL_EXIT,SPARE_TICKS} from './simulation.mjs';
import {actorArt,tile,artAt} from '../../../ui-draw.mjs';

const clamp=(n,a,b)=>Math.max(a,Math.min(n,b));
const INK='#211834';
const aqua='#9cfff5';
const pink='#ff8ac9';
const white='#fffcef';
const heart=[
  '.##...##.',
  '####.####',
  '#########',
  '.#######.',
  '..#####..',
  '...###...',
  '....#....'
];
function label(ctx,text,x,y,size,color=white){
  ctx.font='bold '+Math.round(size)+'px "Consolas","Courier New",monospace';
  ctx.textBaseline='middle';ctx.textAlign='left';
  ctx.fillStyle=INK;ctx.fillText(text,Math.round(x)+1,Math.round(y)+1);
  ctx.fillStyle=color;ctx.fillText(text,Math.round(x),Math.round(y));
}

function exclaim(ctx,x,y,color='#ffe866'){
  tile(ctx,INK,x-2,y-1,6,13);
  tile(ctx,color,x-1,y,4,7);
  tile(ctx,color,x-1,y+9,4,3);
}

export function drawActionEnemy(ctx,e,d,tick,art,assets){
  if(e.draw===false)return;
  const o=d?.enemies.get(e.id)??{...e,hp:e.hp??6,maxHp:e.hp??6};
  if(o.hp<=0&&!o.deathEnd)return;
  if(o.spared!=null&&d){
    // Spared: the enemy turns golden, rises and fades; a yellow SPARE tag floats with it.
    const k=Math.min(1,(d.age-o.spared)/SPARE_TICKS),lift=Math.round(k*26);
    ctx.save();ctx.globalAlpha=1-k*k;ctx.translate(0,-lift);
    drawEnemyBody(ctx,e,o,d,tick,art,assets);
    ctx.globalAlpha=.35*(1-k);tile(ctx,'#ffe866',o.x,o.y,o.w,o.h);
    ctx.restore();
    const tagY=Math.round(o.y-14-lift),tagX=Math.round(o.x+o.w/2);
    if(art.ui?.drawText){
      const opts={font:'fnt_main',lang:'zh',scale:2,baseline:'middle',align:'center'};
      art.ui.drawText(ctx,'SPARE',tagX+1,tagY+1,{...opts,color:INK});
      art.ui.drawText(ctx,'SPARE',tagX,tagY,{...opts,color:'#ffe866'});
    }else label(ctx,'SPARE',tagX-14,tagY,10,'#ffe866');
    for(let i=0;i<4;i++){
      const a=tick*.22+i*1.57,r=10+k*14;
      tile(ctx,'#fff7c2',o.x+o.w/2+Math.cos(a)*r,o.y+o.h/2-lift+Math.sin(a)*r*.6,2,2);
    }
    return;
  }
  drawEnemyBody(ctx,e,o,d,tick,art,assets);
  if(o.hp<=0)return;
  // Telegraphs: a yellow "!" during a melee wind-up and just before a shot.
  const wind=e.melee?.windup??12;
  const aiming=e.shoot&&o.shot>d?.age&&o.shot-d.age<=9;
  if(o.melee&&o.melee.age<wind||aiming)exclaim(ctx,o.x+o.w/2,o.y-24);
}

function drawEnemyBody(ctx,e,o,d,tick,art,assets){
  const cx=o.x+o.w/2,feet=o.y+o.h,cy=o.y+o.h/2,hit=o.flash>d?.age;
  const stunned=o.stun>d?.age;
  const pose=o.state??'idle',anim=e.anims?.[pose]??e.anims?.idle??(e.enemyType?e.sprite:undefined);
  if(!drawAnim(ctx,art,assets,anim,tick-(o.since??0),o.dir??1,cx,feet,pose==='move'||pose==='idle')&&!actorArt(ctx,art,assets,e.sprite,o.dir<0?'left':'right',!stunned,tick,cx,feet,hit?'#ffffff':null)){
    const c=hit?white:e.color??'#996cf3',base=hit?'#ebffff':'#523f9e';
    const w=o.w,h=o.h,bob=stunned?0:Math.floor(tick/5)%2;
    tile(ctx,'#24183c70',cx-w*.52,feet-1,w*1.04,3);
    tile(ctx,INK,cx-w*.51,o.y+h*.24+bob,w*1.02,h*.65);
    tile(ctx,INK,cx-w*.35,o.y+bob,w*.70,h*.95);
    tile(ctx,base,cx-w*.43,o.y+h*.30+bob,w*.86,h*.47);
    tile(ctx,c,cx-w*.29,o.y+h*.15+bob,w*.58,h*.57);
    tile(ctx,c,cx-w*.45,o.y+h*.06+bob,w*.22,h*.30);
    tile(ctx,c,cx+w*.23,o.y+h*.06+bob,w*.22,h*.30);
    tile(ctx,'#302257',cx-w*.24,cy-h*.14+bob,w*.48,h*.23);
    tile(ctx,'#ffed9d',cx-w*.18,cy-h*.11+bob,Math.max(2,w*.14),Math.max(1,h*.13));
    tile(ctx,'#ffed9d',cx+w*.043,cy-h*.11+bob,Math.max(2,w*.14),Math.max(1,h*.13));
    tile(ctx,INK,cx-w*.31,feet-3,w*.21,4);tile(ctx,INK,cx+w*.10,feet-3,w*.21,4);
  }
  if(o.hp<=0||o.spared!=null)return;
  if(stunned){
    for(let i=0;i<3;i++){
      const angle=tick*.31+i*2.1;
      tile(ctx,white,cx+Math.cos(angle)*9,o.y-7+Math.sin(angle)*2,2,2);
    }
  }
  if(e.bar===false)return;  // props such as the sun mirror have no health bar
  const bar=Math.max(12,o.w);
  tile(ctx,INK,cx-bar/2-1,o.y-6,bar+2,4);
  tile(ctx,hit?white:'#ef72b4',cx-bar/2,o.y-5,Math.ceil(bar*o.hp/o.maxHp),2);
}

function arc(ctx,x,y,dir,rx,ry,from,to,color,edge,size=1){
  for(let i=0,n=Math.ceil(Math.abs(to-from)*Math.max(rx,ry)*1.22);i<=n;i++){
    const pct=i/Math.max(1,n),angle=from+(to-from)*pct,c=Math.cos(angle),s=Math.sin(angle);
    const taper=Math.round(Math.sin(pct*Math.PI)*size);
    tile(ctx,edge,x+dir*(rx+2)*c,y+(ry+2)*s,2,2);
    for(let t=0;t<=taper;t++){
      const px=x+dir*(rx-t)*c,py=y+(ry-t)*s;
      tile(ctx,t>0?color:white,px-1,py-1,2,2);
    }
  }
}

function slash(ctx,p,swing,room,art){
  const {stage,age,dir}=swing,index=stage-1;
  const spec=SLASHES[index],scale=clamp(age/3,.34,1),opacity=clamp((spec.life-age)/4,.18,1);
  const x=p.x+dir*6,y=p.y-5;
  const image=art.images.get(room.dungeonConfig?.slashSprites?.[index]);
  ctx.save();ctx.globalAlpha=opacity;
  if(image?.naturalWidth){
    ctx.translate(Math.round(x),Math.round(y));ctx.scale(dir,1);
    artAt(image,ctx,-image.naturalWidth*.35,-image.naturalHeight*.5);
  }else{
    const [start,end]=[[-.91,1.05],[-1.56,.65],[-1.4,1.43]][index];
    const turn=(stage===2?-1:1)*(1-scale)*.8,r=(spec.reach-5)*scale;
    arc(ctx,x,y,dir,r,(spec.height+stage)*scale,start+turn,end+turn,stage===2?pink:aqua,
      stage===3?'#f37cce':stage===2?'#a751c0':'#309ec9',stage===3?6:4);
    const sweep=clamp(age/(spec.life*.72),0,1);
    const a=start+(end-start)*(stage===2?1-sweep:sweep);
    for(let i=0;i<9;i++)tile(ctx,i<5?white:aqua,x+dir*Math.cos(a)*i*2,y+Math.sin(a)*i*2,2,2);
    tile(ctx,'#fce795',x-1,y+3,4,3);
  }
  ctx.restore();
}

function drawHeart(ctx,x,y,scale,c){
  for(let j=0;j<heart.length;j++)for(let i=0;i<heart[j].length;i++)if(heart[j][i]==='#')
    tile(ctx,c,x+(i-4.5)*scale,y+(j-3.5)*scale,scale,scale);
}

export function drawDungeonFx(ctx,d,p,room,art,view,cam,assets={}){
  if(!d)return;
  for(const b of d.bullets){
    if(b.x<cam.x-12||b.x>cam.x+view.w+12||b.y<cam.y-12||b.y>cam.y+view.h+12)continue;
    if(drawAnim(ctx,art,assets,b.sprite,d.age-b.born,b.vx<0?-1:1,b.x,b.y,true))continue;
    tile(ctx,b.color+'55',b.x-5,b.y-3,10,6);
    tile(ctx,b.color+'88',b.x-3,b.y-5,6,10);
    tile(ctx,b.color,b.x-3,b.y-3,6,6);
    tile(ctx,white,b.x-1,b.y-1,3,3);
    tile(ctx,b.color,b.x-b.vx*1.55,b.y-b.vy*1.55,2,2);
  }
  for(const w of d.waves){
    if(drawAnim(ctx,art,assets,w.sprite,d.age-w.born,w.dir,w.x,w.y,true))continue;
    const image=art.images.get(room.dungeonConfig?.waveSprite);
    if(image?.naturalWidth){
      ctx.save();ctx.translate(Math.round(w.x),Math.round(w.y));ctx.scale(w.dir,1);
      artAt(image,ctx,-image.naturalWidth/2,-image.naturalHeight/2);ctx.restore();
    }else arc(ctx,w.x-5*w.dir,w.y,w.dir,14,16,-1.38,1.38,aqua,'#4ecff3',5);
    for(let i=0;i<7;i++)tile(ctx,i%2?aqua:white,w.x-w.dir*(6+i*3),w.y+(i*7+d.age*3)%25-12,Math.max(1,4-i),2);
  }
  for(const a of d.areas){
    if(!drawAnim(ctx,art,assets,a.sprite,d.age-a.born,a.dir,a.x+a.w/2,a.y+a.h))
      tile(ctx,'#89fff147',a.x,a.y,a.w,a.h);
  }
  if(d.healFx)drawAnim(ctx,art,assets,d.healFx.sprite,d.age-d.healFx.born,d.healFx.dir,p.x,p.y);
  if(d.dash?.sprite)drawAnim(ctx,art,assets,d.dash.sprite,d.age-d.dash.born,d.dash.dir,p.x,p.y);
  if(d.swing?.attack)drawAnim(ctx,art,assets,d.swing.attack.effect,d.swing.age,d.swing.dir,p.x,p.y);
  else if(d.swing)slash(ctx,p,d.swing,room,art);
  if(d.parry){
    const {age,x,y}=d.parry,reach=11+age*2.9;
    ctx.save();ctx.globalAlpha=Math.max(.1,(13-age)/13);
    const image=art.images.get(room.dungeonConfig?.parrySprite);
    const drawn=drawAnim(ctx,art,assets,d.parry.sprite,age,d.parry.dir,x,y);
    if(!drawn&&image?.naturalWidth)artAt(image,ctx,x-reach,y-reach,Math.round(reach*2),Math.round(reach*2));
    else if(!drawn){
      for(let i=0;i<40;i++){
        const a=i*Math.PI/20;
        tile(ctx,i%4?'#ff527d':white,x+Math.sin(a)*reach,y+Math.cos(a)*reach*.84,i%4?2:4,i%4?2:4);
      }
      drawHeart(ctx,x,y,2,'#ff4b70');
      tile(ctx,white,x-6,y-3,3,3);
    }
    ctx.restore();
  }
  for(const f of d.particles){
    ctx.globalAlpha=Math.min(1,f.life/(f.max*.52));
    tile(ctx,f.color,f.x,f.y,Math.min(f.size,f.life),Math.min(f.size,f.life));
  }
  ctx.globalAlpha=1;
  if(d.hitstop>=3){
    ctx.save();
    ctx.globalAlpha=d.hitstop>=6?.22:.12;
    tile(ctx,'#fffce8',cam.x,cam.y,view.w,view.h);
    ctx.restore();
  }
  if(d.pop)label(ctx,d.pop.text,d.pop.x-18,d.pop.y-(17-(d.pop.until-d.age))*.28,10,aqua);
  if(d.actPop){
    // "* 遮光" style ACT caption over Kris in the game font (falls back to the monospace label).
    const rise=Math.min(10,(40-(d.actPop.until-d.age))*.5),text='* '+d.actPop.text;
    const x=Math.round(d.actPop.x),y=Math.round(d.actPop.y-rise);
    if(art.ui?.drawText){
      const opts={font:'fnt_main',lang:'zh',scale:2,baseline:'middle',align:'center'};
      art.ui.drawText(ctx,text,x+2,y+2,{...opts,color:INK});
      art.ui.drawText(ctx,text,x,y,{...opts,color:'#ffffff'});
    }else label(ctx,text,x-20,y,10,white);
  }
}

// Drawn after the foreground layers: SOUL mode dims the whole room and shows the bullet box above it.
export function drawDungeonOverlay(ctx,d,p,room,art,view,cam){
  const s=d?.soul;
  if(!s)return;
  const t=d.age-s.at,end=SOUL_ENTER+s.ticks;
  const k=t<SOUL_ENTER?t/SOUL_ENTER:t>=end?Math.max(0,1-(t-end)/SOUL_EXIT):1;
  ctx.save();
  ctx.globalAlpha=.72*k;tile(ctx,'#000000',cam.x,cam.y,view.w,view.h);
  ctx.globalAlpha=1;
  const bw=Math.round(s.w*k/2)*2,bh=Math.round(s.h*k/2)*2;
  if(bw>8&&bh>8){
    const x0=Math.round(s.cx-bw/2),y0=Math.round(s.cy-bh/2);
    tile(ctx,'#000000',x0,y0,bw,bh);
    tile(ctx,'#ffffff',x0-3,y0-3,bw+6,3);tile(ctx,'#ffffff',x0-3,y0+bh,bw+6,3);
    tile(ctx,'#ffffff',x0-3,y0,3,bh);tile(ctx,'#ffffff',x0+bw,y0,3,bh);
    for(const b of s.shots){
      if(b.ray){
        tile(ctx,'#ff9f2e',b.x-9,b.y-2,18,4);tile(ctx,'#fff3c4',b.x-5,b.y-1,10,2);
      }else{
        tile(ctx,'#ffd24a',b.x-4,b.y-4,8,8);tile(ctx,'#ffd24a',b.x-1,b.y-7,2,14);tile(ctx,'#ffd24a',b.x-7,b.y-1,14,2);
        tile(ctx,'#ffffff',b.x-2,b.y-2,4,4);
      }
    }
  }
  const blink=d.age<d.invulnerableUntil&&d.age%4<2;
  if(!blink)drawHeart(ctx,Math.round(s.heart.x),Math.round(s.heart.y),2,'#ff1a1a');
  if(s.pop)label(ctx,s.pop.text,s.pop.x,s.pop.y-(14-(s.pop.until-d.age))*.4,10,aqua);
  ctx.restore();
}

const krisHead=[
  '....########....',
  '..############..',
  '.##############.',
  '.###..#####..##.',
  '###....####..###',
  '##......##....##',
  '###.##########.#',
  '###.#########...',
  '.##..#######....',
  '..#..##...##....',
  '.....#######....',
];

function drawKrisIcon(ctx,x,y,scale){
  for(let j=0;j<krisHead.length;j++){
    for(let i=0;i<krisHead[j].length;i++){
      if(krisHead[j][i]==='#')tile(ctx,'#00e8ff',x+i*scale,y+j*scale,scale,scale);
    }
  }
}

function drBox(ctx,x,y,w,h,outer='#ffffff',inner='#4d3866',u=1){
  tile(ctx,outer,x,y,w,h);
  tile(ctx,inner,x+u,y+u,w-2*u,h-2*u);
  tile(ctx,'#000000',x+2*u,y+2*u,w-4*u,h-4*u);
}

export function drawDungeonHud(ctx,d,w,h,kit,position){
  if(position===false)return;
  function text(value,x,y,size,color,maxWidth){
    if(!kit){label(ctx,value,x,y,size,color);return;}
    // Bitmap fonts stay at their integer scale; text that does not fit is clipped instead of squeezed.
    const opts={font:'fnt_main',lang:'zh',scale:Math.max(1,Math.round(size/12)),baseline:'middle',color};
    ctx.save();
    if(maxWidth){ctx.beginPath();ctx.rect(x,y-size,maxWidth,size*2);ctx.clip();}
    kit.drawText(ctx,value,x,y,opts);
    ctx.restore();
  }
  const x=4,boxH=32,y=position==='bottom'?h-boxH-4:4;
  const statusW=Math.min(182,Math.floor(w*.46));
  drBox(ctx,x,y,statusW,boxH);
  if(!(kit&&kit.drawSprite(ctx,'spr_headkris',x+5,y+4,{scale:1}))){
    drawKrisIcon(ctx,x+8,y+10,1);
  }
  const name=d.fighter?.name??'KRIS',hpText='HP '+d.hp+'/'+d.maxHp;
  const barX=x+42,barW=statusW-48;
  text(name,barX,y+11,12,'#ffffff',40);
  text(hpText,barX+44,y+11,12,'#ffffff',barW-44);
  tile(ctx,'#800000',barX,y+21,barW,5);
  tile(ctx,'#00e8ff',barX,y+21,Math.round(barW*clamp(d.hp/d.maxHp,0,1)),5);
  if(d.combo>1){
    const cy=position==='bottom'?y-11:y+boxH+11;
    text(d.combo+' HIT!',x+4,cy,12,'#ffe866');
  }
  const u=Math.max(1,Math.floor(h/240));
  if(!d.hp){
    drBox(ctx,w/2-38*u,h*.42-12*u,76*u,24*u,'#ffffff','#801838',u);
    text('DOWN',w/2-18*u,h*.42,14*u,'#ff3858');
  }
}
