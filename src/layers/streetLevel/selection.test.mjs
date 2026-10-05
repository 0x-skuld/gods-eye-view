import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as Cesium from 'cesium';
import { createSelection } from './selection.js';

/**
 * The selection installed on a stand-in viewer. Animation frames queue until
 * `frame()` runs them; timers and Date.now() are mocked so a burst of moves
 * has a known timeline.
 */
function harness() {
  const saved = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const frames = [];
  globalThis.requestAnimationFrame = (task) => frames.push(task);
  globalThis.document = new EventTarget();
  const picks = [];
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    // Keep Cesium's handler on the canvas; there is no real document here.
    disableRootEvents: true,
    onwheel: null,
  });
  const camera = { moveStart: new Cesium.Event(), moveEnd: new Cesium.Event() };
  const viewer = {
    scene: {
      canvas,
      pick(position) {
        picks.push(position);
        return null;
      },
    },
    camera,
    isDestroyed: () => false,
  };
  const state = {
    viewer,
    enabled: true,
    clickHandler: null,
    services: { picking: null, input: null },
  };
  const selection = createSelection({
    state,
    parts: {
      router: { ownsPick: () => false, resolve: () => null },
      hasSelectedSequence: () => false,
      clearSequences() {},
    },
  });
  selection.install(viewer);
  const onMove = state.clickHandler.getInputAction(
    Cesium.ScreenSpaceEventType.MOUSE_MOVE,
  );
  return {
    state,
    canvas,
    camera,
    picks,
    move: (x) => onMove({ endPosition: { x, y: 10 } }),
    frame() {
      for (const task of frames.splice(0)) task();
    },
    /** Let `ms` pass, running the frames that come due on the way. */
    wait(ms) {
      this.frame();
      mock.timers.tick(ms);
      this.frame();
    },
    buttons(type, buttons) {
      const event = new Event(type);
      Object.defineProperty(event, 'buttons', { value: buttons });
      canvas.dispatchEvent(event);
    },
    restore() {
      selection.uninstall();
      mock.timers.reset();
      Object.assign(globalThis, saved);
    },
  };
}

test('hover picks at most every 120 ms through a burst of moves, ending on the last one', () => {
  const h = harness();
  try {
    // One second of a pointer moving at 60 Hz.
    for (let i = 0; i < 60; i++) {
      h.move(i);
      h.wait(16);
    }
    assert.ok(h.picks.length <= 9, `${h.picks.length} picks in ~1 s`);
    assert.ok(h.picks.length >= 7, `${h.picks.length} picks in ~1 s`);
    h.wait(200);
    assert.deepEqual(h.picks.at(-1), { x: 59, y: 10 }, 'the resting position');
    const settled = h.picks.length;
    h.wait(1000);
    assert.equal(h.picks.length, settled, 'a still pointer costs nothing');
  } finally {
    h.restore();
  }
});

test('hover does not pick while the camera moves or a mouse button is held', () => {
  const h = harness();
  try {
    h.camera.moveStart.raiseEvent();
    h.move(1);
    h.wait(200);
    assert.equal(h.picks.length, 0, 'camera in motion');
    h.camera.moveEnd.raiseEvent();
    h.move(2);
    h.wait(200);
    assert.equal(h.picks.length, 1, 'picks again once the camera rests');

    h.buttons('pointerdown', 1);
    h.move(3);
    h.wait(200);
    assert.equal(h.picks.length, 1, 'a drag in progress');
    h.buttons('pointerup', 0);
    h.move(4);
    h.wait(200);
    assert.equal(h.picks.length, 2);
  } finally {
    h.restore();
  }
});

test('a hover frame queued before the layer went off does not pick', () => {
  const h = harness();
  try {
    h.move(1);
    h.state.enabled = false;
    h.wait(200);
    assert.equal(h.picks.length, 0);
  } finally {
    h.restore();
  }
});
