// Observation for the workbench. No writes to player position, plot, or game inputs.
if (!variable_instance_exists(id,"director_nav_prefix")) {
    director_nav_prefix = "";
    for (var ni=1; ni<=parameter_count(); ni++) {
        var arg=parameter_string(ni);
        if (string_pos("director_nav_",arg)==1) director_nav_prefix=arg;
    }
    director_nav_due=0;
    director_nav_grid="";
}
if (director_nav_prefix=="" || current_time<director_nav_due) exit;
var stem=director_nav_prefix;
if (!file_exists(stem+".on")) {
    director_nav_due=current_time+350;
    director_nav_grid="";
    exit;
}
director_nav_due=current_time+65;
var avatar=instance_find(obj_mainchara,0);
var plat_type=asset_get_index("obj_plat_player");
var plat=noone;
if (plat_type!=-1) plat=instance_find(plat_type,0);
var isplat=(plat!=noone && plat.visible);
if (isplat) avatar=plat;
var dash_type=asset_get_index("obj_mainchara_dash");
var climb_type=asset_get_index("obj_climb_kris");
var alternate=[];
if (!isplat && dash_type!=-1 && instance_exists(dash_type)) {
    avatar=instance_find(dash_type,0);
    var look=sign(avatar.image_xscale)*clamp(abs(avatar.hspeed)*5+24,40,145);
    var water=asset_get_index("obj_waterpit"), fixed=asset_get_index("obj_solidblocksized_dash");
    var lanes=[];
    for (var lane=-1;lane<=1;lane++) {
        var ly=avatar.bbox_bottom-3+lane*38;
        var x1=avatar.x+look*.2, x2=avatar.x+look;
        var hit=(collision_line(x1,ly,x2,ly,obj_solidblock,true,true)!=noone);
        if (water!=-1 && !avatar.jumping) hit=hit || collision_line(x1,ly,x2,ly,water,true,true)!=noone;
        if (fixed!=-1) hit=hit || collision_line(x1,ly,x2,ly,fixed,true,true)!=noone;
        array_push(lanes,!hit);
    }
    alternate=["laneDash",avatar.disable_control || avatar.impacted || avatar.stopping || avatar.drown,lanes,sign(avatar.image_xscale)];
} else if (!isplat && climb_type!=-1 && instance_exists(climb_type)) {
    avatar=instance_find(climb_type,0);
    alternate=["climb"];
}
var ischoice=(instance_exists(obj_choicer_neo) || instance_exists(obj_choicer_old));
var isdialog=instance_exists(obj_dialoguer);
// Some cutscenes (e.g. the fountain) use an independent writer, without a dialogue box.
if (!isdialog && global.interact!=0 && instance_exists(obj_writer)) {
    with (obj_writer) if (halt>0 && !disablebutton1) isdialog=true;
}
var platdialog=asset_get_index("obj_dialoguer_plat");
if (platdialog!=-1 && instance_exists(platdialog)) isdialog=true;
var navroom=room_get_name(room);
var st=[navroom,current_time,global.plot,room_width,room_height,global.interact,isdialog,ischoice,instance_exists(obj_battlecontroller),isplat,false,[],false,0,[]];
if (avatar!=noone) {
    var px=(avatar.bbox_left+avatar.bbox_right)/2;
    var py=(avatar.bbox_top+avatar.bbox_bottom)/2;
    st[10]=[px,py,(avatar.bbox_right-avatar.bbox_left)/2,(avatar.bbox_bottom-avatar.bbox_top)/2];
    if (!isplat && variable_instance_exists(avatar,"freeze") && avatar.freeze) st[5]=1;
    if (isplat) {
        st[12]=avatar.grounded;
        st[13]=avatar.hspeed;
        var terrain=[];
        var floor_type=asset_get_index("obj_plat_floor");
        var block_type=asset_get_index("obj_plat_block");
        var speed_look=clamp(abs(avatar.hspeed)*5+28,28,190);
        var foot=avatar.bbox_bottom;
        for (var side=-1;side<=1;side+=2) {
            var ahead=px+side*(st[10][2]+speed_look);
            var nearx=px+side*(st[10][2]+14);
            var groundahead=false;
            var wall=false;
            if (floor_type!=-1) groundahead=(collision_line(ahead,foot-8,ahead,foot+48,floor_type,true,true)!=noone);
            if (block_type!=-1) {
                groundahead=groundahead || (collision_line(ahead,foot-8,ahead,foot+48,block_type,true,true)!=noone);
                wall=(collision_line(nearx,foot-14,nearx,foot-3,block_type,true,true)!=noone);
            }
            array_push(terrain,[groundahead,wall]);
        }
        st[14]=[terrain[0],terrain[1],global.flag[25],avatar.vspeed,avatar.can_jump,avatar.dashing];
    }
    var geo=room_get_name(room)+"|"+string(floor(st[10][2]))+"|"+string(floor(st[10][3]));
    if (!isplat && array_length(alternate)==0 && (director_nav_grid!=geo || file_exists(stem+".refresh"))) {
        var cell=8;
        while (ceil(room_width/cell)*ceil(room_height/cell)>42000) cell+=4;
        var cols=ceil(room_width/cell)+1;
        var rows=ceil(room_height/cell)+1;
        var mask=[];
        with (avatar) {
            for (var ry=0;ry<rows;ry++) {
                var rowstr="";
                for (var rx=0;rx<cols;rx++) {
                    rowstr += place_meeting(x+rx*cell-px,y+ry*cell-py,obj_solidblock) ? "#" : ".";
                }
                array_push(mask,rowstr);
            }
        }
        var gf=file_text_open_write(stem+".grid");
        file_text_write_string(gf,json_stringify([navroom,cell,mask,current_time]));
        file_text_close(gf);
        director_nav_grid=geo;
        if (file_exists(stem+".refresh")) file_delete(stem+".refresh");
    }
}
var found=[];
with (obj_doorparent) {
    var dest="";
    if (variable_instance_exists(id,"doorRoom") && room_exists(doorRoom)) dest=room_get_name(doorRoom);
    array_push(found,[object_get_name(object_index),x,y,bbox_left,bbox_top,bbox_right,bbox_bottom,dest]);
}
with (obj_darkdoor) {
    array_push(found,[object_get_name(object_index),x,y,bbox_left,bbox_top,bbox_right,bbox_bottom,""]);
}
st[11]=found;
// The costume editor is an interactive menu, not a cutscene with a dialogue box.
var fit_asset=asset_get_index("obj_ch5_LW07_thrashfit_menu");
var special=[];
if (fit_asset!=-1) {
    var fit=instance_find(fit_asset,0);
    if (fit!=noone && fit._menu_state>0 && (fit._input_enabled || fit._menu_state==2) && array_length(fit._columns)>1) {
        special=["outfit",fit._menu_state,fit._columns_index,fit._row_index,array_length(fit._columns[1])-1,fit._confirm_options_index];
    }
}
var motion_type=asset_get_index("obj_ch5_LW21");
if (array_length(special)==0 && motion_type!=-1 && instance_exists(motion_type)) {
    var ctl=instance_find(motion_type,0);
    if (ctl.con==4) special=["motionCue","right"];
}
st[15]=special;
var triggers=[];
with (obj_trigger) {
    if (variable_instance_exists(id,"extflag") && is_string(extflag) && extflag!="")
        array_push(triggers,[extflag,bbox_left,bbox_top,bbox_right,bbox_bottom]);
}
st[16]=triggers;
st[17]=alternate;
var cutscene_asset=asset_get_index("obj_cutscene_master");
var workstep=[];
if (cutscene_asset!=-1 && instance_exists(cutscene_asset)) {
    var cut=instance_find(cutscene_asset,0);
    if (variable_instance_exists(cut,"current_command"))
        workstep=[string(cut.id),cut.current_command];
}
st[18]=workstep;
var sf=file_text_open_write(stem+".state");
file_text_write_string(sf,json_stringify(st));
file_text_close(sf);
