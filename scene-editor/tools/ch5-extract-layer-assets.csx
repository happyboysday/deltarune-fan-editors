using System;
using System.Linq;
using System.IO;
using System.Text.Json;
using UndertaleModLib.Models;

EnsureDataLoaded();
var output=Environment.GetEnvironmentVariable("DR_CH5_OUTPUT");
object P(object o,string k)=>o?.GetType().GetProperty(k)?.GetValue(o);
string N(object o)=>(o as UndertaleString)?.Content??(P(o,"Name") as UndertaleString)?.Content;
var results=Data.Rooms.ToDictionary(r=>N(r),r=>r.Layers
 .Where(l=>l.LayerType==UndertaleRoom.LayerType.Assets&&l.AssetsData?.Sprites!=null&&l.AssetsData.Sprites.Count>0)
 .Select(l=>new {layer=l.LayerName.Content,id=l.LayerId,depth=l.LayerDepth,visible=l.IsVisible, x=l.XOffset,y=l.YOffset,
    sprites=l.AssetsData.Sprites.Select(s=>new {name=N(s),sprite=N(P(s,"Sprite"))??N(P(s,"SpriteIndex")),
      x=P(s,"X"),y=P(s,"Y"),sx=P(s,"ScaleX"),sy=P(s,"ScaleY"),
      frame=P(s,"FrameIndex")??P(s,"ImageIndex"),angle=P(s,"Rotation"),color=P(s,"Color"),
      speed=P(s,"AnimationSpeed"),speedType=P(s,"AnimationSpeedType")?.ToString()}).ToArray()}).ToArray());
File.WriteAllText(Path.Combine(output,"asset-layers.json"),JsonSerializer.Serialize(results));
var instance=Data.Rooms.SelectMany(r=>r.Layers).First(l=>l.AssetsData?.Sprites?.Count>0).AssetsData.Sprites[0];
Console.WriteLine("Sprite fields: "+string.Join(" ",instance.GetType().GetProperties().Select(p=>p.Name)));
Console.WriteLine("Asset sprites: "+results.Values.Sum(r=>r.Sum(l=>l.sprites.Length)));

