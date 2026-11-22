export {roomTiles as dungeonTiles,animation,drawAnim} from '../../../room-art.mjs';
export function enemySpec(project,e){
  const type=project.enemyTypes?.[e.enemyType];
  if(!type)return e;
  const box=e.box??type.box;
  return {...type,...e,w:e.w??box?.w??20,h:e.h??box?.h??20};
}

export function fighterAnim(d){
  const f=d.fighter,a=f.anims??{},first=f.attacks?.[0]?.anim;
  switch(d.state){
    case 'attack':return d.swing?.attack.anim??first??a.idle;
    case 'airAttack':return f.airAttack?.anim??first??a.idle;
    case 'skill':return d.skill?.anim??first??a.idle;
    case 'dodge':return f.dodge?.anim??a.dodge??a.run??a.walk??a.idle;
    case 'run':return a.run??a.walk??a.idle;
    case 'fall':return a.fall??a.jump??a.idle;
    case 'down':return a.down??a.hurt??a.idle;
    default:return a[d.state]??a.idle;
  }
}

export function dungeonBox(d,p,r){
  if(!d?.fighter)return {x:p.x-r,y:p.y-r,w:2*r,h:2*r};
  const {w=2*r,h=2*r}=d.fighter.box??{};
  return {x:p.x-w/2,y:p.y-h,w,h};
}

export function relativeBox(p,dir,b){
  return {x:p.x+(dir>0?b.x:-b.x-b.w),y:p.y+b.y,w:b.w,h:b.h};
}
