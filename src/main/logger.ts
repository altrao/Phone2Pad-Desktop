import { app, BrowserWindow } from 'electron'
import { createWriteStream, WriteStream } from 'fs'
import { join } from 'path'

export type LogLevel = 'info' | 'warn' | 'error'

let stream: WriteStream | null = null
let fileLogging = false

function getLogFilePath(): string {
  return join(app.getPath('logs'), 'main.log')
}

// Toggled by the renderer's Debug switch.
function setFileLogging(enabled: boolean): void {
  if (enabled === fileLogging) return
  if (!enabled) log('info', 'File logging disabled')
  fileLogging = enabled
  if (enabled) log('info', `File logging enabled: ${getLogFilePath()}`)
}

// Console + every renderer window ('log:line') + <logs>/main.log while debug is on.
function log(level: LogLevel, message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}`
  ;(level === 'info' ? console.log : console[level])(line)

  if (fileLogging) {
    try {
      stream ??= createWriteStream(getLogFilePath(), { flags: 'a' })
      stream.write(line + '\n')
    } catch {
      // Logging must never take the server down.
    }
  }

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('log:line', { level, message })
  }
}

const throttleState = new Map<string, { last: number; suppressed: number }>()

// Logs at most once per `intervalMs` per key; reports how many were dropped in between.
function logThrottled(key: string, level: LogLevel, message: string, intervalMs = 1000): void {
  const now = Date.now()
  const state = throttleState.get(key)
  if (state && now - state.last < intervalMs) {
    state.suppressed++
    return
  }
  const suffix = state?.suppressed ? ` (+${state.suppressed} suppressed)` : ''
  throttleState.set(key, { last: now, suppressed: 0 })
  log(level, message + suffix)
}

function clearThrottle(keyPrefix: string): void {
  for (const key of throttleState.keys()) {
    if (key.startsWith(keyPrefix)) throttleState.delete(key)
  }
}

export { log, logThrottled, clearThrottle, setFileLogging }
