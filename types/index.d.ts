export type LogLevel = 'fatal' | 'error' | 'warning' | 'notice'

// Entries seen more than once, as one: how many times, and the first's text.
export type LogGroup = {
  key: string
  level: LogLevel
  message: string
  file?: string
  line?: number
  source: string
  count: number
  // Detection time (ms) of the first and the latest occurrence.
  firstAt: number
  lastAt: number
  sample: string
}

declare module 'claude-code' {
  interface PluginState {
    'clawd-logs': {
      groups: LogGroup[]
      // Detection time of the last Dismiss: the band shows what came after.
      dismissedAt: number
      isPaused: boolean
      sources: string[]
    }
  }
}
