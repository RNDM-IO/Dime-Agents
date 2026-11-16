# DIME MCP server

Lets AI agents read DIME (price, house, quotes, accounts) and, when you configure a session key, open and close
trades within limits you set. Stdio transport, no dependencies beyond the SDK.

```sh
DIME_API=https://api-dime.rndm.io npx tsx src/server.ts           # read-only
```

Configuration and the client config snippet: [docs/DEVELOPERS.md](../docs/DEVELOPERS.md#mcp-server).
