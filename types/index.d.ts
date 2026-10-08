/** What the user is asking for, as the gate classifies it. */
export type Kind = 'concept' | 'codebase' | 'discussion' | 'lookup' | 'task' | 'other'

export type CardStatus = 'writing' | 'ready'

export type Card = {
  id: string
  status: CardStatus
  kind: Kind
  text: string
  /** Which provider wrote it, for the header. */
  source: string
  /** Milliseconds from submit until the card was ready. */
  elapsedMs: number
  /** Claude's turn has ended; the band collapses to one row. */
  isTurnDone: boolean
  isExpanded: boolean
  /** Ratings are offered only while logging is on, since they go to the log. */
  canRate: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'quick-overview': { current: Card | null }
  }
}
