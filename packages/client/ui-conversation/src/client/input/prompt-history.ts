/** Shell-like prompt history, persisted in localStorage so it survives
 * reloads. Walked by ArrowUp/ArrowDown in the composer (see InputBar). */

const STORAGE_KEY = 'dsh.promptHistory.v1'
const MAX_ENTRIES = 100

export function readPromptHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    return []
  }
}

/** Records a submitted prompt (newest first, deduped against the latest
 * entry). Returns the updated history. */
export function recordPromptHistory(prompt: string): string[] {
  const text = prompt.trim()
  if (text === '') return readPromptHistory()
  const history = readPromptHistory()
  if (history[0] === text) return history
  history.unshift(text)
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  } catch {
    /* storage unavailable — history stays session-only */
  }
  return history
}
