import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'archaeology-field:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function mergeSeedRows(
  seed: Record<string, EntryRow[]>,
  stored: Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  const result: Record<string, EntryRow[]> = { ...seed }
  for (const [key, storedRows] of Object.entries(stored)) {
    const seedRows = seed[key] ?? []
    const seedById = new Map(seedRows.map((row) => [Number(row.id), row]))
    const storedIds = new Set<number>()
    const merged = storedRows.map((row) => {
      const id = Number(row.id)
      storedIds.add(id)
      const seedRow = seedById.get(id)
      return seedRow ? { ...seedRow, ...row } : row
    })
    seedRows.forEach((row) => {
      if (!storedIds.has(Number(row.id))) {
        merged.push(row)
      }
    })
    result[key] = merged
  }
  return result
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return mergeSeedRows(clone(SEED_ROWS), parsed)
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
