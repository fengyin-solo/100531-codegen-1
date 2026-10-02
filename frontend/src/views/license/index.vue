<template>
  <section class="page" data-module="license">
    <header class="page-head">
      <div>
        <h2>证照台账管理</h2>
        <p class="page-desc">{{ meta.desc }}</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">登记延期报批</button>
        <button class="btn" type="button" @click="exportRows">导出证照清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <form v-if="showCreate" class="create-panel" @submit.prevent="submitCreate">
      <h3 class="create-title">登记延期报批</h3>
      <div class="create-grid">
        <label class="filter-item">
          <span>许可证号</span>
          <input v-model="form.许可证号" placeholder="如 LIC-0008" />
        </label>
        <label class="filter-item">
          <span>发证机关</span>
          <input v-model="form.发证机关" placeholder="如 国家文物局" />
        </label>
        <label class="filter-item">
          <span>资质等级</span>
          <input v-model="form.资质等级" placeholder="如 甲级" />
        </label>
        <label class="filter-item">
          <span>证照有效期</span>
          <input v-model="form.证照有效期" placeholder="YYYY-MM-DD" />
        </label>
        <label class="filter-item">
          <span>下一次延期报批日</span>
          <input v-model="form.下一次延期报批日" placeholder="YYYY-MM-DD" />
        </label>
        <label class="filter-item">
          <span>关联探方</span>
          <select v-model="form.关联探方">
            <option value="">请选择探方</option>
            <option v-for="option in trenchOptions" :key="option" :value="option">
              {{ option }}
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>经办人</span>
          <input v-model="form.经办人" placeholder="经办人姓名" />
        </label>
      </div>
      <div class="create-actions">
        <button class="btn primary" type="submit">提交报批</button>
        <button class="btn ghost" type="button" @click="toggleCreate">取消</button>
      </div>
      <p class="create-hint">
        有效期须为合法日期（YYYY-MM-DD），非法值直接退回重填；同一本证照已有在办报批的，只认先到的那一回。
      </p>
    </form>

    <div class="board">
      <section
        v-for="column in boardColumns"
        :key="column.key"
        class="board-column"
        :class="{ 'board-column-urgent': column.urgent }"
      >
        <h3>{{ column.title }}</h3>
        <article
          v-for="card in column.cards"
          :key="String(card.id)"
          class="license-card"
          :class="{ expired: isExpiredUnrenewed(card) }"
        >
          <header class="card-head">
            <strong>{{ card['许可证号'] }}</strong>
            <span class="status-badge">{{ card.status }}</span>
          </header>
          <dl class="card-fields">
            <div>
              <dt>发证机关</dt>
              <dd>{{ card['发证机关'] }}</dd>
            </div>
            <div>
              <dt>资质等级</dt>
              <dd>{{ card['资质等级'] }}</dd>
            </div>
            <div>
              <dt>证照有效期</dt>
              <dd>
                {{ card['证照有效期'] }}
                <em v-if="expiryHint(card)" class="expiry-hint">{{ expiryHint(card) }}</em>
              </dd>
            </div>
            <div>
              <dt>下一次延期报批日</dt>
              <dd>{{ card['下一次延期报批日'] }}</dd>
            </div>
            <div>
              <dt>关联探方</dt>
              <dd>{{ card['关联探方'] }}（现场状态：{{ trenchStatusOf(card) }}）</dd>
            </div>
            <div>
              <dt>经办人</dt>
              <dd>{{ card['经办人'] }}</dd>
            </div>
          </dl>
          <p v-if="isExpiredUnrenewed(card)" class="expired-tag">过期未换发</p>
          <footer class="card-actions">
            <button
              v-if="nextActionOf(card)"
              class="link"
              type="button"
              @click="runAction(nextActionOf(card)!, card)"
            >
              {{ nextActionOf(card) }}
            </button>
            <span v-else class="done-text">已办结</span>
          </footer>
        </article>
        <p v-if="!column.cards.length" class="empty-state">暂无记录</p>
      </section>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条证照记录 · 状态依次流转：待受理 → 已受理 → 已批复 → 已换发，中途不许越级</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createLicenseEntry,
  daysUntilDate,
  downloadEntries,
  isExpiredUnrenewed,
  isNearExpiry,
  isValidDateString,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('license')
