// 排版交接系统对接：
// - 逐窗 POST /press，同一 transmission 重放必须内容一致（服务端保证幂等）；
// - 503 只表示“交接回条暂不可读”，请求可能已落库：必须轮询 /press/receipts 核对实收，
//   未见到印厂接收记录前，不得按本地已发出就将旧料移出本版；
// - 409 区分：印版锁定/版次变更、窗口已有接收记录、传输编号内容冲突；
// - 印版锁定后仍按实际接收清单查阅，编辑同意重开新印版（/reprint）才可提交新材料；
// - 可单独重印的版面（新 plate）不受另一张版锁定影响。

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export class PressHandover {
  #client
  #outboxPath

  constructor(client, stateDir) {
    this.#client = client
    this.#outboxPath = join(stateDir, 'outbox.json')
  }

  async #loadOutbox() {
    try {
      return JSON.parse(await readFile(this.#outboxPath, 'utf8'))
    } catch {
      return { transmissions: [] }
    }
  }

  async #saveOutbox(outbox) {
    await mkdir(join(this.#outboxPath, '..'), { recursive: true })
    await writeFile(this.#outboxPath, JSON.stringify(outbox, null, 2), 'utf8')
  }

  async listPlates() {
    return this.#client.requireJson('/press')
  }

  async listReprints() {
    const result = await this.#client.getJson('/reprint')
    return result.status === 200 ? result.body : []
  }

  // 只发交接请求、尚未看见印厂接收记录时，状态停留在 awaiting-receipt；
  // 旧料在 receipt 确认前保留在本版。
  async handover({ plate, plateVersion, window, transmission, manifest }) {
    if (!Array.isArray(manifest) || !manifest.length) {
      throw new Error('交接清单为空，拒绝提交')
    }
    const outbox = await this.#loadOutbox()
    const payload = { plate, plateVersion, transmission, window, manifest }
    const existing = outbox.transmissions.find(item => item.transmission === transmission)
    if (existing && JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
      throw new Error(`本地 transmission ${transmission} 已绑定不同内容，禁止改写`)
    }

    let response
    try {
      response = await this.#client.postJson('/press', payload)
    } catch (error) {
      await this.#record(outbox, { transmission, payload, state: 'send-failed', note: error.message })
      throw error
    }

    if (response.status === 201 || response.status === 200) {
      await this.#record(outbox, { transmission, payload, state: 'accepted', receipt: response.body })
      return { state: 'accepted', receipt: response.body, responseStatus: response.status }
    }
    if (response.status === 503) {
      // 回条暂不可读：请求可能已落库，进入待核对状态，等待 pollReceipt。
      await this.#record(outbox, { transmission, payload, state: 'awaiting-receipt', note: '服务端 503，回执待核对' })
      return { state: 'awaiting-receipt', responseStatus: 503 }
    }
    if (response.status === 409) {
      // 可能是重放后服务端已有记录，先核对实收再下结论。
      const receipt = await this.checkReceipt(transmission)
      await this.#record(outbox, {
        transmission,
        payload,
        state: receipt ? 'accepted' : 'rejected',
        note: receipt ? '409 后凭回执确认已接收' : `409：${response.body?.原因 ?? '印版锁定/窗口已收/传输冲突'}`,
      })
      return { state: receipt ? 'accepted' : 'rejected', receipt: receipt ?? null, reason: response.body, responseStatus: 409 }
    }
    await this.#record(outbox, { transmission, payload, state: 'rejected', note: `HTTP ${response.status}` })
    return { state: 'rejected', reason: response.body, responseStatus: response.status }
  }

  async checkReceipt(transmission) {
    const result = await this.#client.getJson(`/press/receipts?transmission=${encodeURIComponent(transmission)}`)
    return result.status === 200 ? result.body : null
  }

  // 轮询直到看见印厂实收；超时仍未见则保持 awaiting-receipt，旧料不移除。
  async pollReceipt(transmission, { attempts = 10, interval = 100 } = {}) {
    const outbox = await this.#loadOutbox()
    for (let i = 0; i < attempts; i++) {
      const receipt = await this.checkReceipt(transmission)
      if (receipt) {
        await this.#record(outbox, { transmission, state: 'accepted', receipt }, true)
        return receipt
      }
      await new Promise(resolve => setTimeout(resolve, interval))
    }
    return null
  }

  async #record(outbox, entry, merge = false) {
    const index = outbox.transmissions.findIndex(item => item.transmission === entry.transmission)
    if (index >= 0) {
      outbox.transmissions[index] = merge
        ? { ...outbox.transmissions[index], ...entry }
        : { ...outbox.transmissions[index], ...entry, updatedAt: new Date().toISOString() }
    } else {
      outbox.transmissions.push({ ...entry, createdAt: new Date().toISOString() })
    }
    await this.#saveOutbox(outbox)
  }

  get outboxPath() {
    return this.#outboxPath
  }

  // 按印版找回印厂实际接收过的材料：/press 的 accepted 列表 + 回执。
  async acceptedByPlate(plate) {
    const plates = await this.listPlates()
    const row = plates.find(item => item.plate === plate)
    if (!row) return { plate, found: false, state: null, accepted: [] }
    const receipts = []
    for (const item of row.accepted) {
      receipts.push(item)
    }
    return { found: true, plate, state: row.state, version: row.version, accepted: receipts }
  }
}

// 从采集清单生成 /press 要求的非空 manifest（物理 uri 去重，按窗口过滤）。
export function manifestForWindow(acquisitionManifest, windowId) {
  const uris = new Set()
  for (const object of acquisitionManifest.objects) {
    if (object.references.some(ref => ref.window === windowId)) uris.add(object.uri)
  }
  return [...uris].sort().map(uri => ({ uri }))
}
