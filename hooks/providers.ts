// Where the overview and the classifier come from: which provider, which model, which key.
// Two wire formats cover every provider: OpenAI-style chat completions for the overview,
// and the System One decision API (TypeSafe's, also served by Liquid and OpenRouter) for the gate.
// OpenRouter alone reaches every model here, about 50 ms (cards) to 100 ms (decisions) slower
// than calling the provider directly.

import type { GateAnswers } from './overview'

export type KeyName = 'cerebras' | 'groq' | 'openrouter' | 'typesafe' | 'liquid' | 'openai'
export type Keys = Partial<Record<KeyName, string>>

export type OverviewProvider = 'cerebras' | 'groq' | 'openrouter'
export type ClassifierChoice = 'jev' | 'd1' | 'clef' | 'clef-flash' | 'luna' | 'overview-model'

export type Settings = {
  overviewProvider: 'auto' | OverviewProvider
  overviewModel: string
  classifier: 'auto' | ClassifierChoice
}

export type Endpoint = {
  /** What the card header and the logs call it. */
  label: string
  url: string
  key: string
  model: string
  /** Provider-specific fields merged into the request body. */
  extra: Record<string, unknown>
  /** A decision endpoint's wire format; System One unless it says otherwise. */
  format?: 'openai-decisions'
}

const CHAT: Record<OverviewProvider, Omit<Endpoint, 'key'>> = {
  cerebras: {
    label: 'Cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    model: 'qwen-3.8-27b',
    // Qwen reasons by default and spends the whole budget doing it; the card needs none.
    extra: { reasoning_effort: 'none' },
  },
  groq: {
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'qwen/qwen3.8-27b',
    extra: { reasoning_effort: 'none' },
  },
  openrouter: {
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'qwen/qwen3.8-27b',
    // Left to route freely, OpenRouter sent this model to a provider taking 7.5 s a card.
    extra: { reasoning: { effort: 'none' }, provider: { order: ['cerebras', 'groq'], allow_fallbacks: false } },
  },
}

const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/v1/systemone'

type Decider = {
  label: string
  openrouterModel: string
  direct?: { keyName: KeyName; url: string; model: string; format?: 'openai-decisions' }
}

