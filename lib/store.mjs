// 版本与切片目录仓库：
// - /editions 首轮给全量、后续轮次只给 patch，按 id 合并；
// - /tiles/<edition>/catalog 只列可领取对象，目录之外即无对象可领；
// - inherits 是发布方明示的沿用声明，未声明继承的老切片一律不得引用；
// - 同一像素内容按目录声明的 sha256 承接，继承链逐环核对校验和。

export class EditionStore {
  #client
  #editions = new Map()
  #matrices = new Map()
  #catalogs = new Map()
  #jobs = null

  constructor(client) {
    this.#client = client
  }

  get matrices() {
    return this.#matrices
  }

  get editions() {
    return this.#editions
  }

  get catalogMaps() {
    return this.#catalogs
  }

  get jobs() {
    return this.#jobs
  }

  async loadEditions() {
    const body = await this.#client.requireJson('/editions')
    if (Array.isArray(body.matrices)) {
      // 全量应答（首轮）：重置矩阵表。
      this.#matrices = new Map(body.matrices.map(matrix => [matrix.id, matrix]))
    }
    // 后续轮次只给 patch：矩阵与未被替换的版本沿用上一轮应答。
    const rows = body.editions ?? body.patch ?? []
    for (const row of rows) {
      this.#editions.set(row.id, { ...this.#editions.get(row.id), ...row })
    }
    return [...this.#editions.values()]
  }

  // 从第 0 次发布引导全量版本与矩阵，再逐轮重放补丁，
  // 保证在任意发布时刻都持有“沿用上一轮且未被替换”的完整版本视图。
  async bootstrap({ currentStep }) {
    const step = Number(currentStep)
    if (!Number.isInteger(step) || step <= 0) {
      return this.loadEditions()
    }
    await this.#client.setStep(0)
    await this.loadEditions()
    for (let index = 1; index <= step; index++) {
      await this.#client.setStep(index)
      await this.loadEditions()
    }
    return [...this.#editions.values()]
  }

  async loadJobs() {
    this.#jobs = await this.#client.requireJson('/jobs')
    return this.#jobs
  }

  async catalog(editionId, seen = new Set()) {
    if (this.#catalogs.has(editionId)) return this.#catalogs.get(editionId)
    if (seen.has(editionId)) throw new Error(`版本目录继承链出现循环：${editionId}`)
    seen.add(editionId)
    const edition = this.#editions.get(editionId)
    if (!edition?.index) throw new Error(`版本 ${editionId} 没有目录入口`)
    const rows = await this.#client.requireJson(edition.index)
    const byCell = new Map()
    for (const row of rows) {
      byCell.set(cellKey(row.matrix, row.row, row.col), row)
    }
    this.#catalogs.set(editionId, byCell)

    // 继承链上的父版目录必须已发布可取：预载后才能逐环核对校验和。
    for (const row of rows) {
      if (row.inherits) {
        await this.catalog(editionFromUri(row.inherits), seen)
      }
    }
    return byCell
  }

  // 解析一个目录条目最终引用的物理切片（沿 inherits 链逐环展开）。
  // 返回物理 uri、继承链与目录声明校验和；链上任一环缺失或校验和断裂都抛错，
  // 由采集流程按缺件/不可信处理。
  resolveEntry(editionId, entry) {
    const chain = []
    let current = entry
    const guard = new Set()
    while (current?.inherits) {
      const parentUri = current.inherits
      if (guard.has(parentUri)) {
        throw new Error(`版本 ${editionId} 的继承链出现循环：${parentUri}`)
      }
      guard.add(parentUri)
      const parentEdition = editionFromUri(parentUri)
      const parent = this.#catalogs.get(parentEdition)?.get(cellKey(current.matrix, current.row, current.col))
      if (!parent) {
        const reason = `继承对象 ${parentUri} 未在已发布目录中明示可取`
        return { uri: parentUri, digest: current.sha256, chain: [...chain, { uri: parentUri, broken: true, reason }], broken: true, reason }
      }
      // 同像素承接：子版声明的校验和必须与父版目录一致。
      if (parent.sha256 !== current.sha256) {
        const reason = `继承链校验和断裂：${parentUri} 目录摘要 ${parent.sha256} ≠ 声明 ${current.sha256}`
        return { uri: parent.uri ?? parentUri, digest: current.sha256, chain: [...chain, { uri: parentUri, broken: true, reason }], broken: true, reason }
      }
      chain.push({ uri: parentUri, digest: parent.sha256, edition: parentEdition })
      current = parent
    }
    return {
      uri: current.uri,
      digest: entry.sha256,
      chain,
      broken: false,
      inherited: chain.length > 0,
    }
  }
}

export function cellKey(matrix, row, col) {
  return `${matrix}/${row}/${col}`
}

// /tiles/<edition>/<matrix>/<row>/<col>.png -> edition
export function editionFromUri(uri) {
  const parts = uri.split('/')
  return parts[2]
}
