import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const GNEWS_API_KEY = process.env.GNEWS_API_KEY // optional
const MODEL = 'claude-sonnet-4-20250514'

if (!ANTHROPIC_API_KEY) {
  console.error('[podium-mcp] ANTHROPIC_API_KEY not set — server will start but tool calls will fail.')
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

// ─────────────────────────────────────────────────────────────────────────────
// System prompts — kept identical to Podium's LinkedIn ghostwriter prompts.
// Core identity: professional LinkedIn ghostwriter, no hashtags, no emojis,
// short punchy paragraphs.
// ─────────────────────────────────────────────────────────────────────────────

const FULL_PROFILE_HOOK_SYSTEM = `You are a LinkedIn ghostwriter who writes in the exact voice and style of the author described below. Study their voice samples carefully — match their sentence structure, vocabulary, rhythm, and personality. Hooks should feel like something this specific person would write, not a generic content creator. Use short, punchy sentences. No hashtags, no emojis. Return valid JSON only — an array of 4 strings.`

const NO_PROFILE_HOOK_SYSTEM = `You are a LinkedIn ghostwriter. Generate 4 professional LinkedIn post hooks. Use short, punchy sentences. No hashtags, no emojis. Return valid JSON only — an array of 4 strings.`

const FULL_PROFILE_POST_SYSTEM = `You are an expert LinkedIn ghostwriter. Write a post that sounds authentically like the specific person described below. Use their communication style from their About section. Reference their specific industry experience and accomplishments where relevant. Avoid generic corporate language and clichés. Match their sentence structure, vocabulary, rhythm, and personality precisely. Never sound like a template. Use short, punchy paragraphs with line breaks for readability. No hashtags, no emojis. Write the post content only — no explanations or preamble.`

const NO_PROFILE_POST_SYSTEM = `You are a LinkedIn ghostwriter. Write a professional LinkedIn post. Use a professional tone with short, punchy paragraphs and line breaks for readability. 150-250 words. No hashtags, no emojis. Write the post content only — no explanations or preamble.`

const IMPROVE_POST_SYSTEM = `You are an expert LinkedIn ghostwriter. Improve the given LinkedIn post based on the user's instruction. Keep the post's core idea and voice intact while applying the requested changes. Use short, punchy paragraphs with line breaks for readability. No hashtags, no emojis. Return only the improved post — no explanations, preamble, or meta commentary.`

const TRENDING_SYSTEM = `You are a LinkedIn content strategist tracking business conversations. Suggest 8 current trending topics that business-focused LinkedIn creators are actively discussing right now. Cover a mix of: leadership and management, AI and the future of work, entrepreneurship and startups, and customer experience and operations. Each topic should be 3-7 words, specific, timely, and post-worthy — not a generic category like "Leadership Tips". Return valid JSON only — an array of 8 strings.`

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function stripMarkdownFences(text) {
  return text.replace(/```(?:json)?\s*\n?/g, '').replace(/```\s*$/g, '').trim()
}

function buildProfileBlock(profile) {
  if (!profile || typeof profile !== 'object') return ''
  const parts = ['=== AUTHOR PROFILE ===']
  if (profile.name) parts.push(`Name: ${profile.name}`)
  if (profile.headline) parts.push(`Title: ${profile.headline}`)
  if (profile.industry) parts.push(`Industry: ${profile.industry}`)
  if (profile.accomplishments) parts.push(`Career background: ${profile.accomplishments}`)
  if (profile.expertise) parts.push(`Core expertise: ${profile.expertise}`)
  if (profile.summary) parts.push(`LinkedIn About section: ${profile.summary}`)
  if (profile.targetAudience) parts.push(`Target audience: ${profile.targetAudience}`)
  if (profile.communicationStyle) parts.push(`Communication style: ${profile.communicationStyle}`)
  if (profile.voiceSamples) {
    parts.push(`\n=== VOICE SAMPLES (match this writing style closely) ===`)
    parts.push(profile.voiceSamples)
  }
  parts.push('=== END AUTHOR PROFILE ===')
  return parts.join('\n')
}

function hasProfileContent(profile) {
  if (!profile || typeof profile !== 'object') return false
  return Object.values(profile).some((v) => typeof v === 'string' && v.trim().length > 0)
}

async function callClaude({ systemPrompt, userPrompt, maxTokens = 1024 }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured on the server.')
  }
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })
  const block = response.content?.[0]
  if (!block || block.type !== 'text') {
    throw new Error('Anthropic API returned no text content.')
  }
  return block.text
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

