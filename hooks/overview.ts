// Pure logic for the overview: the gate, the context the overview model reads,
// and the messages it is sent. Nothing here touches `$`, so tests run it directly.

import type { SessionMessage } from 'claude-code'

import type { Kind } from '../types'

/** Below this probability that the user will read a long explanation, no overview. */
export const EXPLAIN_THRESHOLD = 0.5

/** auto: the classifier decides; always: every prompt worth one; off: none. */
export type Mode = 'auto' | 'always' | 'off'

/** The gate's questions, in the System One format that Jev, d1 and OpenRouter all take. */
export const GATE_QUESTIONS = {
  kind: {
    type: 'choice',
    instructions:
      'The user typed `prompt` to Claude, an AI coding assistant running in their software project, whose directory is named `project`; `recent_conversation` is what came just before. What is the user mainly asking for?',
    criteria: {
      concept:
        'To understand a general concept, technology, algorithm or idea that is not specific to their own code.',
      codebase:
        'To understand how their own project or code works: its architecture, a module, a data flow, or why it is built the way it is. A question naming `project` (in any spelling or spacing) or one of its parts is about their own project.',
      discussion: "Claude's opinion on ideas: a trade-off analysis, a design critique, or a brainstorm.",
      lookup:
        'To find real-world things that need current facts or a search: places, restaurants, products, bookings, events, prices, schedules, news, or recommendations among them.',
      task: 'For Claude to do work: write or edit code, run commands, fix a bug, investigate and change something, create files, commit or deploy.',
      other: 'A short acknowledgement, chit-chat, a yes/no or one-line factual reply, or anything else.',
    },
  },
  wants_explanation: {
    type: 'noul',
    instructions:
      'Will the user sit and read a substantial explanatory reply (several paragraphs) to `prompt`, as opposed to handing off a task or expecting a one-line answer?',
    criteria: {
      true: 'The user wants an explanation, a walkthrough, a teaching answer or a considered discussion and will read it as it arrives.',
      false: 'The user wants work done, a quick reply, or will not read a long answer.',
    },
  },
} as const

export type GateAnswers = {
  kind?: { choice?: string; confidence?: number }
  wants_explanation?: { noul?: number }
}

export type Decision = { show: boolean; kind: Kind; explainP: number }

const KINDS: readonly Kind[] = ['concept', 'codebase', 'discussion', 'lookup', 'task', 'other']
// Never `lookup`: a fast model with no search would invent the places and prices it lists.
const SHOWN: readonly Kind[] = ['concept', 'codebase', 'discussion']

/**
 * Whether the prompt names the project by its directory name, in any spacing or case:
 * `oh-my-pi` matches "Oh My Pi", `hermes-agent` matches "Hermes Agent".
 */
export function namesProject(prompt: string, project: string): boolean {
  const words = project.split(/[-_.\s]+/).filter(Boolean)
  if (words.length === 0) return false
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  return new RegExp(`\\b${escaped.join('[-_.\\s]*')}\\b`, 'i').test(prompt)
}

export function decide(answers: GateAnswers, mode: Mode, isAboutProject = false): Decision {
  const choice = answers.kind?.choice
  const chosen = KINDS.find(k => k === choice) ?? 'other'
  // Jev can read a project's name as a general topic ("the architecture of Hermes Agent").
  const kind = isAboutProject && chosen === 'concept' ? 'codebase' : chosen
  const explainP = answers.wants_explanation?.noul ?? 0
  if (mode === 'off') return { show: false, kind, explainP }
  if (mode === 'always') return { show: true, kind, explainP }

  return { show: SHOWN.includes(kind) && explainP >= EXPLAIN_THRESHOLD, kind, explainP }
}

