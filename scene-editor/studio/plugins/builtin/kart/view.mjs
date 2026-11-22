import {kartCamera,projectKart,clampKart,kartSectionAt} from './simulation.mjs';
import {tile} from '../../../ui-draw.mjs';

const clamp=clampKart;
const mix=(a,b,t)=>a+(b-a)*t;
const wrap=(n,period)=>((n%period)+period)%period;
const INK='#18203a';
const paper='#fffae5';
const warm='#ffe17c';
const aqua='#85fff4';
const tire='#1d1932';
const font=' "Consolas","Courier New",monospace';

const kris=[
  '.......11111111.......',
  '.....112222222211.....',
  '....12233333333221....',
  '...1223334444333221...',
  '...1233444444433221...',
  '...1223444444433221...',
  '....12244444442221....',
  '.....155555555551.....',
  '....15566656665551....',
  '...1777666666777751...',
  '..177877777778777551..',
  '..1788888888888776651.',
  '...17788888888771651.',
  '....118888888811..1..'
];
const driverPalette=['',INK,'#143f62','#347da4','#6fcbe1','#a73172','#ff9bcc','#3268af','#a0e3ec'];
const lancer=[
  '.........11.........',
  '........1221........',
  '.......122221.......',
  '......12233221......',
  '....112233332211....',
  '...12223333332221...',
  '..1222333333332221..',
  '.12223311113333221.',
  '.12333444444433321.',
  '.12333414114433321.',
  '..123344444433321..',
  '...1223333333221...',
  '.....11111111......',
  '......155551.......',
  '.....15566551......',
  '....1555555551.....',
  '....1111111111.....'
];
const lancerPalette=['',INK,'#3a60ce','#69a8f4','#f6fdff','#283979','#faf5c0'];

function label(ctx,text,x,y,size,color=paper,align='left'){
  ctx.font='bold '+Math.round(size)+'px'+font;
  ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillStyle=INK;
  ctx.fillText(text,Math.round(x)+1,Math.round(y)+2);
  ctx.fillStyle=color;ctx.fillText(text,Math.round(x),Math.round(y));
}

function pixels(ctx,rows,palette,cx,base,height,slant=0){
  const scale=height/rows.length;
  for(let y=0;y<rows.length;y++){
    const row=rows[y],left=cx-row.length*scale/2+slant*(1-y/rows.length);
    const top=Math.round(base-height+y*scale),bottom=Math.round(base-height+(y+1)*scale);
    if(bottom===top)continue;
    for(let i=0;i<row.length;){
      const key=row[i];
      let end=i+1;
      while(row[end]===key)end++;
      const x=Math.round(left+i*scale),w=Math.round(left+end*scale)-x;
      if(key!=='.'&&w)tile(ctx,palette[Number(key)],x,top,w,bottom-top);
      i=end;
    }
  }
}

function spriteAt(ctx,art,src,x,y,h){
  const img=art.images.get(src);
  if(!img?.naturalWidth)return false;
  const w=Math.max(1,Math.round(h*img.naturalWidth/img.naturalHeight)),height=Math.max(1,Math.round(h));
  ctx.drawImage(img,Math.round(x-w/2),Math.round(y-height),w,height);
  return true;
}

function shadow(ctx,x,y,w,h,color='#28352b66'){
  tile(ctx,color,x-w*.35,y-h/2,w*.70,h);
  tile(ctx,color,x-w*.5,y-h/4,w*.15,h*.5);
  tile(ctx,color,x+w*.35,y-h/4,w*.15,h*.5);
}

function drawCar(ctx,art,{x,y,height,turn=0,player=false,color,sprite,spin=0,hop=0,boost=false,groundShadow=true}){
  const hasSprite=Boolean(art.images.get(sprite)?.naturalWidth);
  const w=height*(player?1.29:1.20)*(1-Math.min(.32,Math.abs(spin)*.24));
  if(groundShadow){
    if(hasSprite){
      // Fit shadow tightly underneath the actual kart tires (sprites have ~7% bottom transparent margin)
      const sw=height*(player?.70:.76)*(1-Math.min(.28,Math.abs(spin)*.22));
      shadow(ctx,x,y-height*.055,sw,Math.max(2,height*.09));
    }else{
      shadow(ctx,x,y+1,w*1.07,Math.max(2,height*.13));
    }
  }
  y-=hop;
  if(hasSprite&&spriteAt(ctx,art,sprite,x,y,height))return;
  const pixel=Math.max(1,Math.round(height/27)),body=player?'#eb4464':color,ux=x+w*.085*turn;
  if(height<11){
    tile(ctx,INK,x-w*.46,y-height*.55,w*.92,height*.54);
    tile(ctx,body,x-w*.40,y-height*.64,w*.80,height*.44);
    tile(ctx,paper,x-w*.15,y-height*.88,w*.3,height*.32);
    return;
  }
  const box=(c,l,t,b,h)=>tile(ctx,c,x+w*l,y+height*t,w*b,height*h);
  box(tire,-.49,-.36,.25,.35);box(tire,.24,-.36,.25,.35);
  box('#4a3f59',-.47,-.28,.10,.20);box('#4a3f59',.37,-.28,.10,.20);
  box(INK,-.48,-.48,.96,.32);
  box(player?'#3158a7':'#3c315a',-.41,-.48,.82,.34);
  box('#6687c1',-.42,-.42,.84,.055);
  if(player)pixels(ctx,kris,driverPalette,ux,y-height*.365,height*.62,w*.13*turn);
  else{
    tile(ctx,INK,ux-w*.20,y-height*.91,w*.4,height*.55);
    tile(ctx,color,ux-w*.16,y-height*.88,w*.32,height*.45);
    tile(ctx,paper,ux-w*.139,y-height*.80,w*.14,height*.09);
    tile(ctx,'#453363',ux-w*.16,y-height*.58,w*.32,height*.11);
  }
  box(INK,-.50,-.36,1,.19);
  box(body,-.46,-.35,.92,.14);
  box(player?'#ff8c81':paper,-.38,-.35,.76,.035);
  box(INK,-.42,-.18,.84,.14);
  box('#546ca2',-.38,-.16,.76,.075);
  box(boost?'#f9fffd':'#ffab79',-.37,-.28,.13,.081);
  box(boost?'#f9fffd':'#ffab79',.24,-.28,.13,.081);
  box('#222c52',-.15,-.22,.30,.12);
  box('#eee5d2',-.105,-.195,.21,.07);
  if(boost){
    tile(ctx,'#5ef6ff',x-w*.23,y-pixel*3,pixel*2,pixel*4);
    tile(ctx,'#fafff4',x+w*.18,y-pixel*3,pixel*2,pixel*4);
  }
}

function bandedDisc(ctx,cx,cy,r,color,pixel){
  for(let y=-r;y<r;y+=pixel){
    const x=Math.floor(Math.sqrt(Math.max(0,r*r-y*y))/pixel)*pixel;
    if(x)tile(ctx,color,cx-x,cy+y,x*2,Math.min(pixel,r-y));
  }
}

