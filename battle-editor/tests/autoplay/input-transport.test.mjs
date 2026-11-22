import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { demoInputToSimulation } from '../../editor/demo-path.js';
import { createAutopilot, createRecorder, decodeInputs, generateDemoPath, traceDemo } from '../../engine/autoplay/index.js';
import { parseEncodedInputs } from '../../engine/autoplay/soul.js';
import { createEncounter } from '../../engine/encounter/index.js';
import { createBattle } from '../../engine/index.js';
import { createInput, normalizeFrameInput } from '../../engine/input.js';

function key(host, type, code, repeat = false) {
  host.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat }));
}

const readSample = (name) => JSON.parse(readFileSync(new URL(`../../samples/${name}.json`, import.meta.url)));

test('keyboard frames consume an edge once, keep held actions, and clear on blur', () => {
  const host = new EventTarget();
  const keyboard = createInput(host);
  key(host, 'keydown', 'KeyV');
  key(host, 'keydown', 'KeyB');
  key(host, 'keydown', 'ArrowRight');
  const first = keyboard.readFrame();
  assert.equal(first.dx, 1);
  assert.deepEqual(first.press, ['right', 'dash', 'shoot']);
  assert.equal(first.hold.dash, true);
  assert.equal(first.hold.shoot, true);
  key(host, 'keydown', 'KeyV', true);
  key(host, 'keydown', 'KeyB', true);
  assert.deepEqual(keyboard.readFrame().press, []);
  assert.equal(keyboard.readFrame().hold.shoot, true);

  key(host, 'keyup', 'KeyV');
  key(host, 'keydown', 'KeyV');
  key(host, 'keyup', 'KeyV');
  const tapped = keyboard.readFrame();
  assert.deepEqual(tapped.press, ['dash']);
  assert.equal(tapped.hold.dash, false);

  host.dispatchEvent(new Event('blur'));
  key(host, 'keydown', 'KeyZ', true);
  const afterBlur = keyboard.readFrame();
  assert.equal(afterBlur.dx, 0);
  assert.equal(afterBlur.hold.shoot, false);
  assert.deepEqual(afterBlur.press, []);
  keyboard.destroy();
});

test('v2 recording retains new actions and axis overrides through editor and encounter replay', async () => {
  const recorder = createRecorder();
  recorder.push(0, { dx: -1, press: ['dash', 'shoot', 'custom.action'], hold: { shoot: true, right: true } });
  recorder.push(1, { dx: -1, hold: { shoot: true, right: true } });
  recorder.push(2, { dx: -1, hold: { shoot: true, right: true } });
  const encoded = recorder.toString();
  assert.match(encoded, /^v2:/);
  assert.deepEqual(decodeInputs(encoded).map(({ frame }) => frame), [0, 3]);
  assert.equal(parseEncodedInputs('v2:[[0,[true],[]]]').errors.length, 1);
  assert.deepEqual(decodeInputs('0:R!z;3:'), [
    { frame: 0, hold: { right: true }, press: ['confirm'] }, { frame: 3, hold: {}, press: [] },
  ]);

  const attack = { ...readSample('arena-stage'), demo: { mode: 'inputs', inputs: encoded } };
  const encounterDoc = readSample('encounters/arena-tour');
  encounterDoc.demo.turns[0].dodge = 'inputs';
  const pilot = createAutopilot({ kind: 'encounter', doc: encounterDoc, resolveAttackDoc: () => attack });
  const standalone = createAutopilot({ kind: 'attack', doc: attack });
  const encounter = createEncounter({ canvas: null, resolveAttack: () => attack });
  await encounter.load(encounterDoc);
  await pilot.ready;
  const sim = encounter.debug.startAttack('arena-stage').sim;
  const received = [];
  const stepFrame = sim.stepFrame;
  sim.stepFrame = (frame) => {
    received.push(frame);
    return stepFrame(frame);
  };
  try {
    for (let frame = 0; frame <= 4; frame += 1) {
      const out = pilot.input(encounter.getState(), 200 + frame);
      const attackOut = standalone.input(null, frame);
      assert.deepEqual(normalizeFrameInput(out), normalizeFrameInput(attackOut));
      if (frame === 0) assert.deepEqual(demoInputToSimulation(attackOut), normalizeFrameInput(attackOut));
      encounter.step(1, out);
    }
    assert.deepEqual(received.map(({ dx, press, hold }) => [dx, press, !!hold.shoot]), [
      [-1, ['dash', 'shoot', 'custom.action'], true], [-1, [], true], [-1, [], true], [0, [], false], [0, [], false],
    ]);
    assert.deepEqual(standalone.input(null, 0).press, ['dash', 'shoot', 'custom.action']);
    assert.deepEqual(pilot.warnings, []);
  } finally {
    encounter.destroy();
  }
  recorder.reset();
  assert.equal(recorder.toString(), '');
});

