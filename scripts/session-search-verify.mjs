import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Accept configuration from CLI arguments or environment variables.
const targetSession = process.argv[2] || process.env.VERIFY_TARGET_SESSION || '';
const query = process.argv[3] || process.env.VERIFY_QUERY || 'mcp memory';
const limit = parseInt(process.argv[4] || process.env.VERIFY_LIMIT || '100', 10);

if (!targetSession) {
  console.error('Error: targetSession is required.');
  console.error('Usage: node scripts/session-search-verify.mjs <targetSession> [query] [limit]');
  console.error('   or: VERIFY_TARGET_SESSION=<id> VERIFY_QUERY=<query> node scripts/session-search-verify.mjs');
  process.exit(1);
}

function parseJsonResult(toolResult) {
  if (!toolResult || typeof toolResult !== 'object') {
    throw new Error(`Unexpected tool result type: ${typeof toolResult}`);
  }

  const content = Array.isArray(toolResult.content) ? toolResult.content : [];
  const textItem = content.find((c) => c && c.type === 'text');
  const text = textItem?.text;

  if (typeof text !== 'string') {
    throw new Error(`Tool result missing text content. Received: ${JSON.stringify(toolResult).slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse tool result as JSON: ${err.message}\nRaw text:\n${text.slice(0, 500)}`);
  }
}

function validateSearchResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('search_context returned a non-object result');
  }
  return {
    matches: Array.isArray(result.matches) ? result.matches : [],
    clusters: Array.isArray(result.clusters) ? result.clusters : [],
    refinedCount: typeof result.refinedCount === 'number' ? result.refinedCount : 0,
    skippedSessions: Array.isArray(result.skippedSessions) ? result.skippedSessions : [],
  };
}

async function safeDisconnect(client) {
  if (!client) return;
  try {
    if (typeof client.disconnect === 'function') {
      await client.disconnect();
    } else if (typeof client.close === 'function') {
      await client.close();
    }
  } catch (err) {
    // Best-effort cleanup; ignore errors on shutdown.
    console.error('Warning: failed to disconnect client:', err.message);
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', path.join(projectRoot, 'src', 'server.ts')],
    cwd: projectRoot,
    env: { ...process.env },
  });

  const client = new Client({ name: 'session-verify-client', version: '0.1.0' });
  await client.connect(transport);

  try {
    const rawResult = await client.callTool({
      name: 'search_context',
      arguments: { query, limit },
    });

    const result = validateSearchResult(parseJsonResult(rawResult));
    const targetMatches = result.matches.filter((m) => m && m.sessionId === targetSession);
    const targetClusters = result.clusters.filter((c) => c && c.sessionId === targetSession);

    console.log('=== global ===');
    console.log('query:', query);
    console.log('limit:', limit);
    console.log('totalMatches:', result.matches.length);
    console.log('clusterCount:', result.clusters.length);
    console.log('refinedCount:', result.refinedCount);
    console.log('skippedSessions:', result.skippedSessions.length);

    console.log('\n=== target session ===', targetSession);
    console.log('targetMatches:', targetMatches.length);
    console.log('targetClusters:', targetClusters.length);

    for (const cluster of targetClusters) {
      const members = Array.isArray(cluster.members) ? cluster.members : [];
      const memberIds = members.map((m) => m?.turnId).filter((id) => id !== undefined).join(',');
      console.log(`cluster hit=${cluster.hitTurnId} members=[${memberIds}] count=${members.length}`);
    }

    // Overlap check for target clusters.
    const seen = new Map();
    let overlaps = 0;
    for (const cluster of targetClusters) {
      const members = Array.isArray(cluster.members) ? cluster.members : [];
      for (const m of members) {
        if (!m || m.sessionId !== targetSession) continue;
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

    // Print target match snippets.
    console.log('\n=== target match snippets ===');
    for (const m of targetMatches.slice(0, 10)) {
      const snippet = typeof m.snippet === 'string' ? m.snippet.replace(/\n/g, ' ').slice(0, 120) : '(no snippet)';
      console.log(`turn ${m.turnId}: ${snippet}`);
    }
  } finally {
    await safeDisconnect(client);
    await transport.close();
  }
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

main();
