// 地图站资料访问层：封装发布时刻切换、JSON/二进制领取与重试语义。
// 只有 GET（幂等）允许自动重试；POST 的重放由调用方按 transmission 控制。

export class HttpError extends Error {
  constructor(status, path, body) {
    super(`资料源 ${path} 返回 ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.path = path
    this.body = body
  }
}

export class SourceClient {
  #base
  #timeout
  #retries

  constructor(base, { timeout = 5000, retries = 3 } = {}) {
    this.#base = new URL(base)
    this.#timeout = timeout
    this.#retries = retries
  }

  async #request(path, options = {}, attempt = 0) {
    const url = new URL(path, this.#base)
    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(this.#timeout), ...options })
    } catch (error) {
      // 网络抖动：仅对幂等 GET 重试。
      if (options.method === undefined && attempt < this.#retries) {
        await delay(200 * (attempt + 1))
        return this.#request(path, options, attempt + 1)
      }
      throw error
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (response.status === 503 && options.method === undefined && attempt < this.#retries) {
      await delay(200 * (attempt + 1))
      return this.#request(path, options, attempt + 1)
    }
    if (contentType.includes('application/json')) {
      const body = await response.json()
      return { status: response.status, headers: response.headers, body }
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    return { status: response.status, headers: response.headers, bytes }
  }

  // 切换资料源发布时刻（PUT /replay），返回切换后的序号。
  async setStep(step) {
    const result = await this.#request('/replay', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step }),
    })
    if (result.status !== 200) throw new HttpError(result.status, '/replay', result.body)
    return result.body.step
  }

  async ready() {
    const result = await this.#request('/ready')
    if (result.status !== 200) throw new HttpError(result.status, '/ready', result.body)
    return result.body
  }

  // 404 是资料源的正常应答：历史资料可能仍可沿旧地址取得，调用方自行决定语义。
  async getJson(path) {
    const result = await this.#request(path)
    return { status: result.status, body: result.body }
  }

  async requireJson(path) {
    const result = await this.#request(path)
    if (result.status !== 200) throw new HttpError(result.status, path, result.body)
    return result.body
  }

  async getBytes(path) {
    const result = await this.#request(path)
    return { status: result.status, bytes: result.bytes, headers: result.headers }
  }

  async postJson(path, payload) {
    return this.#request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
