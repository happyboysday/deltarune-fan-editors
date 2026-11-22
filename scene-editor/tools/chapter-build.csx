using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Text.Json;
using UndertaleModLib.Models;
using UndertaleModLib.Compiler;

EnsureDataLoaded();
var root=Environment.GetEnvironmentVariable("DIRECTOR_CHAPTER_WORK");
var prefix=Environment.GetEnvironmentVariable("DIRECTOR_CHAPTER_SAVE");
var manifest=JsonDocument.Parse(File.ReadAllText(Path.Combine(root,"index.json"))).RootElement;
var changes=JsonDocument.Parse(File.ReadAllText(Path.Combine(root,"build-edits.json"))).RootElement;
Data.GeneralInfo.Name=Data.Strings.MakeString(prefix);
Data.GeneralInfo.FileName=Data.Strings.MakeString(prefix);
Data.GeneralInfo.DisplayName=Data.Strings.MakeString(prefix);
var records=manifest.GetProperty("rooms").EnumerateArray().ToDictionary(r=>r.GetProperty("id").GetString());
var patches=changes.GetProperty("instances");
int count=0;
foreach(var room in Data.Rooms){
    var rec=records[room.Name.Content];
    var instances=room.GameObjects;
    int slot=0;
    var source=rec.GetProperty("instances");
    if(instances.Count!=source.GetArrayLength())throw new Exception("Instance table mismatch: "+room.Name.Content);
    foreach(var item in source.EnumerateArray()){
        var id=item.GetProperty("id").GetUInt32();
        var inst=instances[slot++];
        if(inst.InstanceID!=id) throw new Exception("Instance order changed "+room.Name.Content);
        if(inst.ObjectDefinition.Name.Content!=item.GetProperty("obj").GetString())throw new Exception("Object binding mismatch "+id);
        var xy=patches.TryGetProperty(room.Name.Content+"/"+(slot-1),out var edit)?edit:item;
        inst.X=xy.GetProperty("x").GetInt32(); inst.Y=xy.GetProperty("y").GetInt32();
        inst.ScaleX=item.GetProperty("sx").GetSingle(); inst.ScaleY=item.GetProperty("sy").GetSingle();
        inst.Rotation=item.GetProperty("angle").GetSingle();
        count++;
    }
}
var group=new CodeImportGroup(Data);
foreach(var sc in changes.GetProperty("scripts").EnumerateObject()){
    var code=Data.Code.ByName(sc.Name);
    if(code==null||code.ParentEntry!=null)throw new Exception("Not a root script: "+sc.Name);
    group.QueueReplace(code,sc.Value.GetString());
}
var time=Data.GameObjects.ByName("obj_time");
var audit=time.EventHandlerFor(EventType.Step,2u,Data);
if(audit.Instructions.Count!=0)throw new Exception("Original End Step in use; use a separate observer");
group.QueueReplace(audit,File.ReadAllText(Path.Combine(Environment.GetEnvironmentVariable("DIRECTOR_CHAPTER_TOOLS"),"chapter-observe.gml")));
if(!changes.GetProperty("scripts").TryGetProperty("gml_GlobalScript_scr_chapterswitch",out var userSwitch)){
    group.QueueReplace(Data.Code.ByName("gml_GlobalScript_scr_chapterswitch"),
        "function scr_chapterswitch(arg0=0) { var f=file_text_open_write(\"director-next.txt\"); file_text_write_string(f,string(arg0)); file_text_close(f); game_end(); }");
}
group.Import();
File.WriteAllText(Path.Combine(root,"compiled.json"),JsonSerializer.Serialize(new {rooms=records.Count,instances=count,prefix,edits=changes.GetProperty("scripts").EnumerateObject().Count()}));
