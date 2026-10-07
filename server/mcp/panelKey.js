import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Where the install's panel key lives: beside the other local state, which
 * git ignores, at the checkout root rather than the client's working
 * directory (an MCP client may start the server anywhere). */
export const DEFAULT_PANEL_KEY_FILE = fileURLToPath(
  new URL('../../.gev-cache/mcp-panel-key', import.meta.url),
);

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const newKey = () => randomBytes(32).toString('base64url');
const notShared = (error) =>
  `panel key not shared (${error.code || error.message}); using a key of this process`;

function readKey(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  return KEY_PATTERN.test(text) ? text : null;
}

/**
 * The panel key every stdio server of this install shares.
 *
 * A client can start more than one server process for one connection: Claude
 * Desktop has been seen serving the globe panel's page from one and sending
 * the page's `panel_request` calls to the other. A key made per process then
 * never matches, and the panel reports that only it may make the request
 * (#927). The first process to run creates the key, without replacing one
 * another process created at the same moment; the rest read it. When the file
 * cannot be read or written, the process falls back to a key of its own,
 * which is what every process used before.
 *
 * As before, the key keeps `panel_request` from clients that only list it; it
 * is not access control.
 *
 * @param {{ file?: string, log?: (line: string) => void }} [options]
 * @returns {string}
 */
export function sharedPanelKey({
  file = DEFAULT_PANEL_KEY_FILE,
  log = () => {},
} = {}) {
  try {
    const existing = readKey(file);
    if (existing) return existing;
    // Present but not a key: replace it below.
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log(notShared(error));
      return newKey();
    }
  }
  const key = newKey();
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`,
    );
    fs.writeFileSync(tmp, `${key}\n`, { flag: 'wx', mode: 0o600 });
    try {
      // link() publishes the whole file at once and fails if another process
      // got there first, so a reader never sees a half-written key and two
      // processes starting together cannot end up with different keys.
      fs.linkSync(tmp, file);
      return key;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = readKey(file);
      if (winner) return winner;
      // A malformed file left by something else: replace it.
      fs.renameSync(tmp, file);
      tmp = null;
      return key;
    }
  } catch (error) {
    log(notShared(error));
    return key;
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}
