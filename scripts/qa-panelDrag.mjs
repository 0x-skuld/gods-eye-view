/**
 * Header press-and-verify for the browser QA gates that lift a rail panel
 * into a floating window (header drag) and dock it again (header
 * double-click). The rail animates panel heights, so a point read once can
 * be under another panel by the time the pointer goes down. Each attempt
 * re-resolves the header, presses only where the header really is, records
 * what the press landed on, and waits for the panel's actual state. Only a
 * provable miss (a press that landed outside the header) is retried; a press
 * in the header that did not lift or dock is a real failure.
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries after the first attempt, and the pause before each. */
export const PRESS_RETRIES = 2;
const RETRY_PAUSE_MS = 1000;

/**
 * Whether an attempt proves nothing about the panel: it did not reach the
 * wanted state and the press demonstrably landed outside the header.
 * @param {{done: boolean, pressed: {inHeader: boolean}|null}} attempt
 */
export function pressMissed(attempt) {
  return !attempt.done && attempt.pressed?.inHeader !== true;
}

/** The centre of the panel's header title, read now. */
export function headerPoint(page, panelId) {
  return page.evaluate((id) => {
    const title = document.querySelector(`#${id} .panel-header .panel-title`);
    const r = title.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, panelId);
}

/** Name the element at a viewport point, and whether it is the panel's header. */
export function hitAt(page, point, panelId) {
  return page.evaluate(
    ({ x, y, id }) => {
      const node = document.elementFromPoint(x, y);
      if (!node) return { target: 'nothing', inHeader: false };
      return {
        target: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${[...node.classList].join('.')}`,
        inHeader: Boolean(node.closest(`#${id} .panel-header`)),
      };
    },
    { ...point, id: panelId },
  );
}

/**
 * The header point to press, re-resolved until it lands on the header (or the
 * bounded wait runs out; the press then records the miss).
 */
export async function headerTarget(
  page,
  panelId,
  { tries = 20, intervalMs = 500 } = {},
) {
  let point = await headerPoint(page, panelId);
  let hit = await hitAt(page, point, panelId);
  for (let i = 0; i < tries && !hit.inHeader; i++) {
    await delay(intervalMs);
    point = await headerPoint(page, panelId);
    hit = await hitAt(page, point, panelId);
  }
  return { point, hit };
}

/**
 * Best effort: wait until the panel's box (to the whole pixel) has held still
 * for `stillMs`, so a rail still animating heights does not move the header
 * between the hit check and the press. Never fails the run.
 */
export async function waitForStill(
  page,
  panelId,
  { stillMs = 300, timeout = 5000 } = {},
) {
  try {
    await page.waitForFunction(
      (id, ms) => {
        const r = document.getElementById(id).getBoundingClientRect();
        const box = [r.left, r.top, r.width, r.height].map(Math.round).join();
        const now = performance.now();
        if (window.__qaStillBox !== box) {
          window.__qaStillBox = box;
          window.__qaStillSince = now;
        }
        return now - window.__qaStillSince >= ms;
      },
      { polling: 100, timeout },
      panelId,
      stillMs,
    );
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
  }
}

/**
 * Record what the next pointerdown lands on, with the panel's box at that
 * moment, in `window.__qaPressBox` (null until a press arrives).
 */
export function recordNextPress(page, panelId) {
  return page.evaluate((id) => {
    window.__qaPressBox = null;
    window.addEventListener(
      'pointerdown',
      (event) => {
        const r = document.getElementById(id).getBoundingClientRect();
        const target = event.target;
        window.__qaPressBox = {
          left: r.left,
          top: r.top,
          width: r.width,
          // What the press landed on, so a failed press says why.
          target: `${target.tagName?.toLowerCase()}${target.id ? `#${target.id}` : ''}.${[...(target.classList || [])].join('.')}`,
          inHeader: Boolean(target.closest?.(`#${id} .panel-header`)),
        };
      },
      { capture: true, once: true },
    );
  }, panelId);
}

/** The press recorded by `recordNextPress`, or null. */
function readPress(page) {
  return page.evaluate(() => window.__qaPressBox ?? null);
}

/** Wait (bounded) until the panel is, or is not, a floating window. */
export async function waitForFloating(
  page,
  panelId,
  floating,
  { timeout = 3000 } = {},
) {
  try {
    await page.waitForFunction(
      (id, want) =>
        document.getElementById(id).classList.contains('panel-floating') ===
        want,
      { polling: 50, timeout },
      panelId,
      floating,
    );
    return true;
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return false;
  }
}

/** Press at `from`, move by (dx, dy) in two legs, release. */
export async function dragPointer(page, from, dx, dy, { steps = 6 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps });
  await page.mouse.move(from.x + dx, from.y + dy, { steps });
  await page.mouse.up();
  await delay(120);
}

/**
 * Run `press` (one attempt at the header) until it reaches the wanted state,
 * a press in the header fails to, or the retries run out.
 */
async function pressUntilDecided(
  page,
  panelId,
  press,
  { retries, log, note, pauseMs = RETRY_PAUSE_MS },
) {
  for (let round = 0; ; round++) {
    await waitForStill(page, panelId);
    await recordNextPress(page, panelId);
    const { point, hit } = await headerTarget(page, panelId);
    const done = await press(point);
    const attempt = { point, hit, done, pressed: await readPress(page) };
    if (round >= retries || !pressMissed(attempt)) return attempt;
    const extra = note ? `; ${await note()}` : '';
    log(
      `note: the press missed the ${panelId} header (on ${attempt.pressed?.target ?? hit.target}${extra}); retrying`,
    );
    await delay(pauseMs);
  }
}

/**
 * Lift a docked panel into a floating window with a header drag.
 * @returns {Promise<{point: {x: number, y: number}, hit: {target: string, inHeader: boolean}, done: boolean, pressed: object|null}>}
 *   `done` is whether the panel is floating; `pressed` names what the press
 *   landed on and the panel's box at that moment.
 */
export function liftPanelByHeader(
  page,
  panelId,
  { dx, dy, retries = PRESS_RETRIES, log = console.log, note, pauseMs } = {},
) {
  return pressUntilDecided(
    page,
    panelId,
    async (point) => {
      await dragPointer(page, point, dx, dy);
      return waitForFloating(page, panelId, true);
    },
    { retries, log, note, pauseMs },
  );
}

/**
 * Dock a floating panel with a header double-click, waiting on the docked
 * state rather than a fixed sleep. Same result shape as `liftPanelByHeader`;
 * `done` is whether the panel is docked.
 */
export function dockPanelByDoubleClick(
  page,
  panelId,
  { retries = PRESS_RETRIES, log = console.log, note, pauseMs } = {},
) {
  return pressUntilDecided(
    page,
    panelId,
    async (point) => {
      await page.mouse.click(point.x, point.y, { clickCount: 1 });
      await page.mouse.click(point.x, point.y, { clickCount: 2 });
      return waitForFloating(page, panelId, false);
    },
    { retries, log, note, pauseMs },
  );
}

/** One line naming where an attempt pressed, for an assertion message. */
export function describePress(attempt) {
  const { point, hit, pressed } = attempt;
  return `pressed ${Math.round(point.x)},${Math.round(point.y)} on ${pressed?.target ?? `${hit.target} (no press recorded)`}, in header: ${pressed?.inHeader ?? hit.inHeader}`;
}
