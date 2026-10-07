import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Card, Kind } from '../types'
import {
  GATE_QUESTIONS,
  KEY_FILES,
  cardMessages,
  cardText,
  clip,
  codeTerms,
  decide,
  docsIndex,
  formatConversation,
  isTrivial,
  namesProject,
  parseDotenv,
  repoMap,
} from './overview'
import type { GateAnswers, Mode, OverviewContext, ProjectSnapshot } from './overview'
import {
  chatBody,
  classifierEndpoint,
  describeFailure,
  fallbackClassifierMessages,
  headers,
  openaiDecisionsBody,
  overviewEndpoint,
  parseFallbackClassification,
  parseOpenAIDecisions,
} from './providers'
import type { Endpoint, Keys, Settings } from './providers'

const current = atom({ plugin: 'fast-overview', key: 'current' } as const, null)

/** How long each call may take before the card is given up: Claude's answer would catch up. */
const CLASSIFIER_TIMEOUT_MS = 2000
const CARD_TIMEOUT_MS = 4000
/** How long a project snapshot stays fresh. */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000

type Rating = 'helpful' | 'misleading'
type LogLevel = 'off' | 'ratings' | 'full'

type Config = Settings & { mode: Mode; shareProject: boolean; log: LogLevel; keys: Keys }

/** One prompt's record, at $FAST_OVERVIEW_LOG_DIR (default ~/.local/state/fast-overview)/<date>/<id>.json. */
type LogRecord = {
  id: string
  at: string
  mode: Mode
  cwd?: string
  prompt?: string
  gate?: { classifier: string; kind: Kind; kindConfidence?: number; explainP: number; ms: number }
  shown?: boolean
  card?: { source: string; ms: number; text?: string; isLate?: boolean }
  error?: string
  claude?: { answer: string; durationMs: number; isAborted: boolean }
  rating?: Rating
}

// Prompts from a person: the terminal, Remote Control, and an SDK host such as the desktop app.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

let config: Config | undefined
// The prompt whose card is in flight or on screen; a newer prompt supersedes it.
let latestId: string | undefined
const records = new Map<string, LogRecord>()
const noticesShown = new Set<string>()
// The repository's snapshot, gathered once per project root and shared by every card.
let snapshot: { root: string; at: number; value: Promise<ProjectSnapshot | undefined> } | undefined

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find(a => a === value) ?? fallback
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Settings from the plugin's options; keys fall back to the environment, then to the plugin's own .env. */
async function loadConfig($: EngineInterface, options: PluginOptions): Promise<Config> {
  if (config) return config
  const dotenv = await $.fs
    .read(`${$.plugin.root}/.env`)
    .then(parseDotenv)
    .catch(() => ({}) as Record<string, string>)
  const keys: Keys = {
    cerebras: nonEmpty(options.cerebras_api_key) ?? (await $.env.get('CEREBRAS_API_KEY')) ?? dotenv.CEREBRAS_API_KEY,
    groq: nonEmpty(options.groq_api_key) ?? (await $.env.get('GROQ_API_KEY')) ?? dotenv.GROQ_API_KEY,
    openrouter:
      nonEmpty(options.openrouter_api_key) ??
      (await $.env.get('OPENROUTER_API_KEY')) ??
      dotenv.OPENROUTER_API_KEY ??
      dotenv.OPENROUTER_KEY,
    typesafe: nonEmpty(options.typesafe_api_key) ?? (await $.env.get('TYPESAFE_API_KEY')) ?? dotenv.TYPESAFE_API_KEY,
    liquid:
      nonEmpty(options.liquid_api_key) ??
      (await $.env.get('LIQUID_API_KEY')) ??
      dotenv.LIQUID_API_KEY ??
      dotenv.LIQUID_AI_API_KEY,
    openai: nonEmpty(options.openai_api_key) ?? (await $.env.get('OPENAI_API_KEY')) ?? dotenv.OPENAI_API_KEY,
  }
  config = {
    keys,
    mode: pick(options.mode, ['auto', 'always', 'off'], 'auto'),
    overviewProvider: pick(options.overview_provider, ['auto', 'cerebras', 'groq', 'openrouter'], 'auto'),
    overviewModel: nonEmpty(options.overview_model) ?? '',
    classifier: pick(options.classifier, ['auto', 'jev', 'd1', 'clef', 'clef-flash', 'luna', 'overview-model'], 'auto'),
    shareProject: options.share_project !== false,
    log: pick(options.log, ['off', 'ratings', 'full'], 'off'),
  }

  return config
}

