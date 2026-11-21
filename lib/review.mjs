// 合版审查与换版牵连分析：
// - 底图兼容性：专题版 compatibleBase 必须包含本版 job.base；
// - 局部修订：来源 changeArea 会把有效范围扩大到编辑没点到的交叠窗口，
//   受牵连窗口标 pendingReview，旧校样仍按原清单可查；
// - 复用 vs 混用：同物理切片被多个窗口按各自层引用是允许的复用；
//   同一窗口同一层出现两个版次的物理件即意外混用；
// - 交付条件：规定窗口内各专题完整覆盖、无缺件、底图与界线依据兼容、无待审。

import { intersects } from './geo.mjs'
import { editionFromUri } from './store.mjs'

export function reviewPlan(plan, store, { changedWindows = [], changeAreas = [] } = {}) {
  const findings = []
  const windowStates = new Map(plan.windows.map(window => [window.window, { status: 'ready', reasons: [] }]))

  const mark = (windowId, status, reason) => {
    const state = windowStates.get(windowId)
    if (!state) return
    if (status === 'pendingReview') state.status = 'pendingReview'
    state.reasons.push(reason)
  }

  // 1. 缺件与两种空白的显式记账。
  for (const window of plan.windows) {
    for (const cell of window.layers.flatMap(layer => layer.cells)) {
      if (cell.status === 'missing') {
        mark(window.window, 'pendingReview', `缺件 ${cell.edition} ${cell.matrix}/${cell.row}/${cell.col}（${cell.sides.join('、')}侧边界）`)
        findings.push({ kind: 'missing', window: window.window, cell })
      } else if (cell.status === 'blank') {
        findings.push({ kind: 'blank', window: window.window, cell })
      } else if (cell.status === 'outside') {
        findings.push({ kind: 'outside', window: window.window, cell })
      }
    }
  }

  // 2. 底图兼容性（专题版声明的 compatibleBase）。
  for (const window of plan.windows) {
    const themeEdition = store.editions.get(window.edition)
    const compatible = themeEdition?.compatibleBase
    if (compatible && !compatible.includes(plan.base)) {
      mark(window.window, 'pendingReview',
        `专题版 ${window.edition} 仅兼容底图 ${compatible.join('、')}，本版底图为 ${plan.base}`)
      findings.push({ kind: 'incompatibleBase', window: window.window, expected: compatible, actual: plan.base })
    }
  }

  // 3. 换版牵连：changeArea 与任何窗口采集区相交即扩大有效范围，
  //    包括编辑没有点到的邻窗。
  for (const area of changeAreas) {
    for (const window of plan.windows) {
      if (intersects(window.region, area.area)) {
        const note = `换版 ${area.edition} 的 changeArea ${JSON.stringify(area.area)} 与窗口采集区相交`
        mark(window.window, 'pendingReview', note)
        findings.push({ kind: 'changeAreaImpact', window: window.window, edition: area.edition, area: area.area, requested: changedWindows.includes(window.window) })
      }
    }
  }

  // 4. 同版相邻窗口底图依据不一致（新底图使两窗不能继续拼在一起）。
  //    物理版次按解析后的 uri 判定：继承自旧版的像素物理上仍是旧版切片。
  const baseByWindow = new Map()
  for (const window of plan.windows) {
    const bases = new Set()
    for (const layer of window.layers) {
      if (layer.role !== 'base') continue
      for (const cell of layer.cells) {
        if (cell.status === 'available') bases.add(editionFromUri(cell.resolution.uri))
      }
    }
    baseByWindow.set(window.window, [...bases])
  }
  const distinctBases = new Set([...baseByWindow.values()].flat())
  if (distinctBases.size > 1) {
    for (const window of plan.windows) {
      mark(window.window, 'pendingReview',
        `相邻窗口底图版次不一致：${[...baseByWindow.entries()].map(([id, bases]) => `${id}=${bases.join('+')}`).join('，')}`)
    }
    findings.push({ kind: 'baseMismatchAcrossWindows', bases: [...baseByWindow.entries()] })
  }

  // 5. 复用与混用识别。
  const mixing = detectMixing(plan)
  for (const item of mixing) {
    mark(item.window, 'pendingReview', `同一层意外混用版次：${item.layer} 层同时引用 ${item.editions.join('、')}`)
    findings.push({ kind: 'mixedEditions', ...item })
  }
  const reuse = detectReuse(plan)

  const deliverable = plan.complete &&
    [...windowStates.values()].every(state => state.status !== 'pendingReview') &&
    !findings.some(finding => finding.kind === 'incompatibleBase' || finding.kind === 'mixedEditions' || finding.kind === 'baseMismatchAcrossWindows')

  return {
    deliverable,
    windows: [...windowStates.entries()].map(([window, state]) => ({ window, ...state })),
    findings,
    reuse,
    mixing,
  }
}

// 同一窗口同一层（base/theme）的物理切片若来自两个版次，即混用。
// 继承自旧版的像素属于目标版目录明示承接，按目标版计，不算混用。
export function detectMixing(plan) {
  const result = []
  for (const window of plan.windows) {
    for (const layer of window.layers) {
      const editions = new Set()
      for (const cell of layer.cells) {
        if (cell.status !== 'available') continue
        editions.add(cell.edition)
      }
      if (editions.size > 1) {
        result.push({ window: window.window, layer: layer.role, editions: [...editions] })
      }
    }
  }
  return result
}

// 同一物理切片被多个窗口引用 = 复用（底图允许两窗共用）。
export function detectReuse(plan) {
  const usage = new Map()
  for (const window of plan.windows) {
    for (const layer of window.layers) {
      for (const cell of layer.cells) {
        if (cell.status !== 'available') continue
        const uri = cell.resolution.uri
        if (!usage.has(uri)) usage.set(uri, new Set())
        usage.get(uri).add(window.window)
      }
    }
  }
  return [...usage.entries()]
    .filter(([, windows]) => windows.size > 1)
    .map(([uri, windows]) => ({ uri, windows: [...windows] }))
}

// 为什么要复领邻窗：汇总相邻窗口之间的牵连原因。
export function neighborReacquisitionReasons(plan, review) {
  const reasons = []
  for (const finding of review.findings) {
    if (finding.kind === 'changeAreaImpact' && !finding.requested) {
      reasons.push({
        window: finding.window,
        reason: `编辑未点选该窗，但来源 ${finding.edition} 的换版有效范围覆盖到此窗，需随邻窗一并复领`,
      })
    }
    if (finding.kind === 'baseMismatchAcrossWindows') {
      for (const [window, bases] of finding.bases) {
        reasons.push({ window, reason: `邻窗底图改版后拼版依据不一致（本窗 ${bases.join('+')}），需送回编辑复核` })
      }
    }
  }
  return reasons
}
