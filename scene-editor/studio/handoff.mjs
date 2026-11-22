
async function store(mode,fn){
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('director-v05',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('inbox');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('inbox',mode),req=fn(tx.objectStore('inbox'));
      tx.oncomplete=()=>resolve(req.result);
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error??new Error('交接已取消'));
    });
  }finally{db.close();}
}
export const handoffWrite=(key,data)=>store('readwrite',s=>s.put(data,key));
export const handoffRead=key=>store('readwrite',s=>{
  const r=s.get(key);r.onsuccess=()=>s.delete(key);return r;
});