/** A line in the transcript, once per load for each `key`. */
function noticeOnce($: EngineInterface, key: string, line: string) {
  if (noticesShown.has(key)) return
  noticesShown.add(key)
  $.ui.log(`fast-overview: ${line}`)
}

async function save($: EngineInterface, id: string, patch: Partial<LogRecord>) {
  const record = records.get(id)
  if (!record || !config || config.log === 'off') return
  Object.assign(record, patch)
  const home = await $.env.get('HOME')
  const dir = (await $.env.get('FAST_OVERVIEW_LOG_DIR')) ?? (home && `${home}/.local/state/fast-overview`)
  if (!dir) return
  // At `ratings`, nothing the person or Claude wrote is kept: only verdicts, timings and the rating.
  const kept: LogRecord =
    config.log === 'full'
      ? record
      : {
          ...record,
          cwd: undefined,
          prompt: undefined,
          claude: undefined,
          card: record.card && { ...record.card, text: undefined },
        }
  await $.fs
    .write(`${dir}/${record.at.slice(0, 10)}/${id}.json`, `${JSON.stringify(kept, null, 2)}\n`)
    .catch(err => $.ui.log(`fast-overview: could not write log: ${String(err)}`, { to: 'debug' }))
}

async function withTimeout<T>($: EngineInterface, ms: number, work: Promise<T>): Promise<T | 'timeout'> {
  return Promise.race([work, $.clock.sleep(ms).then(() => 'timeout' as const)])
}

function projectSnapshot($: EngineInterface, root: string, now: number): Promise<ProjectSnapshot | undefined> {
  if (snapshot?.root !== root || now - snapshot.at > SNAPSHOT_TTL_MS) {
    snapshot = { root, at: now, value: gatherSnapshot($, root) }
  }

  return snapshot.value
}

/** The repository's shape and its key files; nothing outside a git repository or at the home directory. */
async function gatherSnapshot($: EngineInterface, root: string): Promise<ProjectSnapshot | undefined> {
  if (root === (await $.env.get('HOME'))) return undefined
  const tracked = await $.process
    .run(['git', 'ls-files'], { cwd: root, timeoutMs: 5000 })
    .then(r => (r.exitCode === 0 ? r.stdout : undefined))
    .catch(() => undefined)
  if (tracked === undefined) return undefined
  const paths = tracked.split('\n').filter(Boolean)
  const atRoot = new Set(paths.filter(p => !p.includes('/')))
  const keyFiles = (
    await Promise.all(
      KEY_FILES.filter(f => atRoot.has(f.path)).map(f =>
        $.fs
          .read(`${root}/${f.path}`)
          .then(text => ({ path: f.path, text: clip(text, f.chars) }))
          .catch(() => undefined),
      ),
    )
  ).filter(f => f !== undefined)

  return { name: projectName(root), map: repoMap(paths), docs: docsIndex(paths), keyFiles }
}

function projectName(root: string): string {
  return root.split('/').filter(Boolean).at(-1) ?? root
}

