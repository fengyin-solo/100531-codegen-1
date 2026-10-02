<template>
  <section class="page license-page">
    <header class="page-head">
      <div>
        <h2>证照台账</h2>
        <p class="page-desc">
          按发证机关分栏管理许可证号、资质等级、证照有效期和下一次延期报批日；临期事项固定排在最前，过期未换发标红。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">新证照入账</button>
        <button class="btn" type="button" @click="exportRows">导出台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in ledger.metrics" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>发证机关</span>
        <input v-model="filters.发证机关" placeholder="按发证机关检索" />
      </label>
      <label class="filter-item">
        <span>许可证号</span>
        <input v-model="filters.许可证号" placeholder="按许可证号检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="license-board">
      <section class="license-column warning-column">
        <header class="column-head">
          <h3>{{ ledger.warningColumn.title }}</h3>
          <span>临期优先处理</span>
        </header>
        <p v-if="!ledger.warningColumn.items.length" class="column-empty">暂无30日内临期或过期证照</p>
        <PermitCard
          v-for="row in ledger.warningColumn.items"
          :key="`warning-${String(row.id)}`"
          :row="row"
          @action="runPermitAction"
          @renew="openRenew"
        />
      </section>

      <section v-for="column in ledger.authorityColumns" :key="column.key" class="license-column">
        <header class="column-head">
          <h3>{{ column.title }}</h3>
          <span>{{ column.items.length }} 本</span>
        </header>
        <PermitCard
          v-for="row in column.items"
          :key="`authority-${String(row.id)}`"
          :row="row"
          @action="runPermitAction"
          @renew="openRenew"
        />
      </section>
    </div>

    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <form class="modal-card" @submit.prevent="submitCreate">
        <header class="modal-head">
          <h3>新证照入账</h3>
          <button class="link" type="button" @click="closeCreate">关闭</button>
        </header>
        <label class="form-item">
          <span>证照名称</span>
          <input v-model="createForm.证照名称" placeholder="如：考古发掘许可证" />
        </label>
        <label class="form-item">
          <span>许可证号</span>
          <input v-model="createForm.许可证号" placeholder="如：LIC-NEA-2026-020" />
        </label>
        <label class="form-item">
          <span>发证机关</span>
          <input v-model="createForm.发证机关" placeholder="如：国家文物局" />
        </label>
        <label class="form-item">
          <span>资质等级</span>
          <input v-model="createForm.资质等级" placeholder="如：团体领队资质" />
        </label>
        <label class="form-item">
          <span>证照有效期</span>
          <input v-model="createForm.证照有效期" type="date" />
        </label>
        <p class="form-hint">下一次延期报批日按有效期满前30日自动登记；非法日期会直接退回重填。</p>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <footer class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="submit">保存入账</button>
        </footer>
      </form>
    </div>

    <div v-if="renewTarget" class="modal-mask" @click.self="closeRenew">
      <form class="modal-card" @submit.prevent="submitRenew">
        <header class="modal-head">
          <h3>办理换发</h3>
          <button class="link" type="button" @click="closeRenew">关闭</button>
        </header>
        <div class="renew-summary">
          <p><strong>{{ String(renewTarget.证照名称) }}</strong></p>
          <p>许可证号：{{ String(renewTarget.许可证号) }}</p>
          <p>原有效期：{{ String(renewTarget.证照有效期) }}</p>
        </div>
        <label class="form-item">
          <span>换发后证照有效期</span>
          <input v-model="renewExpiry" type="date" />
        </label>
        <p class="form-hint">换发完成后，安全巡查会新增或重置一条“证照换发跟进”待办。</p>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <footer class="modal-actions">
          <button class="btn ghost" type="button" @click="closeRenew">取消</button>
          <button class="btn primary" type="submit">确认换发</button>
        </footer>
      </form>
    </div>

    <footer class="page-foot">
      <span>报批顺序：待受理 → 已受理 → 已批复 → 已换发；同一本证照重复延期只认先到的一回。</span>
      <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { defineComponent, h, onMounted, ref, type PropType } from 'vue'

