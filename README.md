# Podium MCP Server

A standalone Model Context Protocol (MCP) server that exposes Podium's LinkedIn post generation features as tools Claude can call. Built for Claude.ai integration and deployed on Railway.

## Tools

| Tool                  | Purpose                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `generate_hooks`      | Generate 4 LinkedIn opening hooks for a topic + writing style (optional user profile).   |
| `generate_post`       | Generate a full LinkedIn post from a topic, selected hook, and writing style.            |
| `get_trending_topics` | Return 8 current trending business / LinkedIn topics.                                    |
| `improve_post`        | Improve an existing post based on a natural-language instruction.                        |

All generation calls go through Anthropic's `claude-sonnet-4-20250514` model and use the same professional LinkedIn ghostwriter system prompts as the Podium web app — no hashtags, no emojis, short punchy paragraphs.

## Local development

```bash
npm install
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
npm start
```

The server listens on `PORT` (default `3000`) and exposes:

- `GET /health` — health check
- `POST /mcp` — MCP Streamable HTTP endpoint (stateless)

Quick health check:

```bash
curl http://localhost:3000/health
```

Quick tool list via MCP:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Environment variables

| Variable            | Required | Description                                                                                       |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | Your Anthropic API key. Used for all generation calls.                                            |
| `GNEWS_API_KEY`     | no       | GNews API key for live trending topics. If unset, `get_trending_topics` falls back to Claude.     |
| `PORT`              | no       | HTTP port. Railway sets this automatically.                                                       |

## Deploy to Railway

1. Push this repo to GitHub.
2. Create a new Railway project from the repo. Railway picks up `railway.json` and uses Nixpacks to build.
3. In **Variables**, set `ANTHROPIC_API_KEY` (and optionally `GNEWS_API_KEY`).
4. Deploy. Railway will run `npm start` and expose your service.
5. Grab the public URL from Railway. Your MCP endpoint is `https://<your-service>.up.railway.app/mcp`.

Verify the deployment:

```bash
curl https://<your-service>.up.railway.app/health
```

## Connecting to Claude.ai

In **Claude.ai → Settings → Connectors → Add custom connector**, point it at your deployed `/mcp` URL. Claude will list and call the four tools above.

## Tool call examples

### generate_hooks

```json
{
  "name": "generate_hooks",
  "arguments": {
    "topic": "AI in customer service",
    "writing_style": "contrarian",
    "user_profile": {
      "name": "Jane Smith",
      "headline": "VP Customer Experience",
      "industry": "SaaS",
      "expertise": "CX strategy, contact centers",
      "voiceSamples": "Most CX teams measure the wrong things..."
    }
  }
}
```

### generate_post

```json
{
  "name": "generate_post",
  "arguments": {
    "topic": "AI in customer service",
    "selected_hook": "Most CX leaders are still measuring 2018 metrics in a 2026 world.",
    "writing_style": "contrarian",
    "use_research": true
  }
}
```

### get_trending_topics

```json
{ "name": "get_trending_topics", "arguments": {} }
```

### improve_post

```json
{
  "name": "improve_post",
  "arguments": {
    "existing_post": "Leadership is about empathy...",
    "instruction": "Make it shorter and add a concrete example."
  }
}
```

## Architecture notes

- **Transport**: Streamable HTTP (not SSE), in stateless mode. Each request builds a fresh `Server` + `StreamableHTTPServerTransport`, which works cleanly behind Railway's proxy.
- **Express + CORS**: Permissive CORS so Claude.ai and other MCP clients can connect from any origin.
- **No persistence**: This server is intentionally stateless — all context lives in the MCP request.
