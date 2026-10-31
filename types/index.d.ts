declare module 'claude-code' {
  interface PluginState {
    'Cache': {
      lastAt: Shaped<number | null>
      ttlMs: Shaped<number>
      isRunning: Shaped<boolean>
      cachedModel: Shaped<string | null>
    }
  }
}
