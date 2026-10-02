import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionPayload, ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult, PermitDraft, PermitLedgerResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']
const LICENSE_KEY = 'license'
const SAFETY_KEY = 'safety'
const WARNING_DAYS = 30
const FINAL_PERMIT_STATUS = '已换发'

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function toISODate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseISODate(value: string): Date | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!matched) {
    return null
  }
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return date
}

function shiftISODate(value: string, days: number): string {
  const date = parseISODate(value)
  if (!date) {
    return ''
  }
  date.setDate(date.getDate() + days)
  return toISODate(date)
}

function daysUntil(value: string, today: Date = startOfToday()): number | null {
  const date = parseISODate(value)
  if (!date) {
    return null
  }
  return Math.round((date.getTime() - today.getTime()) / 86_400_000)
}

function isExpiredPermit(row: EntryRow): boolean {
  const remaining = daysUntil(String(row.证照有效期 ?? ''))
  return remaining !== null && remaining < 0 && row.status !== FINAL_PERMIT_STATUS
}

function isNearExpiryPermit(row: EntryRow): boolean {
  const remaining = daysUntil(String(row.证照有效期 ?? ''))
  return remaining !== null && remaining >= 0 && remaining <= WARNING_DAYS && row.status !== FINAL_PERMIT_STATUS
}

function siteStatusFromSafety(status: string): string {
  if (status === '待巡查') return '换发待跟进'
  if (status === '巡查中') return '现场跟进中'
  if (status === '已整改') return '现场已跟进'
  if (status === '已上报') return '现场已上报跟进'
  return '换发待跟进'
}

