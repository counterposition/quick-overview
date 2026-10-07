import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, PluginOptions, RenderElement } from 'claude-code'

import {
  cardText,
  codeTerms,
  decide,
  docsIndex,
  formatConversation,
  isTrivial,
  namesProject,
  parseDotenv,
  repoMap,
} from '../hooks/overview'
import {
  classifierEndpoint,
  openaiDecisionsBody,
  overviewEndpoint,
  parseFallbackClassification,
  parseOpenAIDecisions,
} from '../hooks/providers'
import type { Settings } from '../hooks/providers'

const PLUGIN = 'fast-overview'
const CARD = '**In short:** CRDTs merge by math, not by coordination.\n- Join semilattice'

type Fetch = { url: string; body: Record<string, unknown> }
type Gate = { kind: string; explain: number }

/** The world beneath the plugin: a fake classifier and overview model, and a disk that records writes. */
function world(on: On, gate: Gate, { cardDelayMs = 0, status = 200 } = {}) {
  const fetches: Fetch[] = []
  const writes = new Map<string, string>()
  const lines: string[] = []
  mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000 })

  on('http.fetch', async ($, e) => {
    fetches.push({ url: e.url, body: JSON.parse(e.init?.body ?? '{}') })
    if (status !== 200) return { value: { status, ok: false, headers: {}, text: '{"error":"nope"}' } }
    const json = e.url.includes('openai.com/v1/decisions')
      ? {
          answers: [
            { type: 'choice', name: 'kind', choice: gate.kind, confidence: 0.9 },
            { type: 'predicate', name: 'wants_explanation', probability: gate.explain },
          ],
        }
      : e.url.includes('systemone')
        ? { answers: { kind: { choice: gate.kind, confidence: 0.99 }, wants_explanation: { noul: gate.explain } } }
        : JSON.parse(e.init?.body ?? '{}').max_tokens === 40
          ? { choices: [{ message: { content: JSON.stringify({ kind: gate.kind, explain: gate.explain }) } }] }
          : { choices: [{ message: { content: CARD } }] }
    if (cardDelayMs > 0 && e.url.includes('chat/completions')) await clock.sleep(cardDelayMs)

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(json) } }
  })
  on('session.messages', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.write', ($, e) => {
    writes.set(e.path, e.text)

    return { value: undefined }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'src/auth.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // What the engine draws when the plugin passes: nothing, here.
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as RenderElement)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    if (e.to !== 'debug') lines.push(e.text)

    return { value: undefined }
  })

  const logs = () => [...writes.values()].map(text => JSON.parse(text) as Record<string, unknown>)

  return { fetches, logs, lines, clock }
}