function sun(ctx,k,art,c,horizon){
  const p=k.raceProgress;
  // Unified single-anchor trajectory so the Sun disc & SOLUX 1000W bulb glass sphere
  // share the EXACT same center (x, cy) and diameter — ZERO layer jump or double image!
  const x=Math.round(c.w*.52-c.at.heading*26-c.lane*4);
  const smooth=t=>t*t*(3-2*t);
  const surge=smooth(clamp((p-.55)/.38,0,1));
  // Keep disc comfortably above horizon so the emerging brass screw base clears the hills cleanly!
  const cy=Math.round(horizon-c.h*(.185+surge*.085));
  const discDiam=Math.round(c.h*(.125+p*.055+surge*.082));
  const radius=Math.max(8,Math.round(discDiam*.5));

  // Transition curve:
  //  p < 0.62: pure Deltarune graphic Sun
  //  0.62..0.78: blinding solar corona blooms over the disc as Kris enters worshipper avenue
  //  0.76..0.88: glare peaks & clears during hard brake, clarifying into 1000W SOLUX bulb + descending screw base!
  const morph=smooth(clamp((p-.73)/.11,0,1));
  const neckReveal=smooth(clamp((p-.76)/.12,0,1));
  const glareUp=smooth(clamp((p-.60)/.17,0,1));
  const glareDown=1-smooth(clamp((p-.78)/.12,0,1));
  const peakGlare=glareUp*glareDown; // smooth bell peaking right at p=0.77..0.78!

  // 1. Warm atmospheric solar bloom behind the sun/bulb
  const bloomR=radius*(2.1+glareUp*.85+peakGlare*.9);
  const gradient=ctx.createRadialGradient(x,cy,radius*.25,x,cy,bloomR);
  gradient.addColorStop(0,`rgba(255,254,224,${(.78+peakGlare*.20).toFixed(3)})`);
  gradient.addColorStop(.48,`rgba(255,232,140,${(.42+peakGlare*.30).toFixed(3)})`);
  gradient.addColorStop(1,'rgba(255,232,153,0)');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,c.w,c.h);

  // Subtle rotating solar corona spikes during glare surge (p=0.60..0.90)
  if(glareUp>0.02&&(1-morph*.65)>0.05){
    ctx.save();
    ctx.globalAlpha=clamp(glareUp*(1-morph*.62)*.48,0,.55);
    ctx.fillStyle='#fff9cc';
    for(let i=0;i<10;i++){
      const ang=i*Math.PI/5+k.age*.018;
      const r0=radius*.75,r1=radius*(1.65+peakGlare*.75);
      ctx.beginPath();
      ctx.moveTo(x+Math.cos(ang-.09)*r0,cy+Math.sin(ang-.09)*r0);
      ctx.lineTo(x+Math.cos(ang)*r1,cy+Math.sin(ang)*r1);
      ctx.lineTo(x+Math.cos(ang+.09)*r0,cy+Math.sin(ang+.09)*r0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  const normalSun=art.images.get(k.cfg.sunSprite);
  const fullBulb=art.images.get(k.cfg.bulbRevealSprite);

  // Pixel-exact alignment:
  //  kart_sun_normal (192x192): disc diameter = 0.583*H, center at y = 0.497*H (bottom = cy + 0.503*H)
  //  kart_solux_bulb_reveal (112x128): glass diameter = 0.570*H, center at y = 0.453*H (bottom = cy + 0.547*H)
  if(normalSun?.naturalWidth){
    const sunH=discDiam/.583;
    const sunAlpha=1-morph;
    if(sunAlpha>0.01){
      ctx.save();
      ctx.globalAlpha=sunAlpha;
      spriteAt(ctx,art,k.cfg.sunSprite,x,cy+sunH*.503,sunH);
      ctx.restore();
    }
    if(fullBulb?.naturalWidth&&morph>0.01){
      const bulbH=discDiam/.570;
      const bulbBottom=cy+bulbH*.547;
      // Smoothly unmask the lower brass screw base downward out of the solar glow!
      const clipBot=Math.round(cy+radius*.72+(bulbBottom-(cy+radius*.72))*neckReveal+6);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0,0,c.w,clipBot);
      ctx.clip();
      ctx.globalAlpha=morph;
      spriteAt(ctx,art,k.cfg.bulbRevealSprite,x,bulbBottom,bulbH);
      ctx.restore();
    }
    // Peak white-gold solar flare flash that bridges sun -> bulb seamlessly with ZERO visible double-exposure!
    if(peakGlare>0.02){
      const fg=ctx.createRadialGradient(x,cy,radius*.1,x,cy,radius*(1.45+peakGlare*.55));
      fg.addColorStop(0,`rgba(255,255,244,${(peakGlare*.96).toFixed(3)})`);
      fg.addColorStop(.55,`rgba(255,244,184,${(peakGlare*.74).toFixed(3)})`);
      fg.addColorStop(1,'rgba(255,240,168,0)');
      ctx.fillStyle=fg;
      ctx.fillRect(0,0,c.w,c.h);
    }
    return;
  }
  const grid=Math.max(1,Math.round(c.h/180));
  bandedDisc(ctx,x,cy,radius,'#ffae34',grid);
  bandedDisc(ctx,x,cy-grid,Math.round(radius*.88),'#ffe66e',grid);
  bandedDisc(ctx,x-grid,cy-grid*2,Math.round(radius*.72),'#fffee6',grid);
}

function panorama(ctx,img,w,base,height,offset,width){
  if(!img?.naturalWidth)return false;
  const hw=Math.max(1,width??Math.round(height*img.naturalWidth/img.naturalHeight));
  const ox=Math.round(wrap(offset,hw));
  for(let x=ox-hw;x<w;x+=hw)ctx.drawImage(img,x,base-height,hw,height);
  return true;
}

const mountainRidges=[
  {heights:[.32,.65,.49,.79,1,.68,.43,.56,.91,.72,.39,.32],
    color:'#5a89c8',light:'#85b4df',shade:'#507bb5',rise:.21,speed:1},
  {heights:[.28,.43,.86,.63,.37,.54,.72,.47,.97,.57,.39,.28],
    color:'#456ea8',light:'#6897c6',shade:'#3e659c',rise:.145,speed:1.32}
];

function mountains(ctx,c,horizon){
  const {w,h}=c,block=Math.max(2,Math.round(h/90)),period=Math.ceil(w*.93/block)*block;
  for(const {heights,color,light,shade,rise,speed} of mountainRidges){
    const offset=c.at.heading*62*speed,base=horizon+Math.round(h*.034);
    for(let x=0;x<w;x+=block){
      const u=wrap(x+offset,period)/period*(heights.length-1),i=Math.floor(u);
      const ridge=mix(heights[i],heights[i+1],u-i)*h*rise;
      const top=base-Math.round(ridge/block)*block;
      tile(ctx,color,x,top,block,base-top);
      if(heights[i+1]>heights[i])tile(ctx,light,x,top,block,Math.max(block,Math.round(ridge*.19)));
      else tile(ctx,shade,x,top+block,block,Math.max(0,Math.round(ridge*.42)-block));
    }
  }
  // Warm rooftops catch the light above the cool, distant ridge.
  const s=Math.max(1,Math.round(h/180)),base=horizon+2*s;
  for(let x=wrap(period*.63-c.at.heading*62*1.32,period)-period;x<w+16*s;x+=period){
    tile(ctx,'#5a89c8',x-10*s,base-9*s,20*s,9*s);
    tile(ctx,'#eed9a2',x-8*s,base-10*s,16*s,3*s);
    for(let i=-1;i<=1;i++){
      const cx=x+i*7*s,top=base-(i===0?22:16)*s;
      tile(ctx,'#e3cea1',cx-2*s,top,4*s,base-top);
      tile(ctx,'#af987e',cx+s,top,s,base-top);
      tile(ctx,'#ffdfa0',cx-3*s,top,6*s,s);
      tile(ctx,'#ffedba',cx-2*s,top-s,4*s,s);
      tile(ctx,'#ffedba',cx-s,top-3*s,2*s,2*s);
      tile(ctx,'#456ea8',cx,top+3*s,s,2*s);
    }
  }
}

function sky(ctx,k,art,c,tick){
  const {w,h}=c,horizon=Math.max(Math.round(h*.10),c.horizon);
  // Crisp banded Ch5-inspired daylight sky! (extend bottom band past horizon so slopes never show black seam!)
  tile(ctx,'#4d9d53',0,0,w,h);
  const bands=[
    [0,.18,'#2462ce'],[.18,.38,'#3a88eb'],[.38,.60,'#6ab6fb'],[.60,.82,'#a8e0ff'],[.82,1.12,'#f6f2c2']
  ];
  for(const [a,b,col] of bands){
    tile(ctx,col,0,Math.floor(horizon*a),w,Math.ceil(horizon*(b-a))+4);
  }
  const skyEnd=horizon+6;
  if(!panorama(ctx,art.images.get(k.cfg.skySprite),w,skyEnd,skyEnd,-c.at.heading*38,w)){
    // Graphic horizontal Ch5-style streaky daylight clouds!
    const s=Math.max(1,Math.round(h/180)),margin=80*s,area=w+margin*2;
    for(let i=0;i<6;i++){
      const x=wrap(i*area/6-tick*(.11+.03*(i%3))-c.at.heading*38-c.lane*7,area)-margin;
      const y=Math.round(8+(i*17)%Math.max(18,Math.floor(horizon*.55)));
      const cw=(44+(i%3)*18)*s;
      tile(ctx,'#fffef0',x,y,cw,3*s);
      tile(ctx,'#e6f6ff',x+8*s,y-2*s,cw-16*s,3*s);
      tile(ctx,'#b8dcf6',x+6*s,y+3*s,cw-12*s,2*s);
    }
  }
  if(!panorama(ctx,art.images.get(k.cfg.horizonFarSprite),w,horizon+6,Math.round(h*.25),-c.at.heading*62)){
    mountains(ctx,c,horizon);
  }
  const midOffset=-c.at.heading*125-c.lane*12;
  if(!panorama(ctx,art.images.get(k.cfg.horizonSprite),w,horizon+6,Math.max(1,Math.round(horizon*.56)),midOffset)){
    const block=Math.max(3,Math.round(w/95));
    for(let x=0;x<w;x+=block){
      const u=(x-midOffset)*320/w;
      const top=(Math.sin(u*.041)+Math.sin(u*.101+1)*.38+1.6)*h*.025;
      tile(ctx,'#68b88a',x,horizon-top,block,h-horizon+top);
      const hill=(Math.sin(u*.019-2)+1.23)*h*.024;
      tile(ctx,'#429468',x,horizon+3-hill,block,h-horizon+hill);
    }
  }
  // Draw unified Sun -> 1000W SOLUX Bulb AFTER horizon mountains & BEFORE warm horizon haze
  // so it never pops layers, never double-exposes, and its brass screw base sits softly in the horizon mist!
  sun(ctx,k,art,c,horizon);
  const haze=ctx.createLinearGradient(0,horizon-h*.07,0,horizon+h*.027);
  haze.addColorStop(0,'#fff2bc00');
  haze.addColorStop(.67,'#fff2bc96');
  haze.addColorStop(1,'#fff2bc00');
  ctx.fillStyle=haze;
  ctx.fillRect(0,Math.floor(horizon-h*.07),w,Math.ceil(h*.097));
}

const roadColor=['#9099aa','#858da0'];
const grassColor=['#5caf56','#4d9d53'];
const edgeColor=['#e95664','#fff6d3'];
const valleyColor=['#bfe6fa','#bfe6fa','#8ecbe8','#8ecbe8','#bfe6fa','#fff2be'];

function span(ctx,color,y,left,right){
  left=Math.round(left);right=Math.round(right);
  if(right>left)tile(ctx,color,left,y,right-left,1);
}

function canyonRow(ctx,k,c,section,at,y,center,half){
  const depth=(at-section.gapStart)/(section.gapEnd-section.gapStart);
  const strata=Math.floor(at*1.65),rough=Math.sin(at*1.8)*.06+Math.sin(at*.41)*.11;
  const mouth=half*(1.48+rough),floor=half*(.77+rough*.6);
  const notch=half*.09*Math.sin(at*.62);
  const left=center-mouth+notch,right=center+mouth+notch;
  const band=Math.min(valleyColor.length-1,Math.floor(depth*valleyColor.length));
  tile(ctx,'#6e3b3a',0,y,c.w,1);
  span(ctx,'#382032',y,left-half*.10,right+half*.10);
  span(ctx,strata%4===0?'#6e3b3a':'#8c4b41',y,left,right);
  span(ctx,strata%3===0?'#8c4b41':'#b86d4c',y,left+mouth*.16,right-mouth*.19);
  span(ctx,valleyColor[band],y,center-floor,center+floor);
  const river=center+Math.sin(at*.35)*floor*.39,water=floor*.31;
  span(ctx,'#c4eedc',y,river-water*1.25,river+water*1.25);
  span(ctx,(strata&1)?'#62d3dc':'#76e1e6',y,river-water,river+water);
  const glint=river+water*.65*Math.sin(strata*2.3);
  if((strata+Math.floor(k.age/4))%5===0)span(ctx,'#d8ffec',y,glint-water*.23,glint+water*.23);

  const lip=Math.min(at-section.gapStart,section.gapEnd-at);
  if(lip<2.2){
    const pier=half*(.27+.18*(1-lip/2.2));
    const stone=strata%4===0?'#7d6a62':'#d8ccb8';
    for(const side of [-1,1]){
      const x=center+side*half;
      span(ctx,'#382032',y,x-pier,x+pier);
      span(ctx,stone,y,x-pier*.82,x+pier*.82);
      span(ctx,'#f0dfbf',y,x-pier*.78,x-pier*.46);
    }
    if(lip<.65)span(ctx,'#d8ccb8',y,center-half,center+half);
  }
}

function bridgeRail(ctx,y,at,left,right,rim){
  const post=at%4<.55, width=rim*(post?1.35:1);
  for(const x of [left-rim,right+rim]){
    span(ctx,'#7d6a62',y,x-width,x+width);
    span(ctx,post?'#eee1ca':'#d8ccb8',y,x-width*.72,x+width*.45);
  }
}

function bridgePost(ctx,x,y,scale){
  const p=Math.max(1,Math.round(scale*.105));
  tile(ctx,'#7d6a62',x-2*p,y-5*p,4*p,5*p);
  tile(ctx,'#d8ccb8',x-2*p,y-4*p,3*p,4*p);
  tile(ctx,'#eee1ca',x-2*p,y-5*p,4*p,p);
}

function road(ctx,k,c){
  const {w,h,far}=c,near=1.24;
  const rows=new Float32Array(h);
  let bottom=h,previous=projectKart(k,c,near),lastD=near;
  const step=(far/near)**(1/164);
  for(let i=1,z=near*step;i<=164;i++,z*=step){
    const next=projectKart(k,c,z),top=Math.max(0,Math.floor(next.y));
    if(top<bottom&&next.y<previous.y){
      for(let y=bottom-1;y>=top;y--){
        const t=clamp((previous.y-y-.5)/(previous.y-next.y),0,1);
        const d=1/mix(1/lastD,1/z,t), at=k.distance+d;
        const center=mix(previous.x,next.x,t),half=mix(previous.half,next.half,t);
        const stripe=Math.floor(at/5)&1,rumble=Math.floor(at/2.6)&1;
        const left=Math.round(center-half),right=Math.round(center+half),rim=Math.max(1,Math.round(half*.085));
        const section=kartSectionAt(k.track,at);
        rows[y]=d;
        if(section?.gap){
          canyonRow(ctx,k,c,section,at,y,center,half);
          if(section.bridge)bridgeRail(ctx,y,at,left,right,rim);
          continue;
        }
        tile(ctx,grassColor[stripe],0,y,w,1);
        tile(ctx,edgeColor[rumble],left-rim,y,right-left+2*rim,1);
        tile(ctx,roadColor[stripe],left,y,Math.max(1,right-left),1);
        if(half>11){
          tile(ctx,'#d8e1dd',left+1,y,1,1);
          tile(ctx,'#d8e1dd',right-2,y,1,1);
        }
        if(at%13<6){
          const mid=Math.max(1,Math.round(half*.022));
          tile(ctx,'#fffae7',center-mid/2,y,mid,1);
        }
        if(!k.cfg.hideFinishLine&&Math.abs(at-k.track.length)<1.5){
          for(let col=0;col<12;col++){
            const a=left+Math.round((right-left)*col/12),b=left+Math.round((right-left)*(col+1)/12);
            tile(ctx,(col+(at<k.track.length?1:0))%2?'#252838':paper,a,y,b-a,1);
          }
        }
        if(section?.bridge)bridgeRail(ctx,y,at,left,right,rim);
      }
      bottom=top;
    }
    previous=next;lastD=z;
    if(bottom===0)break;
  }
  return rows;
}

function padOnRoad(ctx,k,c,pad,rows){
  const left=pad.lane-(pad.width??.8)/2,right=pad.lane+(pad.width??.8)/2;
  const from=pad.at-1.2,to=pad.at+1.65;
  for(let y=0;y<rows.length;y++){
    const d=rows[y],at=k.distance+d;
    if(!d||at<from||at>to)continue;
    const a=projectKart(k,c,d,left).x,b=projectKart(k,c,d,right).x,w=b-a;
    const stage=Math.floor((at-from)*4);
    tile(ctx,stage%3===0?'#fff997':stage%3===1?'#f450ae':'#593caa',a,y,Math.max(1,w),1);
    for(let col=0;col<3;col++){
      const cx=a+w*(col+.5)/3,span=w*(.03+(stage%4)*.019);
      tile(ctx,'#c1ffff',cx-span,y,Math.max(1,span*2),1);
    }
  }
}

function jumpPadOnRoad(ctx,k,c,pad,rows){
  const from=pad.at-1.4,to=pad.at+1.8,half=(pad.width??.8)/2;
  const pulse=.5+.5*Math.sin(k.age*.27);
  for(let y=0;y<rows.length;y++){
    const d=rows[y],at=k.distance+d;
    if(!d||at<from||at>to)continue;
    const a=projectKart(k,c,d,pad.lane-half).x,b=projectKart(k,c,d,pad.lane+half).x;
    const width=b-a,phase=wrap((at-from)/1.6,1);
    span(ctx,'#a34d36',y,a,b);
    span(ctx,pulse>.45?'#ffbc36':'#ee8528',y,a+width*.05,b-width*.05);
    if(phase>.88)continue;
    const center=(a+b)/2,arm=width*(.34*(1-phase/.88)),stroke=width*.077;
    for(const side of [-1,1]){
      const x=center+side*arm;
      span(ctx,pulse>.45?'#fffdf0':'#fff08a',y,x-stroke,x+stroke);
    }
  }
}

function shrub(ctx,kind,x,y,h,i){
  if(h<8){
    tile(ctx,kind==='tree'?'#307761':kind==='sign'?'#f2ce74':'#f4c5be',x-1,y-h,Math.max(1,h*.46),h);
    return;
  }
  const p=Math.max(1,Math.round(h/10));
  if(kind==='tree'){
    tile(ctx,'#675a57',x-p,y-5*p,2*p,5*p);
    tile(ctx,'#225f61',x-4*p,y-8*p,8*p,5*p);
    tile(ctx,'#277e64',x-3*p,y-10*p,6*p,6*p);
    tile(ctx,'#5cae64',x-2*p,y-11*p,4*p,5*p);
    tile(ctx,'#aee48d',x-2*p,y-10*p,2*p,p);
  }else if(kind==='sign'){
    tile(ctx,'#74634d',x-p,y-7*p,2*p,7*p);
    tile(ctx,INK,x-4*p,y-10*p,8*p,5*p);
    tile(ctx,'#ffeabb',x-3*p,y-9*p,6*p,3*p);
    tile(ctx,'#da5465',x-2*p,y-8*p,4*p,p);
  }else{
    for(let a=-1;a<=1;a++){
      const left=x+a*3*p,top=y-(3+Math.abs(a)*2)*p;
      tile(ctx,'#28735c',left,y-4*p,p,4*p);
      tile(ctx,(i+a)%2?'#ffadd0':'#fff085',left-p,top-p,3*p,3*p);
      tile(ctx,paper,left,top,p,p);
    }
  }
}

function drawBox(ctx,k,art,x,y,h,tick,i){
  const flip=Math.abs(Math.cos(tick*.17+i)),width=Math.max(3,Math.round(h*(.42+flip*.63)));
  const c=['#9bf7f4','#c69aff','#ff9fd6','#ffd868'][Math.floor(tick/4+i)%4];
  shadow(ctx,x,y,width*1.35,Math.max(1,h*.11));
  const float=Math.round(h*(.15+.08*Math.sin(tick*.23+i)));
  y-=float;
  const img=art.images.get(k.cfg.itemBoxSprite);
  if(img?.naturalWidth){
    tile(ctx,c+'60',x-width*.56-1,y-h-1,width*1.12+2,h+2);
    ctx.drawImage(img,Math.round(x-width/2),Math.round(y-h),width,h);
    return;
  }
  tile(ctx,'#443c8a',x-width*.5-2,y-h-2,width+4,h+4);
  tile(ctx,c,x-width*.5,y-h,width,h);
  tile(ctx,paper,x-width*.5,y-h,width,Math.max(1,h*.14));
  tile(ctx,'#593f96',x-width*.5,y-h*.11,width,Math.max(1,h*.11));
  if(h>7)label(ctx,'?',x,y-h*.46,Math.max(7,h*.87),'#ffffff','center');
}

function turnChevron(ctx,x,y,h,direction){
  const p=Math.max(1,Math.round(h/10));
  tile(ctx,'#7d6a62',x-p,y-5*p,2*p,5*p);
  tile(ctx,'#713146',x-5*p,y-10*p,10*p,7*p);
  tile(ctx,'#c94844',x-4*p,y-9*p,8*p,5*p);
  tile(ctx,'#ffb747',x-4*p,y-9*p,8*p,p);
  for(let row=0;row<5;row++){
    const dx=(2-Math.abs(row-2))*p*direction;
    tile(ctx,paper,x+dx-2*p,y-(9-row)*p,2*p,p);
  }
}

function drawRivalItemBubble(ctx,x,y,h,bubble,tick){
  const s=Math.max(1,Math.round(h/22));
  const bw=16*s,bh=13*s,bx=Math.round(x-bw/2),by=Math.round(y-h-bh-4*s-Math.round(Math.sin(tick*.4)*s));
  const accent=bubble.kind==='boost'?'#5bf4f0':bubble.kind==='trap'?'#ffe854':'#ff6644';
  tile(ctx,INK,bx-s,by-s,bw+2*s,bh+2*s);
  tile(ctx,accent,bx,by,bw,bh);
  tile(ctx,'#16122c',bx+s,by+s,bw-2*s,bh-2*s);
  // Pointer pip
  tile(ctx,INK,Math.round(x-s),by+bh+s,2*s,2*s);
  const sym=bubble.kind==='boost'?'>>':bubble.kind==='trap'?'!':'*';
  label(ctx,sym,x,by+bh*.54,Math.max(7,9*s),accent,'center');
}

function drawHazard(ctx,x,y,h,tick){
  const r=Math.max(3,Math.round(h*.38));
  shadow(ctx,x,y+1,r*2.4,Math.max(2,r*.55));
  const pulse=(tick>>2)&1;
  // Chunky Deltarune melted-wax golden star-peel trap on asphalt!
  tile(ctx,INK,x-r-1,y-r-1,2*r+2,r+3);
  tile(ctx,pulse?'#ffe854':'#ffb830',x-r,y-r,2*r,r+1);
  tile(ctx,'#fffee0',x-Math.round(r*.55),y-Math.round(r*.8),Math.max(2,r),Math.max(2,Math.round(r*.45)));
  // Top warning glint sparkle
  if(h>10){
    const sp=Math.max(1,Math.round(r*.25));
    tile(ctx,pulse?'#ffffff':'#ff5a7a',x-sp,y-r-3*sp,2*sp,2*sp);
  }
}

function drawProjectile(ctx,k,art,x,y,h,proj,tick){
  const r=Math.max(3,Math.round(h*(proj.kind==='lob'?.46:proj.kind==='banana'?.62:.38)));
  const lift=Math.round((proj.airY??0)*h*.42);
  shadow(ctx,x,y+1,r*2.0,Math.max(2,r*.45),proj.kind==='lob'?'#28143288':'#28352b66');
  const cy=y-r-lift;
  if(proj.kind==='banana'){
    const bImg=art.images.get(k.cfg.bananaSprite??k.cfg.itemIcons?.banana);
    const sz=Math.max(14,Math.round(h*1.18));
    if(bImg?.naturalWidth){
      ctx.save();
      ctx.translate(Math.round(x),Math.round(cy));
      ctx.rotate(tick*.42);
      ctx.drawImage(bImg,Math.round(-sz/2),Math.round(-sz/2),sz,sz);
      ctx.restore();
    }else{
      tile(ctx,'#ffe854',x-r,cy-r,2*r,2*r);
    }
    for(let i=0;i<5;i++){
      const ang=tick*.5+i*1.25,rad=r*(.85+(i%2)*.4);
      tile(ctx,i%2?'#ffffff':'#ffe854',x+Math.cos(ang)*rad,cy+Math.sin(ang)*rad,Math.max(2,Math.round(r*.25)),Math.max(2,Math.round(r*.25)));
    }
    return;
  }
  // Spinning blazing Solar Shell / Star-Bomb!
  const rot=tick*.45;
  ctx.save();
  ctx.beginPath();
  for(let i=0;i<8;i++){
    const a=rot+i*Math.PI/4,rad=i%2?r*.55:r*1.18;
    const px=Math.round(x+Math.cos(a)*rad),py=Math.round(cy+Math.sin(a)*rad);
    if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
  }
  ctx.closePath();
  ctx.strokeStyle=INK;ctx.lineWidth=Math.max(2,Math.round(r*.22));ctx.stroke();
  ctx.fillStyle=proj.kind==='lob'?'#ff5e3a':'#ff9e2c';ctx.fill();
  ctx.restore();
  tile(ctx,'#fff48a',x-Math.round(r*.48),cy-Math.round(r*.48),Math.max(2,Math.round(r*.96)),Math.max(2,Math.round(r*.96)));
  tile(ctx,'#ffffff',x-Math.round(r*.24),cy-Math.round(r*.24),Math.max(1,Math.round(r*.48)),Math.max(1,Math.round(r*.48)));
}

function drawBurst(ctx,x,y,h,burst){
  const f=burst.age/burst.maxAge;
  const cy=y-Math.round(h*.65)-Math.round((burst.airY??0)*h*.3);
  const r=Math.max(12,h*(.42+Math.min(.25,f)*.45));
  ctx.save();
  ctx.globalAlpha=f<.65?1:(1-f)/.35;
  ctx.beginPath();
  for(let i=0;i<16;i++){
    const a=i*Math.PI/8,d=r*(i%2?.58:1.18);
    const sx=Math.round(x+Math.cos(a)*d*1.35),sy=Math.round(cy+Math.sin(a)*d);
    if(i===0)ctx.moveTo(sx,sy);else ctx.lineTo(sx,sy);
  }
  ctx.closePath();
  ctx.strokeStyle=INK;ctx.lineWidth=3;ctx.stroke();
  ctx.fillStyle=burst.color??'#ffe854';ctx.fill();
  if(h>12)label(ctx,burst.text??'POW!',x,cy,Math.max(10,Math.round(h*.44)),'#ffffff','center');
  for(let i=0;i<10;i++){
    const a=i*2.1,d=r*(.7+f*1.5);
    const sz=Math.max(2,Math.round(h*.07));
    tile(ctx,i%2?paper:'#ff7aa8',x+Math.cos(a)*d*1.2,cy+Math.sin(a)*d,sz,sz);
  }
  ctx.restore();
}

function rivalsAndRoadside(ctx,k,art,c,rows){
  const start=k.distance,limit=start+c.far,entries=[];
  const add=(at,lane,kind,data)=>{if(at>start+1.8&&at<=limit)entries.push({d:at-start,lane,kind,data});};
  for(const o of k.opponents)add(o.distance,o.lane,'opponent',o);
  for(const box of k.boxes)if(!box.used)add(box.at,box.lane,'box',box);
  for(const hz of k.hazards??[])add(hz.distance,hz.lane,'hazard',hz);
  for(const pr of k.projectiles??[])add(pr.distance,pr.lane,'projectile',pr);
  for(const bu of k.bursts??[])add(bu.distance,bu.lane,'burst',bu);
  for(const object of k.cfg.scenery??[])add(object.at,object.lane,object.kind??'flower',object);
  for(const section of k.track.sections){
    if(section.end<=start||section.start>limit)continue;
    const end=Math.min(section.end,limit);
    // The track stores curvature at .004 times the authored value.
    if(!section.gap&&Math.abs(section.curve)>=1.25*.004){
      const direction=Math.sign(section.curve);
      const first=section.start+Math.min(3,(section.end-section.start)/2);
      for(let at=first+10*Math.max(0,Math.floor((start-first)/10));at<end;at+=10){
        add(at,-direction*1.35,'chevron',direction);
      }
    }
    if(section.bridge){
      let at=Math.ceil(Math.max(start,section.start)/4)*4;
      for(;at<end;at+=4){
        add(at,-1.085,'bridgePost',null);
        add(at,1.085,'bridgePost',null);
      }
    }
  }
  if(k.cfg.generateScenery!==false){
    for(let i=Math.floor(start/7.5);i<Math.min(Math.ceil(limit/7.5),Math.ceil(k.track.length/7.5));i++){
      const at=i*7.5+4,lane=(i%2?1:-1)*(1.32+((i*7)%10)*.084);
      if(!kartSectionAt(k.track,at)?.gap)add(at,lane,i%11===6?'sign':i%4===0?'tree':'flower',{i});
    }
  }
  entries.sort((a,b)=>b.d-a.d);
  for(const {d,lane,kind,data} of entries){
    const point=projectKart(k,c,d,lane),x=Math.round(point.x),y=Math.round(point.y);
    const lift=kind==='opponent'?data.airY*point.scale*.55:0,feet=Math.round(y-lift);
    if(x<-c.h*.35||x>c.w+c.h*.35||feet>=c.h||feet<0)continue;
    if(kind!=='burst'&&kind!=='projectile'&&rows[feet]&&d>rows[feet]*1.17+1.4)continue;
    const h=Math.round(clamp(point.scale*(kind==='opponent'?1.75:kind==='box'?1.23:kind==='hazard'?1.05:kind==='projectile'?1.15:kind==='burst'?1.85:2.3),2,c.h*.42));
    if(kind==='opponent'){
      const spin=data.spin?Math.sin(data.spin*.64):0;
      const hop=lift+(data.spin?Math.abs(spin)*h*.29*clamp(data.spin/17,0,1):0);
      drawCar(ctx,art,{x,y,height:h,color:data.color,sprite:data.sprite,turn:spin,spin,hop,boost:data.boost>0,
        groundShadow:!kartSectionAt(k.track,data.distance)?.gap});
      if(data.boost>0&&h>10){
        // Roaring rival turbo flame sparks!
        for(let fi=0;fi<6;fi++){
          const ph=(fi*5+k.age*3)%10,sd=fi%2?1:-1,sz=Math.max(2,Math.round(h*.10*(1-ph/12)));
          tile(ctx,fi%2?'#5bf4f0':'#ffe854',x+sd*h*.22+sd*ph*.6,y-hop-h*.06+ph*.4,sz,sz);
        }
      }
      if(k.countdownTicks>0&&k.age<=k.countdownTicks&&h>14){
        const puff=((k.age+x)%8)/8,ps=Math.max(2,Math.round(h*.09*(1-puff*.4)));
        tile(ctx,puff<.5?'#fff8d6':'#c9d4e8',x-h*.22-puff*6,y-h*.08-puff*5,ps,ps);
        tile(ctx,puff<.5?'#fff8d6':'#c9d4e8',x+h*.22+puff*6,y-h*.08-puff*5,ps,ps);
      }
      if(data.itemBubble&&h>12)drawRivalItemBubble(ctx,x,y-hop,h,data.itemBubble,k.age);
      if(data.spin&&h>9){
        for(let si=0;si<3;si++){
          const ang=k.age*.4+si*2.1;
          tile(ctx,warm,x+Math.cos(ang)*h*.34,y-h-hop-4+Math.sin(ang)*2,Math.max(2,Math.round(h*.09)),Math.max(2,Math.round(h*.06)));
        }
      }
    }else if(kind==='box')drawBox(ctx,k,art,x,y,h,k.age,data.index);
    else if(kind==='hazard')drawHazard(ctx,x,y,h,k.age);
    else if(kind==='projectile')drawProjectile(ctx,k,art,x,y,h,data,k.age);
    else if(kind==='burst')drawBurst(ctx,x,y,h,data);
    else if(kind==='chevron')turnChevron(ctx,x,y,h,data);
    else if(kind==='bridgePost')bridgePost(ctx,x,y,point.scale);
    else if(!spriteAt(ctx,art,data.src??k.cfg.roadSprites?.[kind],x,y,kind==='flower'?h*.72:h))shrub(ctx,kind,x,y,h,data.i??0);
  }
}

function playerCar(ctx,k,art,c){
  const x=c.w/2+k.steer*c.w*.036,baseY=c.h*(k.boost?.87:.89),height=c.h*(k.boost?.219:.248);
  const lift=Math.round(k.airY*c.h*.14),headroom=(baseY-height)*.35,ceiling=baseY-height-headroom;
  // Ease into the top of frame on tall jumps, keeping the player visible.
  const hop=lift<=ceiling?lift:ceiling-headroom*Math.expm1(-(lift-ceiling)/headroom);
  const y=baseY-hop;
  const angle=Math.abs(k.steer),key=angle<.24?'straight':(k.steer<0?'left':'right')+(angle>.88?'2':'1');
  const sprites=k.cfg.playerSprites;
  const pose=(k.boost?sprites?.boost:null)??sprites?.[key]??sprites?.straight;
  drawCar(ctx,art,{x,y:baseY,height,hop,turn:k.steer,player:true,sprite:pose,boost:k.boost>0,
    groundShadow:!kartSectionAt(k.track,k.distance)?.gap});
  const tireY=y-height*.075;
  if(k.landFlash>0){
    const age=10-k.landFlash,unit=Math.max(1,Math.round(height*.052));
    for(let i=0;i<12;i++){
      const side=i%2?1:-1,spread=height*.22+age*unit*(.38+i%3*.20);
      const sy=tireY-unit*(1+(i*7)%3+Math.sin(age*.29)*(1.5+i%3));
      const size=Math.max(1,Math.round(unit*(.4+k.landFlash*.06)));
      tile(ctx,i%3===0?paper:i%3===1?'#ffe17c':'#ffb24d',x+side*spread,sy,size,size);
    }
  }
  if(k.countdownTicks>0&&k.age<=k.countdownTicks){
    // Symmetric twin exhaust idle puffs directly behind the tailpipes!
    const puff=(k.age%8)/8,ps=Math.max(2,Math.round(height*.075*(1-puff*.4)));
    for(const side of [-1,1]){
      tile(ctx,puff<.5?'#fff8d6':'#c9d4e8',x+side*height*.09+side*puff*5,tireY-height*.03-puff*7,ps,ps);
    }
  }
  if(k.braking){
    // Billowing pixel tire smoke clouds anchored right at both rear tires!
    for(let i=0;i<14;i++){
      const phase=(i*5+k.age*3)%16,life=1-phase/16,side=i%2?1:-1;
      const sx=x+side*(height*.24+phase*.9)+(i%3-1)*3;
      const sy=tireY-phase*1.1-(i%4)*2;
      const sz=Math.max(3,Math.round(height*(.085+phase*.006)*life));
      tile(ctx,i%3===0?'#ffffff':i%3===1?'#e2e6f2':'#b4bed6',sx-sz/2,sy-sz/2,sz,sz);
    }
  }
  if(k.drift>0){
    // Crisp Mario-Kart tire-edge drift sparks anchored strictly at BOTH rear tires (NEVER floating off-kart!)
    const charge=k.drift>=21;
    const sprayDir=-(k.driftDir||Math.sign(k.steer)||1);
    for(let i=0;i<14;i++){
      const phase=(i*7+k.age*3)%15,life=1-phase/15;
      const tireSide=i%3===0?-sprayDir:sprayDir;
      const baseTx=x+tireSide*height*.24;
      const sx=baseTx+sprayDir*(phase*1.1+(i%3)*2);
      const sy=tireY-Math.sin(life*Math.PI)*height*.09-(i%3)*2;
      const size=Math.max(2,Math.round(height*.055*life));
      tile(ctx,i%4===0?paper:charge?'#ffb12a':aqua,sx-size/2,sy-size/2,size,size);
    }
  }
  if(k.boost>0&&!k.braking){
    // Symmetric twin tailpipe turbo jet sparks cleanly trailing behind BOTH exhaust nozzles!
    for(let i=0;i<10;i++){
      const phase=(i*5+k.age*3)%11,life=1-phase/11,side=i%2?1:-1;
      const sx=x+side*(height*.075+phase*.32)+(i%3-1)*1.5;
      const sy=tireY-height*.02+phase*.55;
      const size=Math.max(2,Math.round(height*.048*life));
      tile(ctx,i%3===0?paper:i%2?'#ffe854':'#5bf4f0',sx-size/2,sy-size/2,size,size);
    }
  }
  if(k.cardPop){
    // Tactile rainbow crystal shatter exploding right off Kris's bumper on '?' card impact!
    const pf=k.cardPop.age/k.cardPop.maxAge;
    const cols=['#9bf7f4','#ff9fd6','#ffd868','#ffffff','#c69aff'];
    for(let i=0;i<16;i++){
      const ang=i*(Math.PI*2/16)+.25,dist=height*(.18+pf*.62)*(0.75+(i%3)*.2);
      const sx=x+Math.cos(ang)*dist*1.25,sy=y-height*.42+Math.sin(ang)*dist*.85;
      const sz=Math.max(2,Math.round(height*.075*(1-pf*.65)));
      tile(ctx,cols[i%cols.length],sx-sz/2,sy-sz/2,sz,sz);
    }
  }
  if(k.star){
    // Starwalker: invincible rainbow dash. Orbiting star pixels plus a rainbow wake behind the kart.
    const rainbow=['#ff5a7a','#ffb347','#ffe854','#6dff8f','#5bf4f0','#7f8cff','#d77bff'];
    const life=1-k.star.age/k.star.maxAge;
    for(let i=0;i<14;i++){
      const a=k.age*.33+i*Math.PI*2/14,rx=height*.62,ry=height*.30;
      const sx=x+Math.cos(a)*rx,sy=y-height*.42+Math.sin(a)*ry,sz=Math.max(2,Math.round(height*.05));
      tile(ctx,rainbow[(i+k.age)%rainbow.length],sx-sz/2,sy-sz/2,sz,sz);
      if(i%3===0){tile(ctx,paper,sx-sz*1.5,sy-.5,sz*3,1);tile(ctx,paper,sx-.5,sy-sz*1.5,1,sz*3);}
    }
    for(let j=0;j<rainbow.length;j++){
      const bandW=Math.max(2,Math.round(height*.06));
      const wake=Math.round(height*(.25+.35*life));
      tile(ctx,rainbow[j],x-bandW*rainbow.length/2+j*bandW,tireY,bandW,wake);
    }
  }
  if(k.itemBanner&&!k.cfg.hideItemBanner){
    // Iconic Deltarune comic popup above Kris (e.g. 'POTASSIUM!')
    const liftY=Math.round(Math.min(1,k.itemBanner.age/6)*8);
    bubble(ctx,k.itemBanner.text,x,Math.max(22,Math.round(y-height-6-liftY)),Math.max(9,c.h*.054),c.w-8);
  }
  return {x,y:y-height*.77};
}

function lancerIcon(ctx,k,art,x,y,size,drop=false){
  const dropArt=k.cfg.lancerDrop??k.cfg.lancerSprite;
  const src=drop?(dropArt??k.cfg.lancerIcon):(k.cfg.lancerIcon??dropArt);
  if(!spriteAt(ctx,art,src,x,y+size/2,size))pixels(ctx,lancer,lancerPalette,x,y+size/2,size);
}

function targetOnScreen(k,c,target){
  const at=Math.max(3.9,target.distance-k.distance);
  const pt=projectKart(k,c,at,target.lane);
  return {x:Math.round(clamp(pt.x,28,c.w-28)),y:Math.round(clamp(pt.y,c.horizon+1,c.h-14)),scale:pt.scale};
}

function bubble(ctx,text,x,y,size,maxW){
  ctx.font='bold '+Math.round(size)+'px'+font;
  const w=Math.min(maxW,Math.ceil(ctx.measureText(text).width)+12),h=Math.round(size+8);
  const left=clamp(x-w/2,2,maxW-w+2);
  tile(ctx,INK,left-2,y-h-2,w+4,h+4);
  tile(ctx,paper,left,y-h,w,h);
  tile(ctx,paper,clamp(x-3,left,left+w-5),y,5,4);
  label(ctx,text,left+w/2,y-h/2,size,'#38427d','center');
}

function drawLancer(ctx,k,art,c,player){
  const l=k.lancer;
  if(l){
    const point=targetOnScreen(k,c,l.target),fall=l.phase==='drop',f=l.progress;
    const aimW=Math.max(9,point.scale*.93)+(1-f)*c.h*.13;
    if(fall||f>.55){
      shadow(ctx,point.x,point.y,aimW*1.3,Math.max(4,aimW*.34),'#9c2b556c');
      shadow(ctx,point.x,point.y,aimW,Math.max(2,aimW*.18),'#f75863');
      tile(ctx,'#ffeba7',point.x-1,point.y-4,2,7);
      tile(ctx,'#ffeba7',point.x-4,point.y-1,8,2);
    }
    const x=fall?point.x:mix(player.x,point.x,f);
    const apex=c.h*.12, y=fall?mix(apex,point.y-10,f*f):mix(player.y,apex,f)-Math.sin(f*Math.PI)*c.h*.075;
    const size=Math.max(13,c.h*(fall?.145+f*.045:.105-f*.027),point.scale*.8);
    if(fall){
      for(let i=0;i<8;i++)tile(ctx,i%2?warm:paper,x+((i*7)%23)-11,y-size*.77-i*3,1,3+i%5);
      if(f<.82){
        const bx=x>c.w*.45?x-size*.95:x+size*.75;
        const minY=Math.round(c.h*.24);
        bubble(ctx,'HO HO HO!',bx,Math.max(minY,Math.round(y-size*.42)),Math.max(8,c.h*.054),c.w-8);
      }
    }else{
      shadow(ctx,x,y,size*1.35,size*1.25,'#ffefad88');
      for(let i=0;i<7;i++)tile(ctx,i%2?paper:aqua,x+(i*11%19)-9,y+size*.45+i*2,2,2);
    }
    lancerIcon(ctx,k,art,x,y,size,fall);
  }
  const impact=k.impact;
  if(impact){
    const {x,y}=targetOnScreen(k,c,impact.target);
    const f=impact.age/20,cy=y-Math.round(c.h*.076),r=c.h*(.15+Math.min(.2,f)*.3);
    ctx.save();ctx.globalAlpha=f<.63?1:(1-f)/.37;
    if(!spriteAt(ctx,art,k.cfg.impactSprite,x,cy+r*1.1,r*2.2)){
      ctx.beginPath();
      for(let i=0;i<24;i++){
        const angle=i*Math.PI/12,d=r*(i%2?.64:1.18+(i%4)*.067);
        const sx=Math.round(x+Math.cos(angle)*d*1.54),sy=Math.round(cy+Math.sin(angle)*d);
        if(i===0)ctx.moveTo(sx,sy);else ctx.lineTo(sx,sy);
      }
      ctx.closePath();ctx.strokeStyle='#b73b63';ctx.lineWidth=4;ctx.stroke();ctx.fillStyle='#fff68e';ctx.fill();
    }
    label(ctx,'SPLAT!',x,cy,Math.max(17,c.h*.118),'#d74370','center');
    for(let i=0;i<21;i++){
      const angle=i*2.39,d=r*(.65+f*1.7)*(i%4+2)/4;
      const size=Math.max(1,(i%3+1)*Math.round(c.h/180));
      tile(ctx,i%3===0?'#ff82ac':paper,x+Math.cos(angle)*d*1.4,cy+Math.sin(angle)*d,size,size);
    }
    ctx.restore();
  }
}

function speedlines(ctx,k,c){
  if(!k.boost)return;
  const {w,h,horizon}=c,fade=clamp(k.boost/9,0,1);
  ctx.save();ctx.globalAlpha=fade*.67;
  for(let i=0;i<27;i++){
    const p=((i*13+k.age*6)%51)/51,s=i%2?1:-1;
    const angle=.15+(i*7%19)*.035;
    const x=w/2+s*(w*.17+p*w*.34),y=horizon+(h-horizon)*angle*(.5+p);
    for(let j=0;j<Math.round(p*12);j++)
      tile(ctx,i%3?paper:aqua,x+s*j*2,y+j*angle,2,1+(p>.6));
  }
  ctx.restore();
}

export function drawKart(ctx,k,art,w,h,_room){
  const c=kartCamera(k,w,h);
  sky(ctx,k,art,c,k.age);
  const rows=road(ctx,k,c);
  for(const pad of k.pads)if(pad.at>=k.distance&&pad.at<=k.distance+c.far)padOnRoad(ctx,k,c,pad,rows);
  for(const pad of k.jumps)if(pad.at+1.8>=k.distance&&pad.at-1.4<=k.distance+c.far)jumpPadOnRoad(ctx,k,c,pad,rows);
  rivalsAndRoadside(ctx,k,art,c,rows);
  speedlines(ctx,k,c);
  const player=playerCar(ctx,k,art,c);
  drawLancer(ctx,k,art,c,player);
  const glare=clamp((k.raceProgress-.67)/.33,0,1);
  if(glare){
    const g=ctx.createRadialGradient(w*.5,h*.50,h*.17,w*.5,h*.49,Math.max(w*.62,h*.64));
    g.addColorStop(0,'rgba(255,234,171,0)');
    g.addColorStop(.58,'rgba(255,234,171,0)');
    g.addColorStop(1,'#ffe594');
    ctx.save();ctx.globalAlpha=glare*.87;ctx.fillStyle=g;ctx.fillRect(0,0,w,h);ctx.restore();
  }
}

function drFrame(ctx,x,y,w,h,accent='#ffe168',s=1){
  // Crisp Deltarune pure-black double-bordered pixel frame (zero flat Codex cards!)
  tile(ctx,'#ffffff',x,y,w,h);
  tile(ctx,accent,x+s,y+s,w-2*s,h-2*s);
  tile(ctx,'#000000',x+2*s,y+2*s,w-4*s,h-4*s);
  // Decorative pixel corner diamonds
  tile(ctx,'#ffffff',x+2*s,y+2*s,s,s);
  tile(ctx,'#ffffff',x+w-3*s,y+2*s,s,s);
  tile(ctx,'#ffffff',x+2*s,y+h-3*s,s,s);
  tile(ctx,'#ffffff',x+w-3*s,y+h-3*s,s,s);
}

const PIXEL_FONT={
  '0':['01110','10001','10011','10101','11001','10001','01110'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['01110','10001','00001','00110','01000','10000','11111'],
  '3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['00010','00110','01010','10010','11111','00010','00010'],
  '5':['11111','10000','10000','11110','00001','00001','11110'],
  '6':['01110','10000','10000','11110','10001','10001','01110'],
  '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],
  '9':['01110','10001','10001','01111','00001','00001','01110'],
  'S':['01111','10000','10000','01110','00001','00001','11110'],
  'T':['11111','00100','00100','00100','00100','00100','00100'],
  'N':['10001','11001','10101','10011','10001','10001','10001'],
  'D':['11110','10001','10001','10001','10001','10001','11110'],
  'R':['11110','10001','10001','11110','10100','10010','10001'],
  'H':['10001','10001','10001','11111','10001','10001','10001'],
  'G':['01110','10001','10000','10111','10001','10001','01110'],
  'O':['01110','10001','10001','10001','10001','10001','01110'],
  '!':['00100','00100','00100','00100','00100','00000','00100'],
};

function drawPixelText(ctx,text,cx,cy,px,color,shadowCol=INK){
  const gap=px,glyphW=5*px,glyphH=7*px;
  const totalW=text.length*glyphW+Math.max(0,text.length-1)*gap;
  let x=Math.round(cx-totalW/2),y=Math.round(cy-glyphH/2);
  for(const ch of text){
    const rows=PIXEL_FONT[ch];
    if(rows){
      for(let r=0;r<rows.length;r++)for(let c=0;c<rows[r].length;c++)if(rows[r][c]==='1'){
        tile(ctx,shadowCol,x+c*px+px,y+r*px+px,px,px);
        tile(ctx,color,x+c*px,y+r*px,px,px);
      }
    }
    x+=glyphW+gap;
  }
}

function drawItemIcon(ctx,k,art,itemId,x,y,size){
  const mapped=k.cfg.itemIcons?.[itemId];
  if(mapped&&spriteAt(ctx,art,mapped,x,y+size/2,size))return;
  if(itemId==='lancer'){lancerIcon(ctx,k,art,x,y,size,false);return;}
  if(itemId==='boost'){label(ctx,'>>',x,y,size*.65,'#5bf4f0','center');return;}
  label(ctx,itemId?itemId[0].toUpperCase():'?',x,y,size*.65,'#ffe854','center');
}

export function drawKartHud(ctx,k,art,w,h){
  const s=Math.max(1,Math.floor(h/180)),margin=7*s;
  const ranks=['1ST','2ND','3RD','4TH','5TH','6TH','7TH','8TH'];
  const rankCols=['#ffe854','#d8ecff','#ffb062','#5bf4f0','#a6f078','#d6a2ff','#ff94c8','#ff6e6e'];
  const idx=clamp(k.position-1,0,ranks.length-1);

  // 1. Top-Left Deltarune × SNES Rank Badge (custom bitmap glyphs — ZERO font clipping!)
  drFrame(ctx,margin,margin,48*s,26*s,rankCols[idx],s);
  drawPixelText(ctx,ranks[idx],margin+24*s,margin+13*s,2*s,rankCols[idx]);

  // 2. Top-Left Arcade Item Roulette Box (multi-item absurd Deltarune reel!)
  const iw=34*s,ix=margin+53*s,iy=margin;
  const boxGlow=k.roulette&&k.age%4<2?'#ff4498':k.item==='banana'?'#ffe854':k.item==='lancer'?'#5bf4f0':'#ff8822';
  drFrame(ctx,ix,iy,iw,iw,boxGlow,s);
  ctx.save();
  ctx.beginPath();ctx.rect(ix+2*s,iy+2*s,iw-4*s,iw-4*s);ctx.clip();
  // Subtle Deltarune dark-grid background inside item frame
  for(let gx=0;gx<iw;gx+=6*s)tile(ctx,'#16122c',ix+gx,iy+2*s,s,iw-4*s);
  for(let gy=0;gy<iw;gy+=6*s)tile(ctx,'#16122c',ix+2*s,iy+gy,iw-4*s,s);
  if(k.roulette){
    const pool=k.roulette.pool?.length?k.roulette.pool:['lancer','boost','lancer'];
    const total=Math.max(1,Math.round(.85*30));
    const u=clamp(k.roulette.age/total,0,1);
    // Smooth decelerating Mario-Kart reel landing squarely on k.roulette.reward!
    const rewardIdx=Math.max(0,pool.indexOf(k.roulette.reward));
    const totalSteps=pool.length*2+rewardIdx;
    const pos=totalSteps*(1-(1-u)*(1-u));
    const baseIdx=Math.floor(pos),frac=pos-baseIdx;
    const stepH=26*s,centerY=iy+iw*.50;
    for(let i=-1;i<=1;i++){
      const itemKey=pool[((baseIdx+i)%pool.length+pool.length)%pool.length];
      drawItemIcon(ctx,k,art,itemKey,ix+iw/2,centerY+(i-frac)*stepH,24*s);
    }
  }else if(k.item){
    drawItemIcon(ctx,k,art,k.item,ix+iw/2,iy+iw*.50,27*s);
  }else{
    label(ctx,k.lancer?'!':'?',ix+iw/2,iy+iw*.52,16*s,k.lancer?'#5bf4f0':'#4d3866','center');
  }
  ctx.restore();

  // 3. Top-Right Deltarune Rock-Steady Pixel Speedometer (crisp bitmap digits + smooth readout + dynamic RPM bar!)
  const sw=86*s,sh=26*s,sx=w-margin-sw;
  const shownSpd=Math.round(k.displaySpeed??k.speed);
  const maxSpd=(k.cfg?.maxSpeed??208)*1.29;
  drFrame(ctx,sx,margin,sw,sh,k.braking?'#ff6644':k.boost?'#ff4498':'#00e8ff',s);
  const spdStr=String(shownSpd).padStart(3,'0');
  const dpx=Math.max(1,Math.round(1.5*s));
  drawPixelText(ctx,spdStr,sx+25*s,margin+10*s,dpx,k.braking?'#ffb88c':k.boost?'#ffe854':'#ffffff');
  label(ctx,'KM/H',sx+sw-5*s,margin+10*s,7.5*s,'#5bf4f0','right');
  // 10-segment arcade RPM / Turbo LED bar scaled cleanly across 0..maxSpd!
  const segs=10,lit=Math.round(clamp(shownSpd/Math.max(180,maxSpd),0,1)*segs);
  for(let i=0;i<segs;i++){
    const col=i>=lit?'#201a38':(k.braking?'#ff6644':i>=8?'#ff4498':i>=6?'#ffe854':i>=3?'#5bf4f0':'#52e878');
    tile(ctx,col,sx+6*s+i*7.4*s,margin+18*s,6*s,4*s);
  }

  // 4. Clean Mini Course-to-Sun Strip below Speedometer (pure pixel visual, zero ugly text bar!)
  const py=margin+sh+4*s,pw=sw;
  tile(ctx,'#000000cc',sx,py,pw,9*s);
  tile(ctx,'#ffffff',sx,py,pw,s);tile(ctx,'#ffffff',sx,py+8*s,pw,s);
  tile(ctx,'#ffffff',sx,py,s,9*s);tile(ctx,'#ffffff',sx+pw-s,py,s,9*s);
  // Track dashed line + moving cyan Kris marker + golden Sun goal dot!
  tile(ctx,'#524672',sx+5*s,py+4*s,pw-14*s,s);
  const hudProg=clamp(k.raceProgress,0,1)*(k.cfg?.hudProgressMax??1);
  const kx=sx+5*s+Math.round((pw-16*s)*hudProg);
  tile(ctx,'#00f0ff',kx-s,py+2*s,4*s,5*s);
  tile(ctx,'#ff2478',kx,py+3*s,2*s,2*s);
  // Little radiant pixel sun icon at the finish end
  const sunx=sx+pw-7*s;
  tile(ctx,'#ffae34',sunx-2*s,py+2*s,5*s,5*s);
  tile(ctx,'#fffee6',sunx-s,py+3*s,3*s,3*s);

  // 5. Beat-Synced Start Countdown Banner ('3' - '2' - '1' - 'GO!')
  if(k.countdownTicks>0&&k.age<=k.countdownTicks+24){
    const step=Math.max(1,Math.floor(k.countdownTicks/3));
    const isGo=k.age>k.countdownTicks;
    const countVal=isGo?'GO!':String(clamp(3-Math.floor((k.age-1)/step),1,3));
    const accent=isGo?'#52f49c':countVal==='1'?'#ffe854':countVal==='2'?'#ffad42':'#ff5a7a';
    const bw=isGo?66*s:42*s,bh=32*s,bx=Math.round(w/2-bw/2),by=Math.round(h*.23);
    const pulse=isGo?0:Math.round(Math.sin(((k.age-1)%step)/step*Math.PI)*3*s);
    drFrame(ctx,bx,by-pulse,bw,bh,accent,s);
    drawPixelText(ctx,countVal,w/2,by-pulse+bh/2,3*s,accent);
    if(!k.cfg?.hideCountdownRef){
      const lx=bx+bw+18*s,ly=by+16*s+Math.round(Math.sin(k.age*.25)*3*s);
      lancerIcon(ctx,k,art,lx,ly,26*s,false);
      const fx=lx+12*s,fy=ly-14*s,wave=Math.round(Math.sin(k.age*.45)*2*s);
      tile(ctx,'#ffe8a8',fx,fy-2*s,2*s,22*s);
      for(let r=0;r<3;r++)for(let c=0;c<4;c++){
        tile(ctx,(r+c)%2===0?'#ffffff':'#18182c',fx+2*s+c*3*s,fy+r*3*s+(c>=2?wave:0),3*s,3*s);
      }
    }
  }

  if(k.finished){
    drFrame(ctx,w/2-62*s,h*.52-15*s,124*s,30*s,'#ffe854',s);
    label(ctx,'FINISH!',w/2,h*.52,18*s,'#ffe854','center');
  }
}
