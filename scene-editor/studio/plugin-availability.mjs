import {resolvePlugins} from './plugin-manifest.mjs';

export function pluginIssues(requested, entries, loaded){
  const available=new Map(), errors=[];
  for(const entry of entries){
    const id=entry.manifest?.id??entry.directory;
    if(available.has(id))continue;
    available.set(id,entry.enabled===false
      ?{...entry,errors:['已停用。请在插件管理中启用 '+id+' 后重新打开工程。']}
      :entry);
  }
  const resolved=resolvePlugins(requested,available,message=>errors.push(message.includes('缺少插件 ')
    ?message+'。请在插件管理中安装后重新打开工程。':message));
  for(const {manifest} of resolved){
    const version=loaded?.get(manifest.id)?.manifest.version;
    if(version&&version!==manifest.version)errors.push('插件 '+manifest.id+' 已从 '+version+' 变为 '+manifest.version+'。');
  }
  return errors;
}
