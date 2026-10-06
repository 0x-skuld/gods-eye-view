/**
 * Header press-and-verify for the browser QA gates that lift a rail panel
 * into a floating window (header drag) and dock it again (header
 * double-click). The rail animates panel heights, so a point read once can
 * be under another panel by the time the pointer goes down. Each attempt
 * re-resolves the header, presses only where the header really is, records
 * what the press landed on, and waits for the panel's actual state. Only a
 * provable miss (a recorded press that landed outside the header) is
 * retried; a press in the header that did not lift or dock, and a press that
 * recorded no pointerdown at all, are real failures.
 *
 * Every retry is logged with what led to it (the pre-press hit check, the
 * stillness wait, the panel box at the hit check and at the press) and as a
 * GitHub `::warning::`. With QA_FAIL_ON_RETRY=1 (or `--fail-on-retry`) a
 * miss the panel's own movement cannot explain fails the run instead: if its
 * box was the same at the hit check and at the press, the pointer missed a
 * header that stood still. A panel whose content changed its layout between
 * the two (a photo finishing loading, a live count wrapping a line) is
 * retried with a warning that names the move.
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries after the first attempt, and the pause before each. */
export const PRESS_RETRIES = 2;
const RETRY_PAUSE_MS = 1000;

/** Whether a retry fails the run (QA_FAIL_ON_RETRY=1 or --fail-on-retry). */
export function failOnRetryDefault(
  env = process.env,
  argv = process.argv.slice(2),
) {
  return env.QA_FAIL_ON_RETRY === '1' || argv.includes('--fail-on-retry');
}

/**
 * Whether an attempt proves nothing about the panel: it did not reach the
 * wanted state and the recorded press demonstrably landed outside the
 * header. No recorded press (`pressed` null) is not a miss but a failure:
 * the pointer never reached the page, which a retry would only hide.
 * @param {{done: boolean, pressed: {inHeader: boolean}|null}} attempt
 */
export function pressMissed(attempt) {
  return !attempt.done && attempt.pressed?.inHeader === false;
}

/** The panel's box, rounded, as `left,top widthxheight`. */
/** Whether the panel's box changed (by more than 2 px) between two reads. */
export function panelMoved(before, after) {
  if (!before || !after) return false;
  return ['left', 'top', 'width', 'height'].some(
    (key) => Math.abs((after[key] ?? NaN) - (before[key] ?? NaN)) > 2,
  );
}

export function formatBox(box) {
  if (!box) return 'unknown';
  const r = (value) => Math.round(value ?? NaN);
  return `${r(box.left)},${r(box.top)} ${r(box.width)}x${r(box.height)}`;
}

function panelBox(page, panelId) {
  return page.evaluate((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, panelId);
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
 * bounded wait runs out; the press then records the miss). `timedOut` says
 * the hit check never passed; `box` is the panel's box at the last check.
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
  const box = await panelBox(page, panelId);
  return { point, hit, timedOut: !hit.inHeader, box };
}

/**
 * Best effort: wait until the panel's box (to the whole pixel) has held still
 * for `stillMs`, so a rail still animating heights does not move the header
 * between the hit check and the press. Never fails the run; resolves to
 * whether the box held still in time.
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
    return true;
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return false;
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
          height: r.height,
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

/**
 * Wait for the page to paint twice: pointer handlers apply synchronously, so
 * by then every layout change an input caused is on screen.
 */
export function nextFrames(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** Press at `from`, move by (dx, dy) in two legs, release. */
export async function dragPointer(page, from, dx, dy, { steps = 6 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps });
  await page.mouse.move(from.x + dx, from.y + dy, { steps });
  await page.mouse.up();
  await nextFrames(page);
}

/**
 * One line naming why a press is retried: what it landed on, the pre-press
 * hit check, the stillness wait and the panel's box at the check and press.
 */
export function describeRetry(
  panelId,
  attempt,
  { round, retries, extra = '' },
) {
  const { hit, pressed, timedOut, still, box } = attempt;
  return [
    `retry ${round + 1}/${retries}: the press missed the ${panelId} header (on ${pressed?.target ?? hit.target})`,
    `pre-press hit check ${timedOut ? `timed out (on ${hit.target})` : 'passed'}`,
    `stillness ${still === false ? 'timed out' : 'held'}`,
    `panel box at hit check ${formatBox(box)} -> at press ${formatBox(pressed)}`,
  ]
    .concat(extra ? [extra] : [])
    .join('; ');
}

/**
 * Run `press` (one attempt at the header) until it reaches the wanted state,
 * a press in the header fails to, or the retries run out.
 */
async function pressUntilDecided(
  page,
  panelId,
  press,
  {
    retries,
    log,
    note,
    pauseMs = RETRY_PAUSE_MS,
    failOnRetry = failOnRetryDefault(),
  },
) {
  for (let round = 0; ; round++) {
    const still = await waitForStill(page, panelId);
    await recordNextPress(page, panelId);
    const { point, hit, timedOut, box } = await headerTarget(page, panelId);
    const done = await press(point);
    const attempt = {
      point,
      hit,
      timedOut,
      still,
      box,
      done,
      pressed: await readPress(page),
      retries: round,
    };
    if (round >= retries || !pressMissed(attempt)) return attempt;
    const why = describeRetry(panelId, attempt, {
      round,
      retries,
      extra: note ? await note() : '',
    });
    if (failOnRetry && !panelMoved(box, attempt.pressed))
      throw new Error(
        `QA_FAIL_ON_RETRY=1 turns this retry into a failure: ${why}`,
      );
    log(`note: ${why}; retrying`);
    log(`::warning title=Panel press retried::${why}`);
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
  {
    dx,
    dy,
    retries = PRESS_RETRIES,
    log = console.log,
    note,
    pauseMs,
    failOnRetry,
  } = {},
) {
  return pressUntilDecided(
    page,
    panelId,
    async (point) => {
      await dragPointer(page, point, dx, dy);
      return waitForFloating(page, panelId, true);
    },
    { retries, log, note, pauseMs, failOnRetry },
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
  {
    retries = PRESS_RETRIES,
    log = console.log,
    note,
    pauseMs,
    failOnRetry,
  } = {},
) {
  return pressUntilDecided(
    page,
    panelId,
    async (point) => {
      await page.mouse.click(point.x, point.y, { clickCount: 1 });
      await page.mouse.click(point.x, point.y, { clickCount: 2 });
      return waitForFloating(page, panelId, false);
    },
    { retries, log, note, pauseMs, failOnRetry },
  );
}

/** One line naming where an attempt pressed, for an assertion message. */
export function describePress(attempt) {
  const { point, hit, pressed } = attempt;
  const where = `pressed ${Math.round(point.x)},${Math.round(point.y)}`;
  if (!pressed)
    return `${where}: no pointerdown reached the page (hit check on ${hit.target}, in header: ${hit.inHeader})`;
  const n = attempt.retries || 0;
  const retried = n ? `, after ${n} ${n === 1 ? 'retry' : 'retries'}` : '';
  return `${where} on ${pressed.target}, in header: ${pressed.inHeader}${retried}`;
}
