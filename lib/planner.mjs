// 逐窗领图规划：
// 1. 窗口按出血外扩为采集区域；
// 2. 窗口横跨两套矩阵时，按服务区 priority（大者优先）切分空间归属；
// 3. 每个“矩阵 × 行 × 列”格位若在归属区内有正面积，就是该矩阵必须供给的对象；
// 4. 格位按目录与版本范围分类：available（可领）、blank（发布方明示留白）、
//    missing（资料缺损，缺件）、outside（供应商边缘以外，允许留白）；
// 5. 两种空白分别落账，绝不合并成一层透明图。

import {
  cellArea,
  expand,
  intersect,
  matrixCells,
  rectArea,
  subtractRects,
  touchingSides,
} from './geo.mjs'
import { cellKey, editionFromUri } from './store.mjs'

export function planWindow(job, windowSpec, store, { scale } = {}) {
  const region = expand(windowSpec.extent, windowSpec.bleed)
  const matrices = [...store.matrices.values()].sort((a, b) => b.priority - a.priority)

  // 按优先级切分：每个矩阵先取自身服务区与采集区的交集，再扣掉更高优先级矩阵的服务区。
  const ownership = []
  for (const matrix of matrices) {
    let covered = intersect(region, matrix.area)
    if (!covered) continue
    const higher = matrices
      .filter(other => other.priority > matrix.priority)
      .map(other => other.area)
    const owned = subtractRects(covered, higher)
    if (owned.length) ownership.push({ matrix, owned })
  }

  // 未被任何矩阵服务区覆盖的部分：供应商边缘以外，允许留白（outside）。
  const coveredByAny = matrices.map(matrix => matrix.area)
  const outsideParts = subtractRects(region, coveredByAny)

  const editionIds = [job.base, windowSpec.edition]
  const layers = editionIds.map(editionId => ({
    edition: editionId,
    role: editionId === job.base ? 'base' : 'theme',
    cells: [],
  }))

  for (const { matrix, owned } of ownership) {
    for (const cell of matrixCells(matrix)) {
      const ownedParts = owned.flatMap(part => {
        const overlap = intersect(part, cell.area)
        return overlap ? [overlap] : []
      })
      if (!ownedParts.length) continue
      const ownedArea = ownedParts.reduce((sum, part) => sum + rectArea(part), 0)
      const sides = ownedParts.flatMap(part => touchingSides(part, region))
      for (const layer of layers) {
        layer.cells.push(
          classifyCell({
            job,
            window: windowSpec,
            matrix,
            cell,
            ownedParts,
            ownedArea,
            sides: [...new Set(sides)],
            editionId: layer.edition,
            store,
          }),
        )
      }
    }
  }

  const cells = layers.flatMap(layer => layer.cells)
  const status = summarize(windowSpec, cells, outsideParts)
  return {
    window: windowSpec.id,
    theme: windowSpec.theme,
    edition: windowSpec.edition,
    base: job.base,
    scale: scale ?? null,
    extent: windowSpec.extent,
    bleed: windowSpec.bleed,
    region,
    ownership: ownership.map(({ matrix, owned }) => ({ matrix: matrix.id, priority: matrix.priority, owned })),
    outside: outsideParts,
    layers,
    ...status,
  }
}

function classifyCell({ matrix, cell, ownedParts, ownedArea, sides, editionId, store }) {
  const edition = store.editions.get(editionId)
  const catalog = store.catalogMaps.get(editionId)
  const entry = catalog?.get(cellKey(matrix.id, cell.row, cell.col))
  const base = {
    matrix: matrix.id,
    row: cell.row,
    col: cell.col,
    cellArea: cell.area,
    ownedParts,
    ownedArea,
    sides,
  }

  // 目录列出的对象才是发布方明示可取的对象；目录条目即权威。
  if (entry) {
    const resolution = store.resolveEntry(editionId, entry)
    return {
      ...base,
      status: resolution.broken ? 'missing' : 'available',
      edition: editionId,
      uri: entry.uri ?? null,
      inherited: resolution.inherited ?? false,
      resolution,
      reason: resolution.broken ? resolution.reason : undefined,
    }
  }

  // 目录没有该格：先判断格位是否整体落在版本明示范围之外。
  const withinEdition = ownedParts.some(part => intersect(part, edition.area) !== null)
  if (!withinEdition) {
    const declaredBlank = (edition.blank ?? []).some(blank =>
      ownedParts.some(part => intersect(part, blank)),
    )
    if (declaredBlank) {
      return { ...base, status: 'blank', edition: editionId, reason: '版本明示 blank 声明范围' }
    }
    return { ...base, status: 'outside', edition: editionId, reason: '版本专题明示不覆盖（供应商边缘以外）' }
  }

  // 在版本覆盖范围内、也不是 blank，却没有目录对象：资料缺损，必须按缺件记。
  const inBlank = (edition.blank ?? []).some(blank =>
    ownedParts.some(part => intersect(part, blank) !== null),
  )
  if (inBlank) {
    return { ...base, status: 'blank', edition: editionId, reason: '版本明示 blank 声明范围' }
  }
  return {
    ...base,
    status: 'missing',
    edition: editionId,
    reason: '在版本可取范围内但目录缺件，且无继承/留白声明',
  }
}

function summarize(windowSpec, cells, outsideParts) {
  const counts = { available: 0, blank: 0, missing: 0, outside: 0 }
  const missing = []
  for (const cell of cells) {
    counts[cell.status] += 1
    if (cell.status === 'missing') {
      missing.push({
        window: windowSpec.id,
        edition: cell.edition,
        matrix: cell.matrix,
        row: cell.row,
        col: cell.col,
        cellArea: cell.cellArea,
        sides: cell.sides,
        reason: cell.reason,
      })
    }
  }
  return {
    counts,
    missing,
    outsideParts,
    complete: missing.length === 0,
  }
}

export function planJob(job, store, options) {
  const windows = job.windows.map(windowSpec => planWindow(job, windowSpec, store, options))
  return {
    job: job.job,
    base: job.base,
    scale: options?.scale ?? null,
    windows,
    complete: windows.every(window => window.complete),
  }
}

// 供排版程序消费的物理对象清单（去重）：同一切片被多个窗口复用只落一份物理件，
// 但每个引用保留窗口与层归属，便于区分“复用”与“意外混用版次”。
export function collectObjects(plan) {
  const byUri = new Map()
  for (const window of plan.windows) {
    for (const layer of window.layers) {
      for (const cell of layer.cells) {
        if (cell.status !== 'available') continue
        const uri = cell.resolution.uri
        if (!byUri.has(uri)) {
          byUri.set(uri, {
            uri,
            digest: cell.resolution.digest,
            physicalEdition: editionFromUri(uri),
            inherited: cell.resolution.inherited,
            references: [],
          })
        }
        byUri.get(uri).references.push({
          window: window.window,
          edition: cell.edition,
          role: layer.role,
          matrix: cell.matrix,
          row: cell.row,
          col: cell.col,
        })
      }
    }
  }
  return [...byUri.values()].sort((a, b) => a.uri.localeCompare(b.uri))
}
