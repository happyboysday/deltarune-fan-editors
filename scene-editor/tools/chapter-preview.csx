using System;
using System.IO;
using System.Text.Json;
using UndertaleModLib.Models;
using UndertaleModLib.Compiler;
EnsureDataLoaded();
var config=JsonDocument.Parse(File.ReadAllText(Path.Combine(Environment.GetEnvironmentVariable("DIRECTOR_CHAPTER_WORK"),"preview.json"))).RootElement;
var prefix=Environment.GetEnvironmentVariable("DIRECTOR_CHAPTER_SAVE");
Data.GeneralInfo.Name=Data.Strings.MakeString(prefix);
Data.GeneralInfo.FileName=Data.Strings.MakeString(prefix);
var target=config.GetProperty("room").GetString();
if(Data.Rooms.ByName(target)==null)throw new Exception("Unknown room "+target);
var start="if (!audio_group_is_loaded(audio_sfx)) exit;\n";
start+="global.plot="+config.GetProperty("plot").GetDouble().ToString("R",System.Globalization.CultureInfo.InvariantCulture)+";\n";
start+="global.darkzone="+(config.TryGetProperty("dark",out var dark)&&dark.GetBoolean()?"1":"0")+";\n";
start+="global.char[1]="+config.GetProperty("second").GetInt32()+"; global.char[2]="+config.GetProperty("third").GetInt32()+";\n";
foreach(var flag in config.GetProperty("flags").EnumerateObject())
    start+="global.flag["+Int32.Parse(flag.Name)+"]="+flag.Value.GetInt32()+";\n";
var entry=config.GetProperty("entry").GetInt32();
if(config.TryGetProperty("platform",out var platform) && platform.GetBoolean())
    start+="global.start_in_platmode=1;\n";
start+="global.entrance="+entry+"; global.interact="+(entry>0?"3":"0")+"; room_goto("+target+");";
var group=new CodeImportGroup(Data);
group.QueueReplace(Data.Code.ByName("gml_Object_obj_initializer2_Step_0"),start);
group.Import();
