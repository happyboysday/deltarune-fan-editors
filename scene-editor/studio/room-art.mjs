// Shared resolution for runtime, editor preview and combat art.
export function roomTiles(project,room){
  return (room.tiles??[]).map(t=>{
    const part=project.tileParts?.[t.part];
    const layer=t.layer??(t.front?'front':part?.layer??'back');
    const size=room.grid?.size??20;
    return {...part,...t,layer,w:t.w??(part?(part.cells?.[0]??1)*size:undefined),
      h:t.h??(part?(part.cells?.[1]??1)*size:undefined)};
  });
}

export function animation(assets,ref){
  const a=typeof ref==='string'?(assets?.[ref]??ref):ref;
  if(typeof a==='string')return {frames:[a]};
  return a?.frames?a:a?.src?{...a,frames:[a.src]}:null;
}

export function drawAnim(ctx,art,assets,ref,age,dir,x,y,loop=false,rect=null){
  const a=animation(assets,ref);
  if(!a?.frames?.length)return false;
  const i=Math.max(0,Math.floor(age/(a.ticks??(rect?8:4))));
  const src=a.frames[(a.loop??loop)?i%a.frames.length:Math.min(i,a.frames.length-1)];
  let img=art.images.get(src);
  if(!img&&typeof Image!=='undefined'){
    img=new Image();art.images.set(src,img);img.src=src;
  }
  if(!img?.naturalWidth)return false;
  const [dx,dy]=a.offset??[0,0],anchor=a.anchor??(rect?'topLeft':'feet');
  const zoom=a.scale??1,scale=dir*(a.flip?-1:1)*zoom;
  const w=rect?.w??img.naturalWidth,h=rect?.h??img.naturalHeight;
  const ox=anchor==='topLeft'?0:-w/2;
  const oy=anchor==='feet'?-h:anchor==='center'?-h/2:0;
  // Round the final sprite corner once. Odd-width frames may have half-pixel offsets.
  ctx.save();
  // Tile placements keep their anchor fixed within the unscaled room rectangle.
  if(rect){x-=ox;y-=oy;}
  ctx.translate(Math.round(x+zoom*dir*dx+scale*ox),Math.round(y+zoom*(dy+oy)));
  ctx.scale(scale,zoom);
  ctx.drawImage(img,0,0,w,h);
  ctx.restore();return true;
}
