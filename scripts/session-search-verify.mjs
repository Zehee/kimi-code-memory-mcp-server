import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Allow override via CLI or env: node script --session=... --query="..." --limit=100
const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.split('=');
    return [k.replace(/^--/, ''), v ?? true];
  }),
);
const TARGET_SESSION = argv.session ?? process.env.TARGET_SESSION ?? 'wd_wolfjudgeassistant_dffa9413a434';
const QUERY = argv.query ?? process.env.SEARCH_QUERY ?? 'mcp memory';
const LIMIT = Number(argv.limit ?? process.env.SEARCH_LIMIT ?? 100);

// Robust JSON parsing of the tool result
function parseJsonResult(toolResult) {
  if (!toolResult) {
    throw new Error('parseJsonResult: toolResult is null/undefined');
  }

  // Accept several shapes:
  // - toolResult.content: [{ type: 'text', text: '...json...' }, ...]
  // - toolResult.content could be a string directly
  // - toolResult could already be an object
  let text;
  if (typeof toolResult === 'string') {
    text = toolResult;
  } else if (Array.isArray(toolResult.content)) {
    const textEntry = toolResult.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    text = textEntry?.text ?? toolResult.content[0]?.text;
  } else if (typeof toolResult.content === 'string') {
    text = toolResult.content;
  }

  if (!text) {
    // If result is already an object with matches/clusters, return as-is
    if (toolResult.matches || toolResult.clusters || toolResult.refinedCount) {
      return toolResult;
    }
    throw new Error('parseJsonResult: no textual JSON content found in toolResult');
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    const sample = text.slice(0, 300);
    throw new Error(`parseJsonResult: JSON.parse failed: ${err.message}. text (first 300 chars): ${sample}`);
  }
}

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', path.join(projectRoot, 'src', 'server.ts')],
  cwd: projectRoot,
  env: { ...process.env },
});
const client = new Client({ name: 'session-verify-client', version: '0.1.0' });

process.on('unhandledRejection', (r) => {
  console.error('unhandledRejection:', r);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  process.exit(1);
});

await client.connect(transport);

try {
  const toolRaw = await client.callTool({
    name: 'search_context',
    arguments: { query: QUERY, limit: LIMIT },
  });

  const result = parseJsonResult(toolRaw);

  const matches = Array.isArray(result.matches) ? result.matches : [];
  const clusters = Array.isArray(result.clusters) ? result.clusters : [];

  const targetMatches = matches.filter((m) => m.sessionId === TARGET_SESSION);
  const targetClusters = clusters.filter((c) => c.sessionId === TARGET_SESSION);

  console.log('=== global ===');
  console.log('totalMatches:', matches.length ?? 0);
  console.log('clusterCount:', clusters.length ?? 0);
  console.log('refinedCount:', result.refinedCount ?? 0);

  console.log('\n=== target session ===', TARGET_SESSION);
  console.log('targetMatches:', targetMatches.length);
  console.log('targetClusters:', targetClusters.length);

  for (const cluster of targetClusters) {
    const memberIds = Array.isArray(cluster.members) ? cluster.members.map((m) => m.turnId).join(',') : '';
    console.log(`cluster hit=${cluster.hitTurnId} members=[${memberIds}] count=${(cluster.members || []).length}`);
  }

  // Overlap check for target clusters.
  const seen = new Map();
  let overlaps = 0;
  for (const cluster of targetClusters) {
    for (const m of cluster.members || []) {
      if (m.sessionId !== TARGET_SESSION) continue;
      const key = m.turnId;
      if (seen.has(key)) {
        overlaps++;
        console.log('OVERLAP:', key, 'clusters', seen.get(key), cluster.hitTurnId);
      } else {
        seen.set(key, cluster.hitTurnId);
      }
    }
  }
  console.log('targetOverlapCount:', overlaps);

  // Print target match snippets (safe access)
  console.log('\n=== target match snippets ===');
  for (const m of targetMatches.slice(0, 10)) {
    const snippet = (m.snippet || '').replace(/\n/g, ' ').slice(0, 120);
    console.log(`turn ${m.turnId}: ${snippet}`);
  }
} catch (err) {
  console.error('Error while running session search verify:', err);
  throw err;
} finally {
  // Try to disconnect the client if the API supports it, then close the transport.
  try {
    if (typeof client.disconnect === 'function') {
      await client.disconnect();
    } else if (typeof client.close === 'function') {
      await client.close();
    }
  } catch (err) {
    console.warn('Warning: failed to disconnect client cleanly:', err);
  }

  try {
    await transport.close();
  } catch (err) {
    console.warn('Warning: failed to close transport cleanly:', err);
  }
}