test('a menu press cannot leak into the first dodge frame; a new press can', async () => {
  const host = new EventTarget();
  globalThis.window = host;
  const encounterDoc = readSample('encounters/arena-tour');
  encounterDoc.hooks = {};
  const encounter = createEncounter({ canvas: { getContext: () => null }, resolveAttack: () => readSample('arena-stage') });
  try {
    await encounter.load(encounterDoc);
    for (let i = 0; i < 90 && encounter.phase !== 'menu'; i += 1) encounter.step(1);
    assert.equal(encounter.phase, 'menu');
    key(host, 'keydown', 'KeyZ');
    key(host, 'keydown', 'KeyV');
    key(host, 'keydown', 'KeyB');
    for (let i = 0; i < 90 && !encounter.world.battle; i += 1) encounter.step(1);
    const sim = encounter.world.battle.sim;
    const received = [];
    const stepFrame = sim.stepFrame;
    sim.stepFrame = (frame) => {
      received.push(frame);
      return stepFrame(frame);
    };
    key(host, 'keydown', 'KeyZ', true);
    key(host, 'keydown', 'KeyV', true);
    encounter.step(1);
    assert.deepEqual(received[0].press, []);
    assert.equal(received[0].hold.shoot, true);
    key(host, 'keyup', 'KeyV');
    key(host, 'keydown', 'KeyV');
    encounter.step(2);
    assert.deepEqual(received[1].press, ['dash']);
    assert.deepEqual(received[2].press, []);
    encounter.step(2, { press: ['dash'], hold: { shoot: true } });
    assert.deepEqual(received[3].press, ['dash']);
    assert.deepEqual(received[4].press, []);
    assert.equal(received[4].hold.shoot, true);
  } finally {
    encounter.destroy();
    delete globalThis.window;
  }
});

test('standalone battle accepts the full input frame on its public step API', () => {
  const battle = createBattle({ canvas: null, mode: 'play' });
  battle.load(readSample('arena-stage'));
  const received = [];
  const stepFrame = battle.engine.stepFrame;
  battle.engine.stepFrame = (frame) => {
    received.push(frame);
    return stepFrame(frame);
  };
  try {
    battle.step(2, { press: ['dash'], hold: { shoot: true, right: true } });
    assert.deepEqual(received, [
      { dx: 1, dy: 0, slow: false, press: ['dash'], hold: { shoot: true, right: true } },
      { dx: 1, dy: 0, slow: false, press: [], hold: { shoot: true, right: true } },
    ]);
  } finally {
    battle.destroy();
  }
});

test('paths and bots report unsupported profile switches, while input replay stays available', () => {
  const legacy = readSample('arena-stage');
  const attack = { ...legacy, timeline: [...legacy.timeline, { type: 'soulProfile', at: 2, profile: 'car' }] };
  const pilot = createAutopilot({ doc: attack });
  assert.equal(pilot.describe().dodge, 'stay');
  assert.match(pilot.warnings[0], /自訂靈魂配置不支援/);
  assert.deepEqual(pilot.input({}), { press: [], hold: {} });
  assert.throws(() => generateDemoPath(attack), /不支援路徑跟隨/);
  assert.deepEqual(traceDemo(attack).frames, []);

  const cosmetic = { ...legacy, timeline: [{ type: 'soulAppearance' }, { type: 'soulTeleport' }] };
  assert.equal(createAutopilot({ doc: cosmetic }).describe().dodge, 'path');

  const recorded = createAutopilot({
    doc: { ...attack, demo: { mode: 'inputs', inputs: 'v2:[[0,["shoot"],["dash"]]]', fallback: 'bot' } },
  });
  const state = { soul: { profile: 'car' } };
  assert.deepEqual(recorded.input(state, 0), { press: ['dash'], hold: { shoot: true } });
  assert.deepEqual(recorded.input(state, 1), { press: [], hold: {} });
  assert.match(recorded.warnings[0], /不支援路徑跟隨/);

  const recorder = createRecorder();
  recorder.push(0, { press: ['dash'] });
  recorder.push(8, {});
  assert.deepEqual(decodeInputs(recorder.toString()).map(({ frame }) => frame), [0, 8]);
});