async function generateHooks({ topic, writing_style, user_profile }) {
  if (!topic || typeof topic !== 'string') {
    throw new Error('topic is required and must be a string')
  }
  if (!writing_style || typeof writing_style !== 'string') {
    throw new Error('writing_style is required and must be a string')
  }

  const withProfile = hasProfileContent(user_profile)
  const systemPrompt = withProfile
    ? `${FULL_PROFILE_HOOK_SYSTEM}\n\n${buildProfileBlock(user_profile)}`
    : NO_PROFILE_HOOK_SYSTEM

  const userPrompt = withProfile
    ? `Generate 4 compelling LinkedIn post hooks/opening lines about "${topic}" in a ${writing_style} style. Each hook should be 1-2 sentences that grab attention and feel authentically written by this author — not generic.\n\nReturn ONLY a JSON array of 4 strings, no other text.`
    : `Generate 4 professional LinkedIn post hooks about "${topic}" in a ${writing_style} style. 1-2 sentences each. Return ONLY a JSON array of 4 strings, no other text.`

  const raw = await callClaude({ systemPrompt, userPrompt })
  const parsed = JSON.parse(stripMarkdownFences(raw))
  if (!Array.isArray(parsed)) {
    throw new Error('Model did not return an array of hooks.')
  }
  return parsed.slice(0, 4)
}

async function generatePost({ topic, selected_hook, writing_style, user_profile, use_research }) {
  if (!topic || typeof topic !== 'string') {
    throw new Error('topic is required and must be a string')
  }
  if (!selected_hook || typeof selected_hook !== 'string') {
    throw new Error('selected_hook is required and must be a string')
  }
  if (!writing_style || typeof writing_style !== 'string') {
    throw new Error('writing_style is required and must be a string')
  }

  const withProfile = hasProfileContent(user_profile)
  const systemPrompt = withProfile
    ? `${FULL_PROFILE_POST_SYSTEM}\n\n${buildProfileBlock(user_profile)}`
    : NO_PROFILE_POST_SYSTEM

  const researchNote = use_research
    ? `\n- Weave in relevant facts, stats, or examples from your training data where they strengthen the argument (no fabrication — only include specifics you are confident about)`
    : ''

  const userPrompt = withProfile
    ? `Write a LinkedIn post about "${topic}" in a ${writing_style} style. Start with this hook: "${selected_hook}"\n\nRequirements:\n- 150-250 words, optimized for LinkedIn\n- Short, punchy paragraphs with line breaks for readability\n- Reference the author's real experience and accomplishments where relevant\n- End with a thought-provoking question or call to action\n- No hashtags, no emojis${researchNote}\n- Must sound like the author wrote it, not a ghostwriter`
    : `Write a professional LinkedIn post about "${topic}" in a ${writing_style} style. Start with this hook: "${selected_hook}"\n\n150-250 words. Short, punchy paragraphs with line breaks. End with a question or call to action. No hashtags, no emojis.${researchNote}`

  const raw = await callClaude({ systemPrompt, userPrompt, maxTokens: 1500 })
  return raw.trim()
}

async function getTrendingTopics() {
  if (GNEWS_API_KEY) {
    try {
      const query = 'leadership OR "artificial intelligence" OR entrepreneurship OR "customer experience" OR "future of work"'
      const params = new URLSearchParams({
        q: query,
        lang: 'en',
        max: '8',
        apikey: GNEWS_API_KEY,
      })
      const res = await fetch(`https://gnews.io/api/v4/search?${params.toString()}`)
      if (res.ok) {
        const data = await res.json()
        const topics = (data.articles || [])
          .map((a) => a.title)
          .filter(Boolean)
          .slice(0, 8)
        if (topics.length > 0) return topics
      } else {
        console.error('[podium-mcp] GNews error:', res.status, await res.text())
      }
    } catch (err) {
      console.error('[podium-mcp] GNews fetch failed:', err.message)
    }
  }

  const raw = await callClaude({
    systemPrompt: TRENDING_SYSTEM,
    userPrompt: `Suggest 8 trending LinkedIn topics for business creators right now. Return ONLY a JSON array of 8 strings, no other text.`,
    maxTokens: 512,
  })
  const parsed = JSON.parse(stripMarkdownFences(raw))
  if (!Array.isArray(parsed)) {
    throw new Error('Model did not return an array of topics.')
  }
  return parsed.slice(0, 8)
}

