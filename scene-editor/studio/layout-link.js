
(() => {
  const bar=document.createElement('div');
  Object.assign(bar.style,{position:'fixed',zIndex:'50',right:'14px',bottom:'12px',padding:'8px',background:'#202235',border:'1px solid #776ca7',borderRadius:'6px',display:'flex',gap:'8px'});
  const home=document.createElement('a');home.textContent='← 玩法工作台';home.href='/?from=return';home.style.color='#dbd0ff';
  const button=document.createElement('button');button.textContent='把当前布景送到玩法工作台';
  button.onclick=async()=>{
    try{
      const map=window.DirectorV05Layout();
      // IndexedDB avoids the small Web Storage quota on tile-heavy rooms.
      const db=await new Promise((resolve,reject)=>{
        const req=indexedDB.open('director-v05',1);
        req.onupgradeneeded=()=>req.result.createObjectStore('inbox');
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('inbox','readwrite');tx.objectStore('inbox').put(map,'layout');
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
      db.close();location.href='/?from=layout';
    }catch(ex){alert('无法交接布景：'+ex.message+'。可以先用布景编辑器导出 JSON，再导入玩法工作台。');}
  };
  bar.append(home,button);document.body.append(bar);
})();