/** Lines of the project mentioning identifiers the prompt names. */
async function searchMatches($: EngineInterface, root: string, prompt: string): Promise<string | undefined> {
  const terms = codeTerms(prompt)
  if (terms.length === 0) return undefined

  return $.process
    .run(['rg', '-n', '-F', '--max-count', '2', '--max-columns', '200', ...terms.flatMap(t => ['-e', t]), '.'], {
      cwd: root,
      timeoutMs: 1500,
    })
    .then(r => (r.stdout.trim() ? clip(r.stdout, 4000) : undefined))
    .catch(() => undefined)
}

/** POSTs JSON and answers the parsed body, or throws a sentence a person can act on. */
async function post($: EngineInterface, endpoint: Endpoint, body: unknown): Promise<unknown> {
  const res = await $.http.fetch(endpoint.url, {
    method: 'POST',
    headers: headers(endpoint),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const failure = describeFailure(endpoint.label, res.status, res.text)
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      noticeOnce($, `auth:${endpoint.label}`, failure)
    }
    throw new Error(failure)
  }

  return JSON.parse(res.text) as unknown
}

async function classify(
  $: EngineInterface,
  cfg: Config,
  state: Record<string, unknown>,
): Promise<{ answers: GateAnswers; classifier: string }> {
  const target = classifierEndpoint(cfg.keys, cfg)
  if (target === undefined) throw new Error(`no key reaches the ${cfg.classifier} classifier`)
  if (target === 'overview-model') {
    const endpoint = overviewEndpoint(cfg.keys, cfg) as Endpoint
    const body = await post($, endpoint, chatBody(endpoint, fallbackClassifierMessages(state), 40))

    return {
      answers: parseFallbackClassification(cardText(body) ?? ''),
      classifier: `${endpoint.model} on ${endpoint.label}`,
    }
  }
  if (target.format === 'openai-decisions') {
    const body = await post($, target, openaiDecisionsBody(target.model, state, GATE_QUESTIONS))

    return { answers: parseOpenAIDecisions(body), classifier: target.label }
  }
  const body = (await post($, target, { model: target.model, state, questions: GATE_QUESTIONS })) as {
    answers: GateAnswers
  }

  return { answers: body.answers, classifier: target.label }
}

async function runOverview($: EngineInterface, options: PluginOptions, id: string, prompt: string, startedAt: number) {
  const cfg = await loadConfig($, options)
  const endpoint = overviewEndpoint(cfg.keys, cfg)
  if (!endpoint) {
    noticeOnce(
      $,
      'no-key',
      'add an API key to see overviews: /plugin → Installed → fast-overview → Configure options. An OpenRouter key alone is enough.',
    )
    return
  }

  const messages = await $.session.messages()
  const root = await $.session.root()
  // Started now so they are ready, or nearly, once the classifier has answered.
  const project = cfg.shareProject ? projectSnapshot($, root, startedAt) : Promise.resolve(undefined)
  const matches = cfg.shareProject ? searchMatches($, root, prompt) : Promise.resolve(undefined)
  const name = projectName(root)

  const gateStarted = await $.clock.now()
  const gate = await withTimeout(
    $,
    CLASSIFIER_TIMEOUT_MS,
    classify($, cfg, {
      ...(cfg.shareProject ? { project: name } : {}),
      prompt,
      recent_conversation: formatConversation(messages, prompt, { turns: 4, perMessage: 600, perTool: 0 }),
    }),
  )
  if (gate === 'timeout') throw new Error(`the classifier took over ${CLASSIFIER_TIMEOUT_MS} ms`)
  const decision = decide(gate.answers, cfg.mode, cfg.shareProject && namesProject(prompt, name))
  await save($, id, {
    gate: {
      classifier: gate.classifier,
      kind: decision.kind,
      kindConfidence: gate.answers.kind?.confidence,
      explainP: decision.explainP,
      ms: (await $.clock.now()) - gateStarted,
    },
    shown: decision.show,
  })
  if (!decision.show || latestId !== id) return

  await update($, current, () => ({
    id,
    status: 'writing',
    kind: decision.kind,
    text: '',
    source: endpoint.label,
    elapsedMs: 0,
    isTurnDone: false,
    isExpanded: true,
    canRate: cfg.log !== 'off',
  }))

  const context: OverviewContext = {
    prompt,
    kind: decision.kind,
    conversation: formatConversation(messages, prompt, { turns: 8, perMessage: 2500, perTool: 1200 }),
    project: await project,
    matches: await matches,
  }
  const body = await withTimeout($, CARD_TIMEOUT_MS, post($, endpoint, chatBody(endpoint, cardMessages(context), 600)))
  if (body === 'timeout') throw new Error(`${endpoint.label} took over ${CARD_TIMEOUT_MS} ms to write the card`)
  const card = cardText(body)
  if (!card) throw new Error(`${endpoint.label} returned no card text`)

  const elapsedMs = (await $.clock.now()) - startedAt
  // Claude's turn may have ended first; turn.complete then cleared the card, and it stays cleared.
  const shown = await update($, current, c =>
    c?.id === id && c.status === 'writing' ? { ...c, status: 'ready' as const, text: card, elapsedMs } : c,
  )
  await save($, id, { card: { source: endpoint.label, ms: elapsedMs, text: card, isLate: shown?.id !== id } })

  if (shown?.id === id) await privacyNotice($, endpoint, cfg)
}