const NEAR_EXPIRY_DAYS = 30
const filterFields = ['许可证号', '发证机关', '资质等级']
// 每个状态只放行下一个动作，页面上就看不到越级入口；服务端同样校验。
const NEXT_ACTION: Record<string, string> = {
  待受理: '提交受理',
  已受理: '提交批复',
  已批复: '办理换发',
}

const rows = ref<EntryRow[]>([])
const trenches = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const showCreate = ref(false)

const emptyForm = () => ({
  许可证号: '',
  发证机关: '',
  资质等级: '',
  证照有效期: '',
  下一次延期报批日: '',
  关联探方: '',
  经办人: '',
})
const form = ref(emptyForm())

const stats = computed(() => [
  { label: '临近到期证照', value: rows.value.filter((row) => isNearExpiry(row, NEAR_EXPIRY_DAYS)).length },
  { label: '过期未换发', value: rows.value.filter((row) => isExpiredUnrenewed(row)).length },
  { label: '已换发证照', value: rows.value.filter((row) => String(row.status) === '已换发').length },
])

const statusSummary = computed(() =>
  meta.statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

type BoardColumn = { key: string; title: string; urgent: boolean; cards: EntryRow[] }

function expiryDays(row: EntryRow): number {
  const value = String(row['证照有效期'] ?? '')
  return isValidDateString(value) ? daysUntilDate(value) : Number.MAX_SAFE_INTEGER
}

function sortByExpiry(cards: EntryRow[]): EntryRow[] {
  return [...cards].sort((a, b) => expiryDays(a) - expiryDays(b))
}

// 分栏：临近到期的挑到最前面一栏，其余按发证机关分栏，栏内按有效期先后排。
const boardColumns = computed<BoardColumn[]>(() => {
  const near = rows.value.filter((row) => isNearExpiry(row, NEAR_EXPIRY_DAYS))
  const rest = rows.value.filter((row) => !isNearExpiry(row, NEAR_EXPIRY_DAYS))
  const groups = new Map<string, EntryRow[]>()
  for (const row of rest) {
    const authority = String(row['发证机关'] ?? '').trim() || '未填写发证机关'
    const list = groups.get(authority) ?? []
    list.push(row)
    groups.set(authority, list)
  }
  const columns: BoardColumn[] = [
    { key: '__near__', title: `临近到期（${NEAR_EXPIRY_DAYS}日内）`, urgent: true, cards: sortByExpiry(near) },
  ]
  const authorities = [...groups.entries()].sort(
    (a, b) => Math.min(...a[1].map(expiryDays)) - Math.min(...b[1].map(expiryDays)),
  )
  for (const [authority, cards] of authorities) {
    columns.push({ key: authority, title: authority, urgent: false, cards: sortByExpiry(cards) })
  }
  return columns
})

const trenchOptions = computed(() => trenches.value.map((row) => String(row['探方编号'])))

function nextActionOf(row: EntryRow): string | null {
  return NEXT_ACTION[String(row.status)] ?? null
}

function expiryHint(row: EntryRow): string {
  const value = String(row['证照有效期'] ?? '')
  if (!isValidDateString(value) || String(row.status) === '已换发') {
    return ''
  }
  const days = daysUntilDate(value)
  if (days < 0) {
    return `已过期 ${-days} 天`
  }
  if (days <= NEAR_EXPIRY_DAYS) {
    return `剩余 ${days} 天`
  }
  return ''
}

function trenchStatusOf(row: EntryRow): string {
  const hit = trenches.value.find((item) => String(item['探方编号']) === String(row['关联探方']))
  if (!hit) {
    return '未登记'
  }
  return `${hit.status}${hit.abnormal ? '（异常）' : ''}`
}

function toggleCreate() {
  showCreate.value = !showCreate.value
  errorMessage.value = ''
}

function submitCreate() {
  errorMessage.value = ''
  okMessage.value = ''
  const result = createLicenseEntry({ ...form.value })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  form.value = emptyForm()
  showCreate.value = false
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    trenches.value = listRows('trench')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '证照台账列表读取失败'
  }
}

onMounted(reload)
</script>
