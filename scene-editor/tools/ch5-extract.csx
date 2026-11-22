using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using UndertaleModLib.Models;
using UndertaleModLib.Util;

EnsureDataLoaded();
var target=Environment.GetEnvironmentVariable("DR_CH5_OUTPUT");
Directory.CreateDirectory(target);
var gml=Path.Combine(target,"gml");
Directory.CreateDirectory(gml);
object P(object obj,string name)=>obj?.GetType().GetProperty(name)?.GetValue(obj);
string N(object obj)=>obj is UndertaleString s?s.Content:(P(obj,"Name") as UndertaleString)?.Content;
string FirstCode(object obj,params string[] props)=>props.Select(p=>N(P(obj,p))).FirstOrDefault(v=>v!=null);
var wanted=new HashSet<string>();
var sourceObjects=new HashSet<string>();
var roomFacts=new List<object>();
foreach(var room in Data.Rooms) {
    string key=N(room);
    string creation=FirstCode(room,"CreationCode","CreationCodeId");
    if(creation!=null)wanted.Add(creation);
    var seen=new HashSet<uint>();
    var instances=new List<object>();
    void Add(UndertaleRoom.GameObject instance, string layer, int? depth) {
        if(instance==null||instance.ObjectDefinition==null||!seen.Add(instance.InstanceID))return;
        var obj=instance.ObjectDefinition;
        string name=N(obj);
        sourceObjects.Add(name);
        string init=FirstCode(instance,"CreationCode","CreationCodeId");
        string pre=FirstCode(instance,"PreCreateCode","PreCreateCodeId");
        if(init!=null)wanted.Add(init);
        if(pre!=null)wanted.Add(pre);
        instances.Add(new {id=instance.InstanceID,name,layer,depth,x=instance.X,y=instance.Y,
          sx=instance.ScaleX,sy=instance.ScaleY,rotation=instance.Rotation,
          color=P(instance,"Colour"),frame=P(instance,"ImageIndex"),
          init,pre});
    }
    if(room.Layers!=null)foreach(var layer in room.Layers) {
        if(layer.LayerType==UndertaleRoom.LayerType.Instances && layer.InstancesData?.Instances!=null)
            foreach(var instance in layer.InstancesData.Instances)Add(instance,N(layer),layer.LayerDepth);
    }
    foreach(var instance in room.GameObjects)Add(instance,null,null);
    roomFacts.Add(new {id=key,w=room.Width,h=room.Height,creation,instances});
}
var result=new Dictionary<string,object>();
var placedPrefixes=new HashSet<string>();
foreach(var obj in Data.GameObjects) {
    string name=N(obj),parent=N(P(obj,"ParentId"))??N(P(obj,"Parent"));
    var sprite=obj.Sprite;
    var mask=(P(obj,"TextureMaskId") as UndertaleSprite)??(P(obj,"MaskSprite") as UndertaleSprite)??sprite;
    object Bounds(UndertaleSprite sp)=>sp==null?null:new {name=N(sp),w=sp.Width,h=sp.Height,ox=sp.OriginX,oy=sp.OriginY,l=sp.MarginLeft,r=sp.MarginRight,t=sp.MarginTop,b=sp.MarginBottom};
    result[name]=new {parent,sprite=Bounds(sprite),mask=Bounds(mask),solid=P(obj,"Solid"),visible=P(obj,"Visible"),persistent=P(obj,"Persistent")};
}
foreach(var obj in Data.GameObjects) {
    var entry=obj;
    for(int i=0;i<32&&entry!=null;i++){
        string n=N(entry);
        if(sourceObjects.Contains(N(obj)))placedPrefixes.Add(n);
        entry=(P(entry,"ParentId")??P(entry,"Parent")) as UndertaleGameObject;
    }
}
var names=Data.Code.Select(c=>N(c)).Where(n=>n!=null).ToArray();
File.WriteAllText(Path.Combine(target,"facts.json"),JsonSerializer.Serialize(new{rooms=roomFacts,objects=result,names}));
File.WriteAllLines(Path.Combine(target,"reflect.txt"),new [] { string.Join(" ",typeof(UndertaleRoom.GameObject).GetProperties().Select(p=>p.Name)), string.Join(" ",typeof(UndertaleRoom).GetProperties().Select(p=>p.Name)),string.Join(" ",typeof(UndertaleGameObject).GetProperties().Select(p=>p.Name)) });
Console.WriteLine("Wrote room facts: "+roomFacts.Count+", placed object types: "+sourceObjects.Count);
var ctx=new GlobalDecompileContext(Data);
var failures=new List<string>();
int count=0;
var events=new Regex(@"^gml_Object_(.*)_(?:Create|PreCreate|Step|Other|Collision|Alarm|Draw|Destroy|KeyPress|Mouse)_(?:[0-9]+|obj_.*)$");
var global=new Regex(@"^gml_(?:GlobalScript|Script)_scr_(?:text|texts|talk|cutscene|room|door|interact|overworld|water|climb|short|save|heal|party|ch5|flagg|music|sound|move|transition|fade).*");
foreach(var code in Data.Code) {
    if(code.ParentEntry!=null)continue;
    string name=N(code);
    var match=events.Match(name);
    if(!(wanted.Contains(name)||name.StartsWith("gml_Room")||global.IsMatch(name)||(match.Success&&placedPrefixes.Contains(match.Groups[1].Value))))continue;
    try {
        var output=new Underanalyzer.Decompiler.DecompileContext(ctx,code,Data.ToolInfo.DecompilerSettings).DecompileToString();
        File.WriteAllText(Path.Combine(gml,name+".gml"),output);
        count++;
    } catch(Exception e) {
        failures.Add(name+"\t"+e.GetType().Name+"\t"+e.Message.Replace("\n"," "));
    }
}
File.WriteAllLines(Path.Combine(target,"decompile-errors.tsv"),failures);
Console.WriteLine("Decompiled: "+count+"; failures: "+failures.Count);

