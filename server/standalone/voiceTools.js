/**
 * The voice session's tools for the standalone server: the app actions plus
 * Core's catalog queries, which the browser runs through the same catalog.
 * Links to the app are left out, since voice runs inside it.
 */

import { coreTools, toFunctionTools } from '../../src/tools/index.js';
import { realtimeSessionTools } from '../providers/openai/tools.js';

export const VOICE_EXCLUDED_QUERIES = Object.freeze(['open_in_gods_eye_view']);

export function standaloneVoiceTools() {
  return realtimeSessionTools(
    toFunctionTools(coreTools, { exclude: VOICE_EXCLUDED_QUERIES }),
  );
}
