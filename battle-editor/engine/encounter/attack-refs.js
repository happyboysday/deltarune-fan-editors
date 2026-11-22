// Shared attack dependencies for playback, preview, and the timeline.
export function collectAttackRefs(doc) {
  const names = new Set();
  const addCues = (list) => {
    if (!Array.isArray(list)) return;
    for (const cue of list) {
      if (!cue || typeof cue !== 'object') continue;
      if (cue.cmd === 'attack' && typeof cue.attack === 'string' && cue.attack) names.add(cue.attack);
      if (cue.cmd === 'if') {
        addCues(cue.then);
        addCues(cue.else);
      }
      if (cue.cmd === 'parallel') addCues(cue.cues);
    }
  };
  if (!doc || typeof doc !== 'object') return names;
  for (const turn of Array.isArray(doc.turns) ? doc.turns : []) {
    if (!turn || typeof turn !== 'object') continue;
    if (typeof turn.attack === 'string' && turn.attack) names.add(turn.attack);
    addCues(turn.start);
    addCues(turn.beforeAttack);
    addCues(turn.end);
  }
  const hooks = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
  for (const key of Object.keys(hooks)) addCues(hooks[key]);
  for (const enemy of Array.isArray(doc.enemies) ? doc.enemies : []) {
    if (!enemy || typeof enemy !== 'object') continue;
    addCues(enemy.onHurt);
    addCues(enemy.onSpare);
    addCues(enemy.onDefeat);
    for (const act of Array.isArray(enemy.acts) ? enemy.acts : []) addCues(act && act.cues);
  }
  for (const member of Array.isArray(doc.party) ? doc.party : []) {
    for (const spell of Array.isArray(member && member.spells) ? member.spells : []) {
      addCues(spell && spell.cues);
    }
  }
  return names;
}
