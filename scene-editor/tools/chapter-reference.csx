using System;
using System.IO;
using System.Text.Json;
using UndertaleModLib.Models;
using UndertaleModLib.Compiler;
EnsureDataLoaded();
// Reference build starts at the installed game and only adapts the desktop boundary.
var name=Environment.GetEnvironmentVariable("DIRECTOR_CHAPTER_SAVE");
Data.GeneralInfo.Name=Data.Strings.MakeString(name);
Data.GeneralInfo.FileName=Data.Strings.MakeString(name);
Data.GeneralInfo.DisplayName=Data.Strings.MakeString(name);
var import=new CodeImportGroup(Data);
var overrides=Path.Combine(Environment.GetEnvironmentVariable("DIRECTOR_CHAPTER_WORK"),"reference-overrides.json");
bool authoredMenu=false;
if(File.Exists(overrides)) {
    using var edited=JsonDocument.Parse(File.ReadAllText(overrides));
    foreach(var change in edited.RootElement.EnumerateObject()) {
        import.QueueReplace(Data.Code.ByName(change.Name),change.Value.GetString());
        if(change.Name=="gml_GlobalScript_scr_chapterswitch") authoredMenu=true;
    }
}
var callback=Data.GameObjects.ByName("obj_time").EventHandlerFor(EventType.Step,2u,Data);
if(callback.Instructions.Count!=0)throw new Exception("Observer would replace an existing event");
import.QueueReplace(callback,File.ReadAllText(Path.Combine(Environment.GetEnvironmentVariable("DIRECTOR_CHAPTER_TOOLS"),"chapter-observe.gml")));
if(!authoredMenu) import.QueueReplace(Data.Code.ByName("gml_GlobalScript_scr_chapterswitch"),"function scr_chapterswitch(arg0=0) { var f=file_text_open_write(\"director-next.txt\"); file_text_write_string(f,string(arg0)); file_text_close(f); game_end(); }");
import.Import();
