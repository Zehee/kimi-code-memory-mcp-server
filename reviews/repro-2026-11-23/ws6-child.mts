import { pathToFileURL } from 'node:url';
const { parseWireFile } = await import(pathToFileURL('D:/workspace/kimi-code-memory-mcp-server/src/context/wire-context.ts').href);
const { turns } = await parseWireFile(process.argv[2]);
console.log(`parsed turns=${turns.length}`);
setTimeout(() => process.exit(0), 50);
