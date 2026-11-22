if (!variable_global_exists("plot")) exit;
var current_room = room_get_name(room);
var stamp = current_room + "|" + string(global.plot);
if (!variable_instance_exists(id, "director_prev_stamp") || director_prev_stamp != stamp) {
    director_prev_stamp = stamp;
    var route = file_text_open_append("director-route.tsv");
    file_text_write_string(route, string(current_time) + chr(9) + current_room + chr(9) + string(global.plot));
    file_text_writeln(route);
    file_text_close(route);
}
