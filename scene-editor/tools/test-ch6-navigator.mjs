/**
 * Automated test runner using the REAL built-in AI Auto-Navigator (studio/scene-navigator.mjs)
 * with Chapter 6 scene-specific interaction rules (project.navScript).
 *
 * Tests whether the AI Auto-Navigator can autonomously pathfind & play through the ENTIRE
 * 9-room Chapter 6 map from Opening (lw_shelter_door) to Grand Magic Show Curtain Call (b5_fountain_hall)!
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateProject } from '../studio/format.mjs';
import { createWorld } from '../studio/world.mjs';
import { createSceneNavigator } from '../studio/scene-navigator.mjs';
import { copyProjects, requireData } from './test-env.mjs';

requireData('projects/ch6-deep-shelter.scene.json');
const projects = copyProjects();
const PROJ_FILE = path.join(projects, 'ch6-deep-shelter.scene.json');
const REPORT_FILE = path.join(projects, 'ch6-deep-shelter.ai-nav-report.json');

const project = JSON.parse(fs.readFileSync(PROJ_FILE, 'utf8'));
const check = validateProject(project);
if (!check.ok) {
  console.error('Schema validation failed:', check.errors);
  process.exit(1);
}

const world = createWorld(project, { validated: true });
const s = world.state;
const statusLog = [];
const nav = createSceneNavigator((msg, active) => {
  statusLog.push({ tick: s.tick, room: s.room, active, msg });
});

nav.start('__script__');

const MAX_TICKS = 18000; // 10 minutes of 30Hz game time ceiling
const battlesCleared = [];
const visitedAll = new Set();

for (let t = 0; t < MAX_TICKS; t++) {
  visitedAll.add(s.room);
  // If AI reached a real battle encounter, simulate peaceful SPARE outcome and resume AI!
  if (s.battle) {
    const bId = s.battle.id;
    battlesCleared.push({ tick: s.tick, room: s.room, battle: bId, result: 'spared' });
    console.log(`[tick ${s.tick}] AI reached real battle '${bId}' in ${s.room} -> settling 'spared' & resuming AI...`);
    world.completeBattle(s.battle.serial, { result: 'spared' });
    nav.start('__script__');
  }
  if (!nav.active) break;
  const input = nav.step(world);
  world.step(input);
  visitedAll.add(s.room);
}

const visitedUnique = [...visitedAll];
const allRoomIds = Object.keys(project.rooms);
const missingRooms = allRoomIds.filter(r => !visitedUnique.includes(r));
const lastNote = statusLog.at(-1)?.msg ?? '';
const completed = !!s.flags.doppel_recruited && missingRooms.length === 0;

const report = {
  project: project.id,
  title: project.title,
  completed,
  totalTicks: s.tick,
  simulatedSeconds: Number((s.tick / 30).toFixed(1)),
  finalRoom: s.room,
  lastStatus: lastNote,
  roomsTotal: allRoomIds.length,
  roomsVisitedCount: visitedUnique.length,
  visitedRooms: visitedUnique,
  missingRooms,
  battlesCleared,
  finalFlags: s.flags,
  finalInventory: s.inventory,
  aiEvents: statusLog,
};
fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log('\n=== AI AUTO-NAVIGATOR FULL MAP TEST SUMMARY ===');
console.log(`Completed: ${completed} | Ticks: ${s.tick} (${report.simulatedSeconds}s) | Final Room: ${s.room}`);
console.log(`Visited (${visitedUnique.length}/${allRoomIds.length}): ${visitedUnique.join(' -> ')}`);
if (missingRooms.length) console.log('Missing rooms:', missingRooms);
console.log(`Battles triggered & cleared: ${battlesCleared.map(b => b.battle).join(', ')}`);
console.log('Last AI message:', lastNote);
console.log('Saved report ->', REPORT_FILE);

if (!completed) {
  console.log('\nLast 15 AI status entries:');
  for (const row of statusLog.slice(-15)) console.log(`  [${row.tick}] (${row.room}) ${row.msg}`);
  process.exit(1);
}