const band = {
  plugin: PLUGIN,
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const DIRECT: PluginOptions = { cerebras_api_key: 'c-key', typesafe_api_key: 't-key', log: 'full' }
const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
const host = (url: string) => new URL(url).host

describe('the band', () => {
  test('shows a card for a concept question, then asks for a rating', { options: DIRECT }, async ($, on) => {
    const { fetches, logs, clock } = world(on, { kind: 'concept', explain: 0.8 })

    await $.prompt.submit(submit('How do CRDTs converge?'))
    await clock.settle()

    expect(fetches.map(f => host(f.url))).toEqual(['api.typesafe.ai', 'api.cerebras.ai'])
    const ui = await $.ui.mount(band)
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('CRDTs merge by math')

    await $.turn.complete({ answer: 'The long answer.', durationMs: 9000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()

    await ui.press({ key: 'helpful' })
    expect(logs().at(-1)).toMatchObject({
      prompt: 'How do CRDTs converge?',
      shown: true,
      gate: { classifier: 'Jev', kind: 'concept' },
      card: { source: 'Cerebras' },
      rating: 'helpful',
      claude: { answer: 'The long answer.' },
    })
    expect(await ui.find({ key: 'helpful' })).toBeUndefined()
  })

  test('logs nothing and offers no rating by default', { options: { cerebras_api_key: 'c' } }, async ($, on) => {
    const { logs, clock } = world(on, { kind: 'concept', explain: 0.8 })

    await $.prompt.submit(submit('How do CRDTs converge?'))
    await clock.settle()
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()

    const ui = await $.ui.mount(band)
    expect(await ui.find({ key: 'show' })).toBeDefined()
    expect(await ui.find({ key: 'helpful' })).toBeUndefined()
    expect(logs()).toHaveLength(0)
  })

  test('stays empty for a task, and never asks for a card', { options: DIRECT }, async ($, on) => {
    const { fetches, clock } = world(on, { kind: 'task', explain: 0.2 })

    await $.prompt.submit(submit('fix the failing test in auth_test.go'))
    await clock.settle()

    expect(fetches).toHaveLength(1)
    const ui = await $.ui.mount(band)
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  })

  test('grounds a codebase question in the project', { options: DIRECT }, async ($, on) => {
    const { fetches, clock } = world(on, { kind: 'codebase', explain: 0.9 })

    await $.prompt.submit(submit('walk me through how `authMiddleware` works'))
    await clock.settle()

    expect(fetches[0]?.body.state).toMatchObject({ project: 'proj' })
    const messages = fetches[1]?.body.messages as { content: string }[]
    expect(messages[1]?.content).toContain('<project name="proj">')
    expect(messages[1]?.content).toContain('<directory_map>\n1 files\nsrc/ (1 files)\n  auth.ts')
  })

  test('shares nothing about the project when asked not to', { options: { ...DIRECT, share_project: false } }, async ($, on) => {
    const { fetches, clock } = world(on, { kind: 'codebase', explain: 0.9 })

    await $.prompt.submit(submit('walk me through how `authMiddleware` works'))
    await clock.settle()

    expect(fetches[0]?.body.state).not.toHaveProperty('project')
    const messages = fetches[1]?.body.messages as { content: string }[]
    expect(messages[1]?.content).not.toContain('<project')
  })

  test('treats a question naming the project as one about the codebase', { options: DIRECT }, async ($, on) => {
    const { fetches, clock } = world(on, { kind: 'concept', explain: 0.9 })

    await $.prompt.submit(submit('I would like to understand the architecture of Proj'))
    await clock.settle()

    const messages = fetches[1]?.body.messages as { content: string }[]
    expect(messages[0]?.content).toContain("about the user's own project")
  })

  test('works with an OpenRouter key alone, pinned to fast providers', { options: { openrouter_api_key: 'or' } }, async ($, on) => {
    const { fetches, clock } = world(on, { kind: 'concept', explain: 0.8 })

    await $.prompt.submit(submit('How do CRDTs converge?'))
    await clock.settle()

    expect(fetches.map(f => f.url)).toEqual([
      'https://openrouter.ai/api/v1/systemone',
      'https://openrouter.ai/api/v1/chat/completions',
    ])
    expect(fetches[0]?.body.model).toBe('~typesafe/jev-latest')
    expect(fetches[1]?.body).toMatchObject({
      model: 'qwen/qwen3.8-27b',
      reasoning: { effort: 'none' },
      provider: { order: ['cerebras', 'groq'], allow_fallbacks: false },
    })
  })

  test('asks GPT-6 Luna Decisions directly in OpenAI’s format', { options: { cerebras_api_key: 'c', openai_api_key: 'o', classifier: 'luna' } }, async ($, on) => {
    const { fetches, clock } = world(on, { kind: 'concept', explain: 0.8 })

    await $.prompt.submit(submit('How do CRDTs converge?'))
    await clock.settle()

    expect(fetches[0]?.url).toBe('https://api.openai.com/v1/decisions')
    expect(fetches[0]?.body).toMatchObject({ model: 'gpt-6-luna', questions: [{ type: 'choice', name: 'kind' }, { type: 'predicate' }] })
    const ui = await $.ui.mount(band)
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('CRDTs merge by math')
  })

  test('gives up on a card that takes too long', { options: DIRECT }, async ($, on) => {
    const { logs, clock } = world(on, { kind: 'concept', explain: 0.8 }, { cardDelayMs: 10_000 })

    await $.prompt.submit(submit('How do CRDTs converge?'))
    await clock.settle()
    const ui = await $.ui.mount(band)
    expect((await ui.find({ type: 'Text' }))?.text).toContain('Writing a quick overview')

    await clock.advance(4_000)
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    expect(logs().at(-1)?.error).toContain('took over 4000 ms')
  })

  test('says once, in the transcript, when a key is rejected', { options: DIRECT }, async ($, on) => {
    const { lines, clock } = world(on, { kind: 'concept', explain: 0.8 }, { status: 401 })

    await $.prompt.submit(submit('How do CRDTs converge?'))
    await clock.settle()
    await $.prompt.submit(submit('How do vector clocks work?'))
    await clock.settle()

    expect(lines.filter(l => l.includes('Jev rejected the API key'))).toHaveLength(1)
  })

  test('asks for a key when it has none', async ($, on) => {
    const { fetches, lines, clock } = world(on, { kind: 'concept', explain: 0.8 })

    await $.prompt.submit(submit('How do CRDTs converge?'))
    await clock.settle()

    expect(fetches).toHaveLength(0)
    expect(lines.join('\n')).toContain('An OpenRouter key alone is enough')
  })
})

describe('the providers', () => {
  const auto: Settings = { overviewProvider: 'auto', overviewModel: '', classifier: 'auto' }

  test('prefer direct keys, fastest first, and fall back to OpenRouter', () => {
    expect(overviewEndpoint({ groq: 'g', openrouter: 'o' }, auto)?.label).toBe('Groq')
    expect(overviewEndpoint({ cerebras: 'c', groq: 'g' }, auto)?.label).toBe('Cerebras')
    expect(overviewEndpoint({ openrouter: 'o' }, { ...auto, overviewModel: 'x/y' })?.model).toBe('x/y')
    expect(overviewEndpoint({}, auto)).toBeUndefined()

    const label = (keys: Parameters<typeof classifierEndpoint>[0], classifier: Settings['classifier'] = 'auto') => {
      const found = classifierEndpoint(keys, { ...auto, classifier })
      return typeof found === 'string' ? found : found?.label
    }
    expect(label({ typesafe: 't', openrouter: 'o' })).toBe('Jev')
    expect(label({ liquid: 'l', cerebras: 'c' })).toBe('d1')
    expect(label({ openrouter: 'o' })).toBe('Jev via OpenRouter')
    expect(label({ cerebras: 'c' })).toBe('overview-model')
    expect(label({ openrouter: 'o' }, 'clef')).toBe('Clef via OpenRouter')
    expect(label({ openai: 'k' }, 'luna')).toBe('GPT-6 Luna Decisions')
    expect(label({ cerebras: 'c' }, 'clef')).toBeUndefined()
  })

  test('translate the gate to and from OpenAI’s Decisions format', () => {
    const body = openaiDecisionsBody('gpt-6-luna', { prompt: 'hi' }, {
      kind: { type: 'choice', instructions: 'Which?', criteria: { a: 'A thing', b: 'B thing' } },
      yes: { type: 'noul', instructions: 'Is it?', criteria: { true: 'it is', false: 'it is not' } },
    })
    expect(body).toEqual({
      model: 'gpt-6-luna',
      input: '{"prompt":"hi"}',
      questions: [
        { type: 'choice', name: 'kind', instructions: 'Which?', choices: [{ value: 'a', description: 'A thing' }, { value: 'b', description: 'B thing' }] },
        { type: 'predicate', name: 'yes', instructions: 'Is it? True when: it is False when: it is not' },
      ],
    })
    expect(
      parseOpenAIDecisions({
        answers: [
          { name: 'kind', choice: 'concept', confidence: 0.76 },
          { name: 'wants_explanation', probability: 0.65 },
        ],
      }),
    ).toEqual({ kind: { choice: 'concept', confidence: 0.76 }, wants_explanation: { noul: 0.65 } })
  })

  test('read a classification the overview model wrote', () => {
    expect(parseFallbackClassification('```json\n{"kind": "codebase", "explain": 1.4}\n```')).toEqual({
      kind: { choice: 'codebase' },
      wants_explanation: { noul: 1 },
    })
    expect(parseFallbackClassification('no idea')).toEqual({})
  })
})

describe('the gate', () => {
  test('shows explanations of concepts, code and trade-offs only', () => {
    expect(decide({ kind: { choice: 'concept' }, wants_explanation: { noul: 0.8 } }, 'auto').show).toBe(true)
    expect(decide({ kind: { choice: 'discussion' }, wants_explanation: { noul: 0.6 } }, 'auto').show).toBe(true)
    expect(decide({ kind: { choice: 'concept' }, wants_explanation: { noul: 0.3 } }, 'auto').show).toBe(false)
    expect(decide({ kind: { choice: 'task' }, wants_explanation: { noul: 0.9 } }, 'auto').show).toBe(false)
    expect(decide({ kind: { choice: 'task' }, wants_explanation: { noul: 0.1 } }, 'always').show).toBe(true)
    expect(decide({ kind: { choice: 'concept' }, wants_explanation: { noul: 0.9 } }, 'off').show).toBe(false)
    expect(decide({}, 'auto')).toEqual({ show: false, kind: 'other', explainP: 0 })
  })

  test('reads a project name as a codebase question, never a concept', () => {
    const answers = { kind: { choice: 'concept' }, wants_explanation: { noul: 0.9 } }
    expect(decide(answers, 'auto', true).kind).toBe('codebase')
    expect(decide({ ...answers, kind: { choice: 'task' } }, 'auto', true).kind).toBe('task')
    expect(namesProject('the architecture of Oh My Pi', 'oh-my-pi')).toBe(true)
    expect(namesProject('how does hermes_agent route tools?', 'hermes-agent')).toBe(true)
    expect(namesProject('what is a model?', 'mod')).toBe(false)
  })

  test('skips slash commands, shell escapes and one-word replies without asking anyone', () => {
    expect(isTrivial('/compact')).toBe(true)
    expect(isTrivial('! ls')).toBe(true)
    expect(isTrivial('thanks')).toBe(true)
    expect(isTrivial('why is the sky blue?')).toBe(false)
  })
})

describe('the context', () => {
  test('finds identifiers worth searching for', () => {
    expect(codeTerms('how does `refresh token` flow through sessionStore and auth/middleware.go?')).toEqual([
      'refresh token',
      'sessionStore',
      'auth/middleware.go',
    ])
    expect(codeTerms('what is a monad?')).toEqual([])
  })

  test('maps a repository by its largest parts, not its first files', () => {
    const paths = [
      'Cargo.toml',
      'README.md',
      'crates/pi-ast/src/lib.rs',
      ...Array.from({ length: 5 }, (_, i) => `packages/coding-agent/src/f${i}.ts`),
      'packages/ai/src/index.ts',
      'docs/architecture.md',
    ]
    expect(repoMap(paths)).toBe(
      [
        '10 files',
        'packages/ (6 files)',
        '  coding-agent/ (5)',
        '  ai/ (1)',
        'crates/ (1 files)',
        '  pi-ast/ (1)',
        'docs/ (1 files)',
        '  architecture.md',
        'Cargo.toml',
        'README.md',
      ].join('\n'),
    )
    expect(docsIndex(paths)).toBe('docs/architecture.md')
    expect(docsIndex(['src/a.ts'])).toBeUndefined()
  })

  test('drops the prompt itself and keeps the last turns', () => {
    const text = formatConversation(
      [
        { role: 'user', text: 'first', toolUses: [] },
        {
          role: 'assistant',
          text: 'Reading it.',
          toolUses: [{ tool_use_id: 'tu1', tool: 'Read', input: { file_path: 'a.go' }, text: 'package a' }],
        },
        { role: 'user', text: 'and now?', toolUses: [] },
      ],
      'and now?',
      { turns: 1, perMessage: 100, perTool: 100 },
    )
    expect(text).toBe('ASSISTANT: Reading it.\n[Read a.go]\npackage a')
  })

  test('reads the card and the keys', () => {
    expect(cardText({ choices: [{ message: { content: '<think>hm</think>\n\nCard' } }] })).toBe('Card')
    expect(cardText({ choices: [{ message: { content: '' } }] })).toBeUndefined()
    expect(parseDotenv('A=1\nexport B="two"\n# c\n')).toEqual({ A: '1', B: 'two' })
  })
})
