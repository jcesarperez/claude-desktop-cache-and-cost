declare module 'claude-code' {
  interface PluginState {
    'Cache': {
      lastAt: Shaped<number | null>
      isRunning: Shaped<boolean>
    }
  }
}
