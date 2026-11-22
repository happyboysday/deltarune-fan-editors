export function drawLight({ctx,entity:e,tick}){
  const x=e.x+e.w/2,y=e.y+e.h/2+Math.round(Math.sin(tick/6)*2);
  ctx.fillStyle='#e7ffc0';ctx.fillRect(x-4,y-1,8,2);ctx.fillRect(x-1,y-4,2,8);
  ctx.fillStyle='#90bf47';ctx.fillRect(x-1,y-1,2,2);
}
