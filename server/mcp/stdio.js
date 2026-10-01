/**
 * Local MCP server over stdio for agents such as Claude Code and Codex.
 *
 *   npm run mcp -- [--api-base http://localhost:4173]
 *
 * Reads newline-delimited JSON-RPC from stdin and writes responses to stdout.
 * Tools read data from a running God's Eye View server (`npm run dev` or
 * `npm run preview`) at the API base. Diagnostics go to stderr.
 */

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseErrorResponse } from '../../src/tools/mcp/index.js';
import { createLocalMcpServer } from './server.js';
import { DEFAULT_API_BASE } from './services.js';

/** Serve newline-delimited JSON-RPC until `input` ends. */
export async function serveStdio(server, { input, output }) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of lines) {
    if (!line.trim()) continue;
    const work = respond(server, line).then((response) => {
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    pending.add(work);
    work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
}

async function respond(server, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return parseErrorResponse();
  }
  return server.handle(message);
}

/** Read `--api-base <url>` from command-line arguments. */
export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--api-base' && argv[index + 1])
      options.apiBase = argv[(index += 1)];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.error(
      `God's Eye View MCP server reading ${options.apiBase || DEFAULT_API_BASE}`,
    );
    await serveStdio(createLocalMcpServer(options), {
      input: process.stdin,
      output: process.stdout,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
