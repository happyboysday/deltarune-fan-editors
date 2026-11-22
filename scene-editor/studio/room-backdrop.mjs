import {tile} from './ui-draw.mjs';
const beams=[
  {x:60,y:-65,width:18,length:240,angle:-28,alpha:.19,speedX:.34},
  {x:130,y:-32,width:15,length:240,angle:-28,alpha:.13,speedX:.37},
  {x:258,y:-45,width:26,length:290,angle:-28,alpha:.16,speedX:.49}
];

export function drawTrailerBackdrop(ctx,r,art,cam,w,h){
  if(r.skyGradient){
    const sky=ctx.createLinearGradient(0,0,0,h);
    sky.addColorStop(0,r.skyGradient.top);
    sky.addColorStop(1,r.skyGradient.bottom);
    ctx.fillStyle=sky;
    ctx.fillRect(0,0,w,h);
  }else tile(ctx,r.color??'#17152e',0,0,w,h);
  for(const layer of r.parallax??[]){
    if(layer.foreground)continue;
    const image=art.images.get(layer.src);
    if(!image?.naturalWidth)continue;
    const height=layer.height??image.naturalHeight;
    const width=Math.max(1,Math.round(height*image.naturalWidth/image.naturalHeight));
    const y=Math.round((layer.y??0)-cam.y*(layer.speedY??0));
    if(y>=h||y+height<=0)continue;
    const x=Math.round(-cam.x*(layer.speedX??.45));
    ctx.save();
    ctx.globalAlpha=layer.alpha??1;
    if(layer.repeatX??true){
      const start=((x%width)+width)%width-width;
      for(let left=start;left<w;left+=width)ctx.drawImage(image,left,y,width,height);
    }else if(x<w&&x+width>0)ctx.drawImage(image,x,y,width,height);
    ctx.restore();
  }
  for(const beam of r.sunbeams===true?beams:r.sunbeams||[]){
    const x=Math.round(beam.x-cam.x*(beam.speedX??.35)),y=Math.round(beam.y-cam.y*(beam.speedY??0));
    const angle=(beam.angle??-28)*Math.PI/180, dx=-Math.sin(angle),dy=Math.cos(angle);
    const width=beam.width,length=beam.length??h*1.55;
    const g=ctx.createLinearGradient(x,y,x+dx*length,y+dy*length);
    g.addColorStop(0,beam.color??'#fff0b0');
    g.addColorStop(1,'rgba(255,235,165,0)');
    ctx.save();ctx.globalAlpha=beam.alpha??.19;ctx.fillStyle=g;
    ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+width,y);
    ctx.lineTo(Math.round(x+dx*length+width*1.75),Math.round(y+dy*length));
    ctx.lineTo(Math.round(x+dx*length-width*.5),Math.round(y+dy*length));ctx.closePath();ctx.fill();
    ctx.restore();
  }
}

export function drawTrailerForeground(ctx,r,art,cam,w,h){
  for(const layer of r.parallax??[]){
    if(!layer.foreground)continue;
    const image=art.images.get(layer.src);
    if(!image?.naturalWidth)continue;
    const height=layer.height??image.naturalHeight;
    const width=Math.max(1,Math.round(height*image.naturalWidth/image.naturalHeight));
    const y=Math.round((layer.y??h-height)-cam.y*(layer.speedY??0));
    if(y>=h||y+height<=0)continue;
    const x=Math.round(-cam.x*(layer.speedX??1.22));
    ctx.save();
    ctx.globalAlpha=layer.alpha??1;
    if(layer.repeatX??true){
      const start=((x%width)+width)%width-width;
      for(let left=start;left<w;left+=width)ctx.drawImage(image,left,y,width,height);
    }else if(x<w&&x+width>0)ctx.drawImage(image,x,y,width,height);
    ctx.restore();
  }
}
