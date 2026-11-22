export function navigationPanel(){
 const el=id=>document.getElementById(id);
 let rooms=[],nodes=[],bound=null,timer,active=false,epoch=0;
 const common={room_krisroom:'Kris 的卧室',room_krishallway:'家中走廊',room_torhouse:'家中一楼',room_town_krisyard:'自家庭院',room_town_north:'小镇北街',room_town_mid:'小镇中街',room_town_south:'小镇南街',room_town_school:'学校门口',room_schooldoor:'学校储物间前',room_schoollobby:'学校大厅'};
 const label=id=>common[id]||nodes.find(n=>n[1]===id)?.[0]||id;
 function targets(){
   const mode=el('navMode').value,g=el('navGoal'),prev=g.value;
   const options=nodes.filter(n=>rooms.some(r=>r.id===n[1]));
   const main=document.createElement('optgroup');main.label='主线节点';
   options.forEach(([label,key],i)=>main.append(new Option(label,mode==='route'?String(i):key)));
   const all=document.createElement('optgroup');all.label='全部房间';
   if(mode==='target')rooms.forEach(r=>all.append(new Option(label(r.id)===r.id?r.id:label(r.id)+' · '+r.id,r.id)));
   g.replaceChildren(main,...(mode==='target'?[all]:[]));el('navGoalLabel').hidden=mode==='explore';
   if([...g.options].some(o=>o.value===prev))g.value=prev;
   else if(g.options.length>1)g.selectedIndex=1;
 }
 function render(v){
   active=v.active;
   el('navStart').disabled=active||v.state==='unavailable';el('navStop').disabled=!active;el('navResume').hidden=!v.canResume;
   const info=v.state==='idle'?'进入可行走的场景后开始。试玩画布内按方向键即可接管。':v.note;
   if(el('navInfo').textContent!==info)el('navInfo').textContent=info;
   el('navRoute').textContent=[v.room&&'当前：'+label(v.room),v.route?.length&&'路线：'+v.route.slice(0,6).map(label).join(' → '),v.visited?.length&&'本次经过 '+v.visited.length+' 个房间'].filter(Boolean).join('　');
 }
 function detach(){++epoch;clearTimeout(timer);bound=null;active=false;render({state:'idle',active:false})}
 async function tick(token){
   if(token!==epoch||!bound)return;
   try{const r=await bound.api('navigator');if(token===epoch)render(r)}catch(e){if(token===epoch)el('navInfo').textContent=e.message}
   if(token===epoch)timer=setTimeout(()=>tick(token),650)
 }
 el('navMode').onchange=targets;
 async function action(command){
   if(!bound)return;
   const {api,pid,focus}=bound,tag=epoch,mode=el('navMode').value;
   const goals=mode==='target'?[el('navGoal').value]:mode==='route'?nodes.filter(n=>rooms.some(r=>r.id===n[1])).slice(Number(el('navGoal').value)).map(([name,room,,spec])=>spec?{room,name,...spec}:room):[];
   try{const result=await api('navigator',{command,pid,mode,goals,dialogue:el('navTalk').checked,firstChoice:el('navChoice').checked});
     if(tag===epoch){render(result);focus()}}
   catch(e){if(tag===epoch)el('navInfo').textContent=e.message}
 }
 el('navStart').onclick=()=>action('start');el('navResume').onclick=()=>action('resume');el('navStop').onclick=()=>action('stop');
 window.addEventListener('pagehide',()=>{if(bound)navigator.sendBeacon('/api/studio/chapters/'+bound.chapter+'/navigator',
   new Blob([JSON.stringify({command:'stop',pid:bound.pid})],{type:'application/json'}))});
 return {configure(rs,ns){rooms=rs;nodes=ns;targets()},attach(chapter,pid,api,focus){detach();bound={chapter,pid,api,focus};tick(epoch)},detach};
}
