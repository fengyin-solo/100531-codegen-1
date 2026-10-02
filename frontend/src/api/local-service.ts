import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 证照台账用的日期工具：一律按本地日历日处理，不引入时区偏移。
const DAY_MS = 24 * 60 * 60 * 1000

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

export function isValidDateString(value: string): boolean {
  return parseLocalDate(value) !== null
}

export function todayString(): string {
  return formatDate(new Date())
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays(base: Date, days: number): string {
  return formatDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + days))
}

// 距离某个日历日还剩几天：负数表示已经过期。
export function daysUntilDate(value: string, base: Date = new Date()): number {
  const target = parseLocalDate(value)
  if (!target) {
    return Number.NaN
  }
  const today = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  return Math.round((target.getTime() - today.getTime()) / DAY_MS)
}

// 过期未换发：有效期已过且流程没走到「已换发」。
export function isExpiredUnrenewed(row: EntryRow): boolean {
  const expiry = String(row['证照有效期'] ?? '')
  return String(row.status) !== '已换发' && isValidDateString(expiry) && daysUntilDate(expiry) < 0
}

// 临近到期：未换发、有效期合法，且剩余天数落在窗口内。
export function isNearExpiry(row: EntryRow, withinDays = 30): boolean {
  const expiry = String(row['证照有效期'] ?? '')
  if (String(row.status) === '已换发' || !isValidDateString(expiry)) {
    return false
  }
  const days = daysUntilDate(expiry)
  return days >= 0 && days <= withinDays
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (meta.strictFlow) {
    const currentIndex = meta.statuses.indexOf(current)
    const targetIndex = meta.statuses.indexOf(target)
    if (targetIndex !== currentIndex + 1) {
      return {
        ok: false,
        message: `${meta.entity}状态只能依次流转（${meta.statuses.join('→')}），不能从「${current}」越级到「${target}」`,
      }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === 'license') {
    updated['证照状态'] = target
    if (action === '办理换发') {
      // 换发办结：有效期顺延一年，下一次延期报批日定为新到期日前 60 天。
      updated['证照有效期'] = addDays(new Date(), 365)
      updated['下一次延期报批日'] = addDays(new Date(), 365 - 60)
    }
    updated.abnormal = isExpiredUnrenewed(updated)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === 'license') {
    syncLinkedTrench(String(updated['关联探方'] ?? ''))
    if (action === '办理换发') {
      pushSafetyFollowUp(updated)
      return {
        ok: true,
        message: `${meta.entity}已${action}，当前状态「${target}」，换发批复已落到安全巡查待办`,
      }
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export type LicensePayload = {
  许可证号: string
  发证机关: string
  资质等级: string
  证照有效期: string
  下一次延期报批日: string
  关联探方: string
  经办人: string
}

const LICENSE_REQUIRED_FIELDS: (keyof LicensePayload)[] = [
  '许可证号',
  '发证机关',
  '资质等级',
  '证照有效期',
  '下一次延期报批日',
  '关联探方',
  '经办人',
]

// 登记一笔延期报批：日期非法直接退回重填；同一本证照已有在办报批的，只认先到的那一回。
export function createLicenseEntry(payload: LicensePayload): ActionResult {
  const cleaned = Object.fromEntries(
    LICENSE_REQUIRED_FIELDS.map((field) => [field, String(payload[field] ?? '').trim()]),
  ) as LicensePayload
  for (const field of LICENSE_REQUIRED_FIELDS) {
    if (!cleaned[field]) {
      return { ok: false, message: `${field}还没填，补齐后再提交报批` }
    }
  }
  if (!isValidDateString(cleaned.证照有效期)) {
    return {
      ok: false,
      message: `证照有效期「${cleaned.证照有效期}」不是合法日期（格式 YYYY-MM-DD），已退回重填`,
    }
  }
  if (!isValidDateString(cleaned.下一次延期报批日)) {
    return {
      ok: false,
      message: `下一次延期报批日「${cleaned.下一次延期报批日}」不是合法日期（格式 YYYY-MM-DD），已退回重填`,
    }
  }
  if (daysUntilDate(cleaned.证照有效期, parseLocalDate(cleaned.下一次延期报批日) ?? new Date()) < 0) {
    return { ok: false, message: '下一次延期报批日晚于证照有效期，日期对不上，已退回重填' }
  }
  const rows = listRows('license')
  const duplicate = rows.some(
    (row) => String(row['许可证号']) === cleaned.许可证号 && String(row.status) !== '已换发',
  )
  if (duplicate) {
    return {
      ok: false,
      message: `许可证号 ${cleaned.许可证号} 已有一笔在办的延期报批，只认先到的那一回，本次未写入`,
    }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const row: EntryRow = {
    id: nextId,
    status: '待受理',
    pending: true,
    abnormal: false,
    许可证号: cleaned.许可证号,
    发证机关: cleaned.发证机关,
    资质等级: cleaned.资质等级,
    证照有效期: cleaned.证照有效期,
    下一次延期报批日: cleaned.下一次延期报批日,
    关联探方: cleaned.关联探方,
    经办人: cleaned.经办人,
    证照状态: '待受理',
  }
  row.abnormal = isExpiredUnrenewed(row)
  saveRows('license', [...rows, row])
  syncLinkedTrench(cleaned.关联探方)
  return { ok: true, message: `证照 ${cleaned.许可证号} 的延期报批已登记，当前状态「待受理」` }
}

// 证照台账与现场登记联动：关联探方名下只要还有过期未换发的证照，探方就挂异常；都办妥了就摘掉。
function syncLinkedTrench(trenchNo: string): void {
  const no = trenchNo.trim()
  if (!no) {
    return
  }
  const linked = listRows('license').filter((row) => String(row['关联探方']) === no)
  const shouldFlag = linked.some((row) => isExpiredUnrenewed(row))
  const trenches = listRows('trench')
  let changed = false
  const next = trenches.map((row) => {
    if (String(row['探方编号']) !== no || Boolean(row.abnormal) === shouldFlag) {
      return row
    }
    changed = true
    return { ...row, abnormal: shouldFlag }
  })
  if (changed) {
    saveRows('trench', next)
  }
}

// 换发办结的批复转到安全巡查：那边因此多出一条待跟进项。
function pushSafetyFollowUp(licenseRow: EntryRow): void {
  const rows = listRows('safety')
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const followUp: EntryRow = {
    id: nextId,
    status: '待巡查',
    pending: true,
    abnormal: false,
    巡查编号: `SAFE-${String(nextId).padStart(4, '0')}`,
    巡查区域: '证照台账',
    巡查类别: '证照换发复核',
    隐患描述: `证照${licenseRow['许可证号']}（${licenseRow['发证机关']}）换发批复已办结，待现场复核确认`,
    整改措施: '待巡查确认',
    巡查人: '待指派',
    巡查日期: todayString(),
    巡查状态: '待跟进',
  }
  saveRows('safety', [...rows, followUp])
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
