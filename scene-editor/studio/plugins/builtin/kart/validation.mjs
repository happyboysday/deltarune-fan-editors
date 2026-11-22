import {KART_POSES} from '../../../format-compat.mjs';
export function validation({project:p,obj,bool,opt,num,source,one,arr,id,error,color,evt,range,timeline}){
  function kartConfig(c,k){
    if(!obj(c,k))return;
    for(const field of ['autoAccelerate','generateScenery','hideFinishLine','hideCountdownRef','hideItemBanner'])opt(c,field,k,bool);
    opt(c,'hudProgressMax',k,(v,q)=>num(v,q,.05,1));
    opt(c,'startLane',k,(v,q)=>num(v,q,-1.25,1.25));
    opt(c,'maxSpeed',k,(v,q)=>num(v,q,30,400));
    opt(c,'acceleration',k,(v,q)=>num(v,q,20,400));
    opt(c,'steering',k,(v,q)=>num(v,q,.1,3));
    opt(c,'seed',k,(v,q)=>num(v,q,0,0xffffffff,true));
    opt(c,'countdownTicks',k,(v,q)=>num(v,q,0,240,true));
    for(const field of ['skySprite','horizonSprite','horizonFarSprite','sunSprite','bulbSprite','bulbRevealSprite',
      'lancerIcon','lancerDrop','lancerSprite','itemBoxSprite','impactSprite'])opt(c,field,k,source);
    opt(c,'playerSprites',k,(sprites,q)=>{if(obj(sprites,q))
      for(const pose of KART_POSES)opt(sprites,pose,q,source);
    });
    opt(c,'rivalSprites',k,(sprites,q)=>{
      if(Array.isArray(sprites)){
        if(arr(sprites,q,8))sprites.forEach((v,i)=>{if(v!==null)source(v,q+'.'+i);});
      }else if(obj(sprites,q)){
        for(const [rival,src] of Object.entries(sprites)){id(rival,q+'.'+rival);source(src,q+'.'+rival);}
      }
    });
    const item=(v,q)=>one(v,['lancer','boost','banana','dogcar','starwalker','nubert','pipis'],q);
    opt(c,'forceItem',k,item);
    opt(c,'items',k,(items,q)=>{if(arr(items,q,12)){
      if(!items.length)error(q,'至少需要一种道具');
      items.forEach((value,i)=>item(value,q+'.'+i));
    }});
    opt(c,'itemSequence',k,(seq,q)=>{if(arr(seq,q,16))seq.forEach((value,i)=>item(value,q+'.'+i));});
    opt(c,'roulettePool',k,(pool,q)=>{if(arr(pool,q,12))pool.forEach((value,i)=>item(value,q+'.'+i));});
    opt(c,'itemIcons',k,(icons,q)=>{if(obj(icons,q))for(const [idKey,src] of Object.entries(icons)){item(idKey,q+'.'+idKey);source(src,q+'.'+idKey);}});
    opt(c,'bananaSprite',k,source);
    const rows=(name,max,check)=>opt(c,name,k,(items,q)=>{
      if(arr(items,q,max))items.forEach((row,i)=>{const l=q+'.'+i;if(obj(row,l))check(row,l,i);});
    });
    rows('trackSegments',64,(seg,q)=>{
      num(seg.length,q+'.length',5,5000);
      opt(seg,'curve',q,(v,l)=>num(v,l,-3,3));
      opt(seg,'slope',q,(v,l)=>num(v,l,-.28,.28));
      opt(seg,'gap',q,bool);opt(seg,'bridge',q,bool);
    });
    if(Array.isArray(c.trackSegments)&&!c.trackSegments.length)error(k+'.trackSegments','至少需要一段赛道');
    const end=Array.isArray(c.trackSegments)?c.trackSegments.reduce((sum,seg)=>sum+(Number(seg?.length)||0),0):650;
    rows('jumpPads',32,(pad,q)=>{
      num(pad.at,q+'.at',0,Math.max(0,end-1));
      num(pad.lane,q+'.lane',-1.25,1.25);
      opt(pad,'width',q,range(.1,2.5));opt(pad,'power',q,range(.4,2.5));
    });
    const used=new Set();
    rows('opponents',8,(o,q,i)=>{
      opt(o,'id',q,id);
      const name=o.id??'rival-'+(i+1);
      if(used.has(name))error(q+'.id','对手 ID 重复');
      used.add(name);
      opt(o,'lane',q,(v,l)=>num(v,l,-1.2,1.2));
      opt(o,'start',q,(v,l)=>num(v,l,0,Math.max(0,end-1)));
      opt(o,'speed',q,(v,l)=>num(v,l,25,400));
      opt(o,'sprite',q,source);opt(o,'color',q,color);
    });
    rows('rivalActions',64,(a,q)=>{
      num(a.tick,q+'.tick',0,3600,true);
      id(a.actor,q+'.actor');
      one(a.type,['boost','shell','trap','lob'],q+'.type');
      opt(a,'targetId',q,id);
      opt(a,'ticks',q,(v,l)=>num(v,l,1,300,true));
      opt(a,'speed',q,(v,l)=>num(v,l,-400,600));
      opt(a,'lane',q,(v,l)=>num(v,l,-1.2,1.2));
      opt(a,'behind',q,(v,l)=>num(v,l,0,20));
      opt(a,'flightTicks',q,(v,l)=>num(v,l,5,120,true));
      opt(a,'maxAge',q,(v,l)=>num(v,l,5,240,true));
    });
    for(const name of ['itemBoxes','boostPads','scenery'])rows(name,name==='scenery'?256:64,(o,q)=>{
      num(o.at,q+'.at',0,Math.max(0,end-1));
      num(o.lane,q+'.lane',name==='scenery'?-6:-1.25,name==='scenery'?6:1.25);
      if(name==='boostPads')opt(o,'width',q,(v,l)=>num(v,l,.1,2.5));
      if(name==='scenery'){
        opt(o,'kind',q,(v,l)=>one(v,['flower','tree','sign'],l));
        opt(o,'src',q,source);
      }
    });
    opt(c,'onFinish',k,evt);
  }
  opt(p,'kartScript','$',timeline);
  return {room({room:r,path}){
    opt(r,'kartScript',path,(v,k)=>timeline(v,k,true));
    opt(r,'kartConfig',path,kartConfig);
  }};
}