async function improvePost({ existing_post, instruction }) {
  if (!existing_post || typeof existing_post !== 'string') {
    throw new Error('existing_post is required and must be a string')
  }
  if (!instruction || typeof instruction !== 'string') {
    throw new Error('instruction is required and must be a string')
  }

  const userPrompt = `Here is the existing LinkedIn post:\n\n"""\n${existing_post}\n"""\n\nInstruction: ${instruction}\n\nReturn only the improved post — no explanations, preamble, or meta commentary.`
  const raw = await callClaude({
    systemPrompt: IMPROVE_POST_SYSTEM,
    userPrompt,
    maxTokens: 1500,
  })
  return raw.trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP server setup
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'generate_hooks',
    description: 'Generate 4 LinkedIn opening hooks for a given topic and writing style. Optionally personalised to a user profile.',
    annotations: {
      title: 'Generate LinkedIn Hooks',
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The topic of the LinkedIn post (e.g. "Leadership", "AI in customer service").',
        },
        writing_style: {
          type: 'string',
          description: 'The desired writing style: storytelling, educational, contrarian, inspirational, data-driven, or conversational.',
        },
        user_profile: {
          type: 'object',
          description: 'Optional author profile for personalised hooks. Fields: name, headline, industry, accomplishments, expertise, summary, targetAudience, communicationStyle, voiceSamples.',
          properties: {
            name: { type: 'string' },
            headline: { type: 'string' },
            industry: { type: 'string' },
            accomplishments: { type: 'string' },
            expertise: { type: 'string' },
            summary: { type: 'string' },
            targetAudience: { type: 'string' },
            communicationStyle: { type: 'string' },
            voiceSamples: { type: 'string' },
          },
        },
      },
      required: ['topic', 'writing_style'],
    },
  },
  {
    name: 'generate_post',
    description: 'Generate a full LinkedIn post from a topic, selected hook, and writing style. Optionally personalised to a user profile.',
    annotations: {
      title: 'Generate LinkedIn Post',
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The topic of the LinkedIn post.',
        },
        selected_hook: {
          type: 'string',
          description: 'The opening hook line the post should start with.',
        },
        writing_style: {
          type: 'string',
          description: 'The desired writing style: storytelling, educational, contrarian, inspirational, data-driven, or conversational.',
        },
        user_profile: {
          type: 'object',
          description: 'Optional author profile for personalisation.',
          properties: {
            name: { type: 'string' },
            headline: { type: 'string' },
            industry: { type: 'string' },
            accomplishments: { type: 'string' },
            expertise: { type: 'string' },
            summary: { type: 'string' },
            targetAudience: { type: 'string' },
            communicationStyle: { type: 'string' },
            voiceSamples: { type: 'string' },
          },
        },
        use_research: {
          type: 'boolean',
          description: 'Whether to weave in research-backed facts, stats, or examples from training data.',
        },
      },
      required: ['topic', 'selected_hook', 'writing_style'],
    },
  },
  {
    name: 'get_trending_topics',
    description: 'Return 8 current trending business and LinkedIn topics. Uses GNews when configured; otherwise Claude-generated suggestions.',
    annotations: {
      title: 'Get Trending Topics',
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'improve_post',
    description: 'Improve an existing LinkedIn post based on a natural-language instruction (e.g. "make it shorter", "add more data", "more contrarian").',
    annotations: {
      title: 'Improve LinkedIn Post',
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        existing_post: {
          type: 'string',
          description: 'The current post content to improve.',
        },
        instruction: {
          type: 'string',
          description: 'How the post should be improved.',
        },
      },
      required: ['existing_post', 'instruction'],
    },
  },
]

function createMcpServer() {
  const server = new Server(
    {
      name: 'podium-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    console.log('[podium-mcp] tool call:', name)

    try {
      let result
      switch (name) {
        case 'generate_hooks':
          result = await generateHooks(args)
          return {
            content: [{ type: 'text', text: JSON.stringify({ hooks: result }, null, 2) }],
          }
        case 'generate_post':
          result = await generatePost(args)
          return {
            content: [{ type: 'text', text: result }],
          }
        case 'get_trending_topics':
          result = await getTrendingTopics()
          return {
            content: [{ type: 'text', text: JSON.stringify({ topics: result }, null, 2) }],
          }
        case 'improve_post':
          result = await improvePost(args)
          return {
            content: [{ type: 'text', text: result }],
          }
        default:
          throw new Error(`Unknown tool: ${name}`)
      }
    } catch (err) {
      console.error(`[podium-mcp] ${name} failed:`, err.message)
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${err.message}` }],
      }
    }
  })

  return server
}

// ─────────────────────────────────────────────────────────────────────────────
// Express app — stateless Streamable HTTP transport
// ─────────────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '4mb' }))

// CORS — allow Claude.ai and any MCP client.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, mcp-session-id, mcp-protocol-version'
  )
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'podium-mcp-server',
    version: '1.0.0',
    anthropicConfigured: !!ANTHROPIC_API_KEY,
    gnewsConfigured: !!GNEWS_API_KEY,
    model: MODEL,
  })
})

// MCP endpoint — stateless: each request builds a fresh server + transport.
app.post('/mcp', async (req, res) => {
  try {
    const server = createMcpServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    })

    res.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    console.error('[podium-mcp] /mcp handler error:', err)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
})

// GET and DELETE are only used in stateful mode — reject cleanly.
app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. This server runs in stateless mode — use POST /mcp.' },
    id: null,
  })
})

app.delete('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. This server runs in stateless mode.' },
    id: null,
  })
})

// Root — friendly info page.
app.get('/', (_req, res) => {
  res.json({
    service: 'podium-mcp-server',
    endpoints: {
      health: 'GET /health',
      mcp: 'POST /mcp',
    },
    tools: TOOLS.map((t) => t.name),
  })
})

app.listen(PORT, () => {
  console.log(`[podium-mcp] listening on :${PORT}`)
  console.log(`[podium-mcp] health: http://localhost:${PORT}/health`)
  console.log(`[podium-mcp] mcp:    http://localhost:${PORT}/mcp`)
})
