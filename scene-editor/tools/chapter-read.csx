#r "System.IO.Compression.dll"
using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Linq;
using System.Collections.Generic;
using UndertaleModLib.Models;
using UndertaleModLib.Util;

EnsureDataLoaded();
var dir=Environment.GetEnvironmentVariable("DIRECTOR_CHAPTER_WORK");
Directory.CreateDirectory(dir);
string N(UndertaleNamedResource r)=>r?.Name?.Content;
var ctx=new GlobalDecompileContext(Data);
var failed=new Dictionary<string,string>();
var names=new List<string>();
var roots=Data.Code.Where(c=>c.ParentEntry==null).ToList();
using(var zip=new ZipArchive(File.Create(Path.Combine(dir,"scripts.zip")),ZipArchiveMode.Create)){
    foreach(var code in roots){
        var name=N(code);
        try{
            var text=new Underanalyzer.Decompiler.DecompileContext(ctx,code,Data.ToolInfo.DecompilerSettings).DecompileToString();
            using var stream=zip.CreateEntry(name+".gml",CompressionLevel.Fastest).Open();
            using var writer=new StreamWriter(stream,new UTF8Encoding(false));
            writer.Write(text);
            names.Add(name);
        } catch(Exception e){failed[name]=e.Message;}
    }
}
var objects=Data.GameObjects.ToDictionary(N,o=>new{
    parent=N(o.ParentId),sprite=N(o.Sprite),
    events=o.Events.SelectMany(list=>list).SelectMany(ev=>ev.Actions)
                .Where(action=>action.CodeId!=null).Select(action=>N(action.CodeId)).Distinct().ToArray()
});
var rooms=Data.Rooms.Select(room=>{
    var layers=room.Layers.Where(l=>l.LayerType==UndertaleRoom.LayerType.Instances)
      .SelectMany(l=>l.InstancesData.Instances.Select(i=>(i.InstanceID,l.LayerName.Content))).ToDictionary(p=>p.InstanceID,p=>p.Content);
    return new{id=N(room),w=room.Width,h=room.Height,creation=N(room.CreationCodeId),
        instances=room.GameObjects.Select(i=>new{id=i.InstanceID,obj=N(i.ObjectDefinition),x=i.X,y=i.Y,
                  sx=i.ScaleX,sy=i.ScaleY,angle=i.Rotation,init=N(i.CreationCode),pre=N(i.PreCreateCode),layer=layers.GetValueOrDefault(i.InstanceID)}).ToArray()};
}).ToArray();
File.WriteAllText(Path.Combine(dir,"index.json"),JsonSerializer.Serialize(new{rooms,objects,scripts=names,failed,codeEntries=Data.Code.Count}));
Console.WriteLine($"Indexed {rooms.Length} rooms, {objects.Count} objects, {names.Count}/{roots.Count} scripts");