/** Says once per machine what the cards send where; a store that cannot be written never costs the card. */
async function privacyNotice($: EngineInterface, endpoint: Endpoint, cfg: Config) {
  const wasShown = await $.store.get('privacyNoticeShown').catch(() => true)
  if (wasShown) return
  await $.store.set('privacyNoticeShown', true).catch(() => undefined)
  $.ui.log(
    `fast-overview: overview cards are written by ${endpoint.label} from your prompt, the recent conversation` +
      `${cfg.shareProject ? ' and a snapshot of this repository' : ''}. /overview off turns them off; ` +
      '/plugin → fast-overview → Configure options stops sharing the repository.',
  )
}

async function rate($: EngineInterface, id: string, rating: Rating) {
  await save($, id, { rating })
  await update($, current, c => (c?.id === id ? null : c))
  $.ui.toast(`Overview marked ${rating}`)
}

/** Changes the plugin's `mode` option as the /config menu would; undefined once written, else why not. */
async function setMode($: EngineInterface, mode: Mode): Promise<string | undefined> {
  const row = (await $.config.list()).find(r => r.provider.plugin === $.plugin.name && r.key.endsWith('.mode'))
  if (!row) return 'the mode setting is not in /config here'
  const { deny } = await $.config.set({ key: row.key, value: mode })

  return deny
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const cfg = await loadConfig($, options)
    if (cfg.shareProject) void $.session.root().then(async root => projectSnapshot($, root, await $.clock.now()))
    await $.command.register({
      name: 'overview',
      description: 'Fast overview cards: auto (a classifier decides), always, off, or no argument for the current setup',
      argumentHint: '[auto|always|off]',
    })

    return next(e)
  })

  on('command.run', { command: 'overview' }, async ($, e) => {
    const cfg = await loadConfig($, options)
    const arg = e.args.trim()
    if (arg === '') {
      const endpoint = overviewEndpoint(cfg.keys, cfg)
      const classifier = classifierEndpoint(cfg.keys, cfg)
      const classifierLabel = classifier === 'overview-model' ? 'the overview model' : (classifier?.label ?? 'none')

      return {
        text: `Fast overview is ${cfg.mode}. Cards: ${endpoint ? `${endpoint.model} on ${endpoint.label}` : 'no API key set'}. Classifier: ${classifierLabel}.`,
      }
    }
    if (arg !== 'auto' && arg !== 'always' && arg !== 'off') {
      return { text: `Unknown mode "${arg}". Use auto, always or off.` }
    }

    const refused = await setMode($, arg)
    if (refused) {
      return { text: `Could not change the mode (${refused}). Set it in /plugin → fast-overview → Configure options.` }
    }
    if (arg === 'off') await update($, current, () => null)

    return { text: `Fast overview is now ${arg}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    const cfg = await loadConfig($, options)
    const isEligible =
      e.turnId === undefined && PERSON_ORIGINS.has(e.origin.kind) && cfg.mode !== 'off' && !isTrivial(e.text)
    if (!isEligible) return next(e)

    const startedAt = await $.clock.now()
    const id = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
    latestId = id
    records.set(id, {
      id,
      at: new Date(startedAt).toISOString(),
      mode: cfg.mode,
      cwd: await $.session.cwd(),
      prompt: e.text,
    })
    await update($, current, () => null)

    // Started before next(e): that resolves only after the UserPromptSubmit settings hooks ran.
    void runOverview($, options, id, e.text, startedAt).catch(async err => {
      const message = err instanceof Error ? err.message : String(err)
      $.ui.log(`fast-overview: ${message}`, { to: 'debug' })
      await update($, current, c => (c?.id === id ? null : c))
      await save($, id, { error: message })
    })

    const entered = await next(e)
    if (entered.drop !== undefined && latestId === id) {
      latestId = undefined
      await update($, current, c => (c?.id === id ? null : c))
    }

    return entered
  })

  on('turn.complete', async ($, e, next) => {
    const id = latestId
    if (e.agentId === undefined && id !== undefined && records.has(id)) {
      // A card still being written when Claude finishes is no use any more.
      await update($, current, c =>
        c?.id !== id ? c : e.isAborted || c.status === 'writing' ? null : { ...c, isTurnDone: true, isExpanded: false },
      )
      await save($, id, {
        claude: { answer: clip(e.answer, 20000), durationMs: e.durationMs, isAborted: e.isAborted },
      })
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const card = await read($, current)
    if (card === null || e.props.hasSurvey) return next(e)

    const { Box, Button, Markdown, Text } = $.ui.resolve(e)

    if (card.status === 'writing') {
      return <Text dimColor>⚡ Writing a quick overview…</Text>
    }

    const setExpanded = (isExpanded: boolean) => () =>
      update($, current, c => (c?.id === card.id ? { ...c, isExpanded } : c))
    const dismiss = () => update($, current, c => (c?.id === card.id ? null : c))
    const ratingButtons = card.canRate
      ? [
          <Button key="helpful" hotkey="h" label="helpful" onPress={() => rate($, card.id, 'helpful')} />,
          <Button key="misleading" hotkey="m" label="misleading" onPress={() => rate($, card.id, 'misleading')} />,
        ]
      : []
    // The hotkeys answer only once the band has the keyboard; a click works too.
    const keysHint = <Text dimColor>(ctrl+x tab for keys)</Text>

    if (!card.isExpanded) {
      return (
        <Box gap={1}>
          <Text dimColor>⚡ Quick overview ({card.kind})</Text>
          <Button key="show" hotkey="s" label="show" onPress={setExpanded(true)} />
          {ratingButtons}
          <Button key="dismiss" hotkey="x" label="dismiss" role="dismiss" dimColor onPress={dismiss} />
          {keysHint}
        </Box>
      )
    }

    const seconds = (card.elapsedMs / 1000).toFixed(1)

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box gap={1}>
          <Text color="yellow">⚡</Text>
          <Text bold>Quick overview</Text>
          <Text dimColor>
            {card.kind} · {card.source} · {seconds}s{card.isTurnDone ? '' : ' · Claude is still answering'}
          </Text>
        </Box>
        <Markdown text={card.text} />
        <Box gap={1}>
          {card.isTurnDone ? ratingButtons : null}
          {card.isTurnDone ? (
            <Button key="collapse" hotkey="s" label="collapse" dimColor onPress={setExpanded(false)} />
          ) : null}
          <Button key="dismiss" hotkey="x" label="dismiss" role="dismiss" dimColor onPress={dismiss} />
          {keysHint}
        </Box>
      </Box>
    )
  })
}
