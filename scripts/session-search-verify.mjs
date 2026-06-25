import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const targetSession = 'wd_wolfjudgeassistant_dffa9413a434';

function parseJsonResult(toolResult) {
  const text = toolResult.content.find((c) => c.type === 'text')?.text;
  return JSON.parse(text);
}

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', path.join(projectRoot, 'src', 'server.ts')],
  cwd: projectRoot,
  env: { ...process.env },
});
const client = new Client({ name: 'session-verify-client', version: '0.1.0' });
await client.connect(transport);

try {
  const result = parseJsonResult(
    await client.callTool({
      name: 'search_context',
      arguments: { query: 'mcp memory', limit: 100 },
    }),
  );

  const targetMatches = (result.matches || []).filter((m) => m.sessionId === targetSession);
  const targetClusters = (result.clusters || []).filter((c) => c.sessionId === targetSession);

  console.log('=== global ===');
  console.log('totalMatches:', result.matches?.length);
  console.log('clusterCount:', result.clusters?.length);
  console.log('refinedCount:', result.refinedCount);

  console.log('\n=== target session ===', targetSession);
  console.log('targetMatches:', targetMatches.length);
  console.log('targetClusters:', targetClusters.length);

  for (const cluster of targetClusters) {
    const memberIds = cluster.members.map((m) => m.turnId).join(',');
    console.log(`cluster hit=${cluster.hitTurnId} members=[${memberIds}] count=${cluster.members.length}`);
  }

  // Overlap check for target clusters.
  const seen = new Map();
  let overlaps = 0;
  for (const cluster of targetClusters) {
    for (const m of cluster.members) {
      if (m.sessionId !== targetSession) continue;
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
    console.log(`turn ${m.turnId}: ${m.snippet.replace(/\n/g, ' ').slice(0, 120)}`);
  }
} finally {
  await transport.close();
}