const DECIDERS: Record<Exclude<ClassifierChoice, 'overview-model'>, Decider> = {
  jev: {
    label: 'Jev',
    openrouterModel: '~typesafe/jev-latest',
    direct: { keyName: 'typesafe', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  },
  d1: {
    label: 'd1',
    openrouterModel: 'liquid/d1',
    direct: { keyName: 'liquid', url: 'https://api.liquid.ai/decisions/v1/systemone', model: 'd1' },
  },
  clef: { label: 'Clef', openrouterModel: 'cloudflare/clef' },
  'clef-flash': { label: 'Clef Flash', openrouterModel: 'cloudflare/clef-flash' },
  luna: {
    label: 'GPT-6 Luna Decisions',
    openrouterModel: 'openai/gpt-6-luna-decisions',
    direct: { keyName: 'openai', url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', format: 'openai-decisions' },
  },
}

/** A decision model through its own API when that key is set, else through OpenRouter. */
function decider(choice: Exclude<ClassifierChoice, 'overview-model'>, keys: Keys): Endpoint | undefined {
  const { label, openrouterModel, direct } = DECIDERS[choice]
  const directKey = direct && keys[direct.keyName]
  if (direct && directKey) {
    return { label, url: direct.url, model: direct.model, key: directKey, extra: {}, format: direct.format }
  }
  if (keys.openrouter) {
    return { label: `${label} via OpenRouter`, url: OPENROUTER_DECISIONS_URL, model: openrouterModel, key: keys.openrouter, extra: {} }
  }

  return undefined
}

/** Fastest first, as measured: Cerebras about 0.5 s a card, Groq about 1.2 s, OpenRouter adds a hop. */
const OVERVIEW_ORDER: readonly OverviewProvider[] = ['cerebras', 'groq', 'openrouter']
/** Jev about 140 ms, d1 about 250 ms; with no decision model reachable, the overview model judges. */
const CLASSIFIER_ORDER: readonly ClassifierChoice[] = ['jev', 'd1', 'overview-model']

export function overviewEndpoint(keys: Keys, settings: Settings): Endpoint | undefined {
  const order = settings.overviewProvider === 'auto' ? OVERVIEW_ORDER : [settings.overviewProvider]
  const id = order.find(p => keys[p])
  if (!id) return undefined
  const key = keys[id] as string

  return { ...CHAT[id], key, model: settings.overviewModel.trim() || CHAT[id].model }
}

/** The decision endpoint to ask, `overview-model` to ask the overview model instead, or undefined. */
export function classifierEndpoint(keys: Keys, settings: Settings): Endpoint | 'overview-model' | undefined {
  const order = settings.classifier === 'auto' ? CLASSIFIER_ORDER : [settings.classifier]
  for (const choice of order) {
    if (choice === 'overview-model') return overviewEndpoint(keys, settings) ? 'overview-model' : undefined
    const endpoint = decider(choice, keys)
    if (endpoint) return endpoint
  }

  return undefined
}

export function chatBody(endpoint: Endpoint, messages: readonly unknown[], maxTokens: number): Record<string, unknown> {
  return { model: endpoint.model, ...endpoint.extra, max_tokens: maxTokens, temperature: 0.3, messages }
}

export function headers(endpoint: Endpoint): Record<string, string> {
  return {
    Authorization: `Bearer ${endpoint.key}`,
    'Content-Type': 'application/json',
    // Some providers sit behind bot filters that refuse a request with no agent named.
    'User-Agent': 'fast-overview',
  }
}

/** A sentence a person can act on, for a provider's refusal. */
export function describeFailure(label: string, status: number, body: string): string {
  if (status === 401 || status === 403) return `${label} rejected the API key (HTTP ${status}).`
  if (status === 404) return `${label} does not know that model (HTTP 404): ${body.slice(0, 160)}`
  if (status === 429) return `${label} is rate-limiting requests (HTTP 429).`
  if (status === 402) return `${label} says the account is out of credit (HTTP 402).`

  return `${label} answered HTTP ${status}: ${body.slice(0, 160)}`
}

type SystemOneQuestion = {
  type: 'choice' | 'noul'
  instructions: string
  criteria: Record<string, string>
}

/** The gate's questions in OpenAI's Decisions format: a list, `predicate` for noul, choices as values. */
export function openaiDecisionsBody(model: string, state: unknown, questions: Record<string, SystemOneQuestion>) {
  return {
    model,
    input: JSON.stringify(state),
    questions: Object.entries(questions).map(([name, q]) =>
      q.type === 'choice'
        ? {
            type: 'choice',
            name,
            instructions: q.instructions,
            choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description })),
          }
        : {
            type: 'predicate',
            name,
            instructions: `${q.instructions} True when: ${q.criteria.true ?? 'yes'} False when: ${q.criteria.false ?? 'no'}`,
          },
    ),
  }
}

/** OpenAI's list of answers, keyed by name as System One answers them. */
export function parseOpenAIDecisions(body: unknown): GateAnswers {
  const answers = (body as { answers?: { name?: string; choice?: string; confidence?: number; probability?: number }[] })
    ?.answers
  const byName = new Map((answers ?? []).map(a => [a.name, a]))
  const kind = byName.get('kind')
  const explain = byName.get('wants_explanation')

  return {
    kind: kind ? { choice: kind.choice, confidence: kind.confidence } : undefined,
    wants_explanation: explain ? { noul: explain.probability } : undefined,
  }
}

/** A one-shot classification by the overview model, for when no decision model is configured. */
export function fallbackClassifierMessages(state: Record<string, unknown>): unknown[] {
  return [
    {
      role: 'system',
      content:
        'You classify a message a developer sent to an AI coding assistant. Reply with JSON only: {"kind": one of "concept" | "codebase" | "discussion" | "task" | "other", "explain": a number from 0 to 1}. kind: concept = understand a general idea; codebase = understand their own project (named in `project`); discussion = an opinion or trade-off; task = wants work done; other = anything else. explain = how likely they will sit and read a long explanatory reply.',
    },
    { role: 'user', content: JSON.stringify(state) },
  ]
}

export function parseFallbackClassification(text: string): GateAnswers {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return {}
  try {
    const parsed = JSON.parse(json) as { kind?: unknown; explain?: unknown }
    const explain = typeof parsed.explain === 'number' ? Math.min(1, Math.max(0, parsed.explain)) : undefined

    return {
      kind: typeof parsed.kind === 'string' ? { choice: parsed.kind } : undefined,
      wants_explanation: explain === undefined ? undefined : { noul: explain },
    }
  } catch {
    return {}
  }
}
