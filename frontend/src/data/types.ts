/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionPayload = {
  证照有效期?: string
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type PermitDraft = {
  证照名称: string
  许可证号: string
  发证机关: string
  资质等级: string
  证照有效期: string
}

export type PermitLedgerResult = {
  warningColumn: {
    key: string
    title: string
    items: EntryRow[]
  }
  authorityColumns: {
    key: string
    title: string
    items: EntryRow[]
  }[]
  metrics: { label: string; value: number }[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