/** Prompts not worth a classifier call: slash commands, shell escapes, one-word replies. */
export function isTrivial(prompt: string): boolean {
  const text = prompt.trim()

  return text.length < 8 || text.startsWith('/') || text.startsWith('!')
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`
}

/** The conversation before `prompt`, newest last, as plain text the models read. */
export function formatConversation(
  messages: readonly SessionMessage[],
  prompt: string,
  { turns, perMessage, perTool }: { turns: number; perMessage: number; perTool: number },
): string {
  const rows = [...messages]
  if (rows.at(-1)?.role === 'user' && rows.at(-1)?.text.trim() === prompt.trim()) rows.pop()
  const kept = rows.filter(m => m.text.trim() !== '' || m.toolUses.length > 0).slice(-turns)

  return kept
    .map(m => {
      const tools = m.toolUses
        .map(t => {
          const target = ['file_path', 'path', 'pattern', 'command']
            .map(k => t.input[k])
            .find(v => typeof v === 'string')
          const result = t.text ? `\n${clip(t.text, perTool)}` : ''

          return `[${t.tool}${target ? ` ${String(target)}` : ''}]${result}`
        })
        .join('\n')

      return `${m.role.toUpperCase()}: ${clip(m.text, perMessage)}${tools ? `\n${tools}` : ''}`
    })
    .join('\n\n')
}

/** Identifiers in the prompt worth searching the project for. */
export function codeTerms(prompt: string): string[] {
  const found = new Set<string>()
  for (const [, span] of prompt.matchAll(/`([^`\n]{3,60})`/g)) if (span) found.add(span.trim())
  for (const word of prompt.split(/[\s,;:()?!"']+/)) {
    const bare = word.replace(/[.]+$/, '')
    const isCodeLike =
      /[a-z][A-Z]/.test(bare) || // camelCase
      /^[A-Z][a-z]+[A-Z]/.test(bare) || // PascalCase compounds
      /[a-z]_[a-z]/i.test(bare) || // snake_case
      /\w\.\w{1,5}$/.test(bare) || // file.ext
      /\w\/\w/.test(bare) // a/path
    if (bare.length >= 3 && isCodeLike) found.add(bare)
  }

  return [...found].slice(0, 4)
}

/** The files whose openings say most about a repository's shape, and how much of each to read. */
export const KEY_FILES: readonly { path: string; chars: number }[] = [
  { path: 'README.md', chars: 4000 },
  { path: 'AGENTS.md', chars: 4000 },
  { path: 'CLAUDE.md', chars: 4000 },
  { path: 'package.json', chars: 1500 },
  { path: 'Cargo.toml', chars: 1500 },
  { path: 'pyproject.toml', chars: 1500 },
  { path: 'go.mod', chars: 800 },
]

/**
 * The repository's shape from its file list: every top-level directory with its file
 * count and its largest children, then the files at the root.
 */
export function repoMap(paths: readonly string[], { perDir = 12, rootFiles = 40 } = {}): string {
  const dirs = new Map<string, { count: number; children: Map<string, number> }>()
  const files: string[] = []
  for (const path of paths) {
    const [top, second, ...rest] = path.split('/')
    if (!top) continue
    if (second === undefined) {
      files.push(top)
      continue
    }
    const dir = dirs.get(top) ?? { count: 0, children: new Map<string, number>() }
    dirs.set(top, dir)
    dir.count += 1
    const child = rest.length > 0 ? `${second}/` : second
    dir.children.set(child, (dir.children.get(child) ?? 0) + 1)
  }

  const lines = [`${paths.length} files`]
  for (const [name, dir] of [...dirs].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`${name}/ (${dir.count} files)`)
    const children = [...dir.children].sort((a, b) => b[1] - a[1])
    for (const [child, count] of children.slice(0, perDir)) {
      lines.push(`  ${child}${child.endsWith('/') ? ` (${count})` : ''}`)
    }
    if (children.length > perDir) lines.push(`  … ${children.length - perDir} more`)
  }
  lines.push(...files.slice(0, rootFiles))
  if (files.length > rootFiles) lines.push(`… ${files.length - rootFiles} more files at the root`)

  return lines.join('\n')
}

/** The project's documentation pages, by path: often the best one-line summary of each part. */
export function docsIndex(paths: readonly string[], max = 80): string | undefined {
  const docs = paths.filter(p => /^(docs?|documentation|website\/docs)\//i.test(p) && /\.(md|mdx|rst|txt)$/i.test(p))
  if (docs.length === 0) return undefined

  return [...docs.slice(0, max), ...(docs.length > max ? [`… ${docs.length - max} more`] : [])].join('\n')
}

const SYSTEM = `You write a fast orientation card that a developer reads in the few seconds before a slower, more careful assistant (Claude) answers the same question in full. The card is a map of the answer, not the answer: it helps the reader follow Claude's reply when it arrives.

Format: GitHub markdown, at most 150 words.
- First line: **In short:** one sentence that frames the topic.
- Then 3 to 5 bullets, one line each: the concepts, components or terms the full answer will rest on, each with a few words of meaning.
- Optionally ONE small diagram in a \`\`\`text fenced block (at most 10 lines and 56 columns, ASCII or box-drawing characters), only when a flow, structure or relationship is clearer as a picture.
- Last line: **Watch for:** the crux the full answer should settle.

Rules:
- Every specific claim about a particular piece of software (the user's project, or any library, tool or product named in the question) must come from the context below or be widely established public knowledge. Never infer a design from a name. Name files and directories only if they appear in the context.
- The project context is the repository the user is working in. Weigh all of it: the directory map shows how large each part is, and the README and agent instructions say what the parts are for. Do not describe the project from one corner of it.
- When the context does not settle something, say what the full answer will need to establish, as something to look for, not as a fact.
- On judgement questions (should I, is it good, which is better), give no verdict or recommendation: lay out the considerations.
- No preamble, no sign-off, no headings besides the bold labels.`

const KIND_HINT: Record<Kind, string> = {
  concept: 'The question is about a general concept; use the project context only where the question touches the project.',
  codebase: "The question is about the user's own project.",
  discussion: 'The question asks for judgement. Map the considerations; do not decide.',
  task: 'The user asked for work to be done. Orient them on what the work involves.',
  lookup: 'The user wants real-world facts you cannot check. Name only what the answer will weigh, never specific places or prices.',
  other: 'Keep the card very short.',
}

/** What the mod knows about the repository, gathered once per session. */
export type ProjectSnapshot = {
  name: string
  map?: string
  docs?: string
  keyFiles: readonly { path: string; text: string }[]
}

export type OverviewContext = {
  prompt: string
  kind: Kind
  conversation: string
  project?: ProjectSnapshot
  matches?: string
}

export function cardMessages(ctx: OverviewContext): unknown[] {
  const project = ctx.project
  const sections = [
    project && `<project name="${project.name}">`,
    project?.map && `<directory_map>\n${project.map}\n</directory_map>`,
    ...(project?.keyFiles ?? []).map(f => `<file path="${f.path}">\n${f.text}\n</file>`),
    project?.docs && `<documentation_pages>\n${project.docs}\n</documentation_pages>`,
    ctx.matches && `<search_matches>\n${ctx.matches}\n</search_matches>`,
    project && '</project>',
    ctx.conversation && `<conversation_so_far>\n${ctx.conversation}\n</conversation_so_far>`,
    `<question>\n${ctx.prompt}\n</question>`,
  ].filter(Boolean)

  return [
    { role: 'system', content: `${SYSTEM}\n\n${KIND_HINT[ctx.kind]}` },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

/** The card text from a chat completion body, or undefined when it holds none. */
export function cardText(body: unknown): string | undefined {
  const choice = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string') return undefined
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

  return text === '' ? undefined : text
}

export function parseDotenv(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match?.[1]) continue
    vars[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
  }

  return vars
}