import {
  createPermit,
  downloadEntries,
  loadPermitLedger,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { ActionResult, EntryRow, PermitDraft, PermitLedgerResult } from '@/data/types'

const meta = moduleMeta('license')

const PermitCard = defineComponent({
  name: 'PermitCard',
  props: {
    row: {
      type: Object as PropType<EntryRow>,
      required: true,
    },
  },
  emits: ['action', 'renew'],
  setup(props, { emit }) {
    return () => {
      const row = props.row
      const expired = Boolean(row.abnormal)
      const status = String(row.status)
      const canAccept = Boolean(row.允许延期报批)
      const canApprove = status === '已受理'
      const canRenew = status === '已批复'

      return h('article', {
        class: ['permit-card', { expired }],
      }, [
        h('div', { class: 'card-top' }, [
          h('strong', String(row.证照名称 ?? '未命名证照')),
          h('span', { class: ['badge', expired ? 'badge-danger' : 'badge-ok'] }, String(row.到期提示)),
        ]),
        h('dl', { class: 'card-grid' }, [
          h('div', [h('dt', '许可证号'), h('dd', String(row.许可证号))]),
          h('div', [h('dt', '资质等级'), h('dd', String(row.资质等级))]),
          h('div', [h('dt', '证照有效期'), h('dd', String(row.证照有效期))]),
          h('div', [h('dt', '下次延期报批日'), h('dd', String(row.下次延期报批日))]),
          h('div', [h('dt', '当前状态'), h('dd', status)]),
          h('div', [h('dt', '现场登记状态'), h('dd', String(row.现场登记状态))]),
        ]),
        h('div', { class: 'card-actions' }, [
          canAccept
            ? h('button', {
              class: 'link',
              type: 'button',
              onClick: () => emit('action', '受理延期', row),
            }, '受理延期')
            : null,
          canApprove
            ? h('button', {
              class: 'link',
              type: 'button',
              onClick: () => emit('action', '批复延期', row),
            }, '批复延期')
            : null,
          canRenew
            ? h('button', {
              class: 'link danger-link',
              type: 'button',
              onClick: () => emit('renew', row),
            }, '完成换发')
            : null,
          !canAccept && !canApprove && !canRenew
            ? h('span', { class: 'muted-text' }, '当前无可推进动作')
            : null,
        ]),
      ])
    }
  },
})

const emptyLedger: PermitLedgerResult = {
  warningColumn: { key: 'warning', title: '临期与过期（0）', items: [] },
  authorityColumns: [],
  metrics: [],
}
const emptyDraft: PermitDraft = {
  证照名称: '',
  许可证号: '',
  发证机关: '',
  资质等级: '',
  证照有效期: '',
}

const ledger = ref<PermitLedgerResult>(emptyLedger)
const filters = ref<Record<string, string>>({ 发证机关: '', 许可证号: '' })
const errorMessage = ref('')
const successMessage = ref('')
const createOpen = ref(false)
const createForm = ref<PermitDraft>({ ...emptyDraft })
const renewTarget = ref<EntryRow | null>(null)
const renewExpiry = ref('')

function openCreate() {
  errorMessage.value = ''
  successMessage.value = ''
  createForm.value = { ...emptyDraft }
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
}

function submitCreate() {
  errorMessage.value = ''
  const result = createPermit(createForm.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  createOpen.value = false
  successMessage.value = result.message
  reload()
}

function openRenew(row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  renewTarget.value = row
  renewExpiry.value = ''
}

function closeRenew() {
  renewTarget.value = null
  renewExpiry.value = ''
}

function submitRenew() {
  if (!renewTarget.value) return
  const result = applyResult('完成换发', renewTarget.value, { 证照有效期: renewExpiry.value })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeRenew()
}

function runPermitAction(action: string, row: EntryRow) {
  applyResult(action, row)
}

function applyResult(action: string, row: EntryRow, payload = {}): ActionResult {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, payload)
  if (!result.ok) {
    errorMessage.value = result.message
    return result
  }
  successMessage.value = result.message
  reload()
  return result
}

function resetFilters() {
  filters.value = { 发证机关: '', 许可证号: '' }
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  ledger.value = loadPermitLedger(filters.value)
}

onMounted(reload)
</script>

<style scoped>
.license-board {
  display: grid;
  grid-auto-columns: minmax(290px, 1fr);
  grid-auto-flow: column;
  gap: 12px;
  align-items: start;
  overflow-x: auto;
  padding-bottom: 12px;
}
.license-column {
  background: #eef2f7;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  min-height: 240px;
}
.warning-column {
  background: #fff7ed;
  border-color: #fdba74;
  order: -10;
}
.column-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 10px;
}
.column-head h3 {
  font-size: 14px;
  margin: 0;
}
.column-head span {
  color: var(--muted);
  font-size: 12px;
}
.column-empty {
  font-size: 12px;
  color: var(--muted);
  background: #fff;
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 16px 10px;
  text-align: center;
}
.permit-card {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 10px;
}
.permit-card.expired {
  border-color: #ef4444;
  border-left-color: #b42318;
  background: #fff1f2;
}
.card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.badge {
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
  white-space: nowrap;
}
.badge-ok {
  background: #e0f2fe;
  color: #075985;
}
.badge-danger {
  background: #fee2e2;
  color: #b42318;
  font-weight: 600;
}
.card-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
  margin: 0 0 8px;
}
.card-grid div {
  display: grid;
  grid-template-columns: 104px 1fr;
  gap: 6px;
  font-size: 12px;
}
.card-grid dt {
  color: var(--muted);
}
.card-grid dd {
  margin: 0;
  word-break: break-all;
}
.card-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  border-top: 1px solid #edf1f5;
  padding-top: 8px;
}
.danger-link {
  color: #b42318;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  width: min(480px, calc(100vw - 32px));
  background: #fff;
  border-radius: 12px;
  padding: 18px;
  box-shadow: 0 18px 45px rgba(15, 23, 42, 0.22);
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.modal-head h3 {
  margin: 0;
  font-size: 17px;
}
.form-item {
  display: block;
  margin-bottom: 12px;
}
.form-item span {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 4px;
}
.form-item input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
}
.form-hint {
  color: var(--muted);
  font-size: 12px;
  margin: 0 0 10px;
}
.renew-summary {
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 12px;
  font-size: 13px;
}
.renew-summary p {
  margin: 3px 0;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.success-text {
  color: #047857;
}
</style>