function decoratePermitRows(rows: EntryRow[], safetyRows: EntryRow[] = listRows(SAFETY_KEY)): EntryRow[] {
  const pendingLinks = safetyRows.filter((row) => String(row.关联证照 ?? '') !== '')

  return rows.map((row) => {
    const licenseNo = String(row.许可证号 ?? '')
    const linked = pendingLinks
      .filter((item) => String(item.关联证照 ?? '') === licenseNo)
      .sort((a, b) => Number(b.id) - Number(a.id))[0]
    const expired = isExpiredPermit(row)
    const remaining = daysUntil(String(row.证照有效期 ?? ''))
    const expiryLabel =
      remaining === null
        ? '日期非法'
        : remaining < 0
          ? `已过期 ${Math.abs(remaining)} 天`
          : remaining === 0
            ? '今日到期'
            : `${remaining} 天后到期`
    const siteStatus = linked
      ? siteStatusFromSafety(String(linked.status))
      : {
        '待受理': '待受理',
        '已受理': '报批处理中',
        '已批复': '待换发',
        '已换发': '换发待跟进',
      }[String(row.status)] ?? '待受理'

    return {
      ...row,
      证照有效期: String(row.证照有效期 ?? ''),
      下次延期报批日: shiftISODate(String(row.证照有效期 ?? ''), -WARNING_DAYS),
      延期报批次数: Number(row.延期报批次数 ?? 0),
      现场登记状态: siteStatus,
      剩余天数: remaining ?? '',
      到期提示: expiryLabel,
      允许延期报批: row.status === '待受理',
      pending: row.status !== FINAL_PERMIT_STATUS,
      abnormal: expired,
    }
  })
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
  if (key === LICENSE_KEY) {
    const matched = filterRows(decoratePermitRows(listRows(LICENSE_KEY)), filters)
    return { items: matched, total: matched.length, page: 1, size: matched.length }
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  payload: ActionPayload = {},
): ActionResult {
  if (key === LICENSE_KEY) {
    return runPermitAction(id, action, payload)
  }
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
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === SAFETY_KEY && String(updated.关联证照 ?? '') !== '') {
    syncPermitFromSafety(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function createPermit(draft: PermitDraft): ActionResult {
  const fields: (keyof PermitDraft)[] = ['证照名称', '许可证号', '发证机关', '资质等级', '证照有效期']
  for (const field of fields) {
    if (!draft[field]?.trim()) {
      return { ok: false, message: `请填写${field}` }
    }
  }
  const expiry = draft.证照有效期.trim()
  if (!parseISODate(expiry)) {
    return { ok: false, message: '证照有效期不是合法日期，请按 YYYY-MM-DD 退回重填' }
  }
  const rows = listRows(LICENSE_KEY)
  const licenseNo = draft.许可证号.trim()
  if (rows.some((row) => String(row.许可证号 ?? '') === licenseNo)) {
    return { ok: false, message: `许可证号 ${licenseNo} 已存在，不能重复建账` }
  }

  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id: nextId,
    status: '待受理',
    pending: true,
    abnormal: false,
    证照名称: draft.证照名称.trim(),
    许可证号: licenseNo,
    发证机关: draft.发证机关.trim(),
    资质等级: draft.资质等级.trim(),
    证照有效期: expiry,
    延期报批次数: 0,
    现场登记状态: '待受理',
  }
  saveRows(LICENSE_KEY, [...rows, row])
  return { ok: true, message: '证照已建账，当前状态「待受理」' }
}

function createOrReusePermitFollowUp(row: EntryRow): void {
  const safetyRows = listRows(SAFETY_KEY)
  const licenseNo = String(row.许可证号 ?? '')
  const existing = safetyRows.find(
    (item) => String(item.关联证照 ?? '') === licenseNo && Boolean(item.pending),
  )
  if (existing) {
    const next = [...safetyRows]
    const index = next.indexOf(existing)
    next[index] = {
      ...existing,
      status: '待巡查',
      pending: true,
      abnormal: false,
      巡查区域: String(row.发证机关 ?? ''),
      巡查类别: '证照换发跟进',
      隐患描述: `证照 ${String(row.证照名称 ?? '')} 已换发，需核对现场证照公示与持证作业范围。`,
      整改措施: '现场核对新证并回填巡查结果',
      巡查日期: toISODate(startOfToday()),
      关联证照: licenseNo,
      证照状态: FINAL_PERMIT_STATUS,
      巡查状态: '待巡查',
    }
    saveRows(SAFETY_KEY, next)
    return
  }

  const nextId = safetyRows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const followUp: EntryRow = {
    id: nextId,
    status: '待巡查',
    pending: true,
    abnormal: false,
    巡查编号: `SAFE-LIC-${String(nextId).padStart(4, '0')}`,
    巡查区域: String(row.发证机关 ?? ''),
    巡查类别: '证照换发跟进',
    隐患描述: `证照 ${String(row.证照名称 ?? '')} 已换发，需核对现场证照公示与持证作业范围。`,
    整改措施: '现场核对新证并回填巡查结果',
    巡查人: '待指派',
    巡查日期: toISODate(startOfToday()),
    关联证照: licenseNo,
    证照状态: FINAL_PERMIT_STATUS,
    巡查状态: '待巡查',
  }
  saveRows(SAFETY_KEY, [...safetyRows, followUp])
}

function syncPermitFromSafety(safetyRow: EntryRow): void {
  const licenseNo = String(safetyRow.关联证照 ?? '')
  const rows = listRows(LICENSE_KEY)
  const index = rows.findIndex((row) => String(row.许可证号 ?? '') === licenseNo)
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    现场登记状态: siteStatusFromSafety(String(safetyRow.status)),
  }
  saveRows(LICENSE_KEY, next)
}

function runPermitAction(
  id: number,
  action: string,
  payload: ActionPayload = {},
): ActionResult {
  const meta = moduleMeta(LICENSE_KEY)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const rows = listRows(LICENSE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  const current = rows[index]
  const currentStatus = String(current.status)
  if (!parseISODate(String(current.证照有效期 ?? ''))) {
    return { ok: false, message: '证照有效期不是合法日期，请按 YYYY-MM-DD 退回重填' }
  }
  const applicationCount = Number(current.延期报批次数 ?? 0)
  if (currentStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  if (action === '受理延期' && currentStatus !== FINAL_PERMIT_STATUS) {
    if (applicationCount > 0 || currentStatus !== '待受理') {
      return { ok: false, message: '同一本证照的延期报批已受理，只认先到的一回，第二条报批记录不能写入' }
    }
  }

  const statusIndex = meta.statuses.indexOf(currentStatus)
  const targetIndex = meta.statuses.indexOf(target)
  if (targetIndex !== statusIndex + 1) {
    return { ok: false, message: '状态只能依次流转：受理完成后才能批复，批复完成后才能换发，不能越级' }
  }

  let updated: EntryRow = {
    ...current,
    status: target,
    pending: target !== FINAL_PERMIT_STATUS,
  }

  if (action === '受理延期') {
    updated = {
      ...updated,
      延期报批次数: applicationCount + 1,
      首次报批日期: toISODate(startOfToday()),
      现场登记状态: '报批处理中',
    }
  }

  if (action === '批复延期') {
    updated = {
      ...updated,
      现场登记状态: '待换发',
    }
  }

  if (action === '完成换发') {
    const newExpiry = String(payload.证照有效期 ?? '').trim()
    const parsedNewExpiry = parseISODate(newExpiry)
    if (!parsedNewExpiry) {
      return { ok: false, message: '换发后的证照有效期不是合法日期，请按 YYYY-MM-DD 重新填写' }
    }
    const oldExpiry = parseISODate(String(current.证照有效期 ?? ''))
    if (!oldExpiry) {
      return { ok: false, message: '原证照有效期不是合法日期，请退回重填' }
    }
    if (parsedNewExpiry.getTime() <= oldExpiry.getTime()) {
      return { ok: false, message: '换发后的证照有效期必须晚于原有效期，请重新填写' }
    }
    updated = {
      ...updated,
      证照有效期: newExpiry,
      abnormal: false,
      现场登记状态: '换发待跟进',
    }
  }

  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows(LICENSE_KEY, nextRows)

  if (action === '完成换发') {
    createOrReusePermitFollowUp(updated)
    return { ok: true, message: '证照已完成换发，并已在安全巡查生成一条待跟进项' }
  }
  return { ok: true, message: `证照已${action}，当前状态「${target}」` }
}

function permitUrgency(row: EntryRow): number {
  return daysUntil(String(row.证照有效期 ?? '')) ?? Number.MAX_SAFE_INTEGER
}

export function loadPermitLedger(filters: Record<string, string> = {}): PermitLedgerResult {
  const items = listEntries(LICENSE_KEY, filters).items.slice().sort((a, b) => {
    const urgencyDiff = permitUrgency(a) - permitUrgency(b)
    if (urgencyDiff !== 0) return urgencyDiff
    return String(a.许可证号).localeCompare(String(b.许可证号), 'zh-Hans-CN')
  })
  const warningItems = items.filter((row) => isExpiredPermit(row) || isNearExpiryPermit(row))
  const authorities = [...new Set(items.map((row) => String(row.发证机关 ?? '未填写')))]
  const followUpCount = listRows(SAFETY_KEY).filter(
    (row) => String(row.巡查类别 ?? '') === '证照换发跟进' && Boolean(row.pending),
  ).length

  return {
    warningColumn: {
      key: 'warning',
      title: `临期与过期（${warningItems.length}）`,
      items: warningItems,
    },
    authorityColumns: authorities.map((authority) => ({
      key: authority,
      title: `发证机关：${authority}`,
      items: items.filter((row) => String(row.发证机关 ?? '未填写') === authority),
    })),
    metrics: [
      { label: '30日内临期', value: items.filter(isNearExpiryPermit).length },
      { label: '过期未换发', value: items.filter(isExpiredPermit).length },
      { label: '巡查待跟进', value: followUpCount },
    ],
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listEntries(key).items) {
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
    const rawEntries = rows[meta.key] ?? []
    const entries = meta.key === LICENSE_KEY ? decoratePermitRows(rawEntries, rows[SAFETY_KEY] ?? []) : rawEntries
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
