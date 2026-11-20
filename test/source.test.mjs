import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { makeSource } from '../source.mjs'

const release = JSON.parse(await readFile(new URL('../samples/sources.json', import.meta.url), 'utf8'))
const entries = [["/jobs", "/editions", "/proofs", "/tiles/b1/catalog", "/tiles/w1/catalog", "/tiles/s1/catalog"], ["/jobs", "/editions", "/proofs", "/tiles/w2/catalog", "/tiles/b2/catalog", "/tiles/s2/catalog"]]

async function openSource(t) {
  const server = makeSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return new URL('http://127.0.0.1:' + server.address().port)
}

function request(origin, path, options) {
  return fetch(new URL(path, origin), { signal: AbortSignal.timeout(3000), ...options })
}

async function view(origin, step) {
  const res = await request(origin, '/replay', { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step }) })
  assert.equal(res.status, 200)
}

test('逐次发布可从资料源取回', async t => {
  const origin = await openSource(t)
  const ready = await request(origin, '/ready')
  assert.deepEqual(await ready.json(), { status: 'ready', step: 0, steps: release.rounds.length })
  for (const [step, routes] of entries.entries()) {
    await view(origin, step)
    for (const entry of release.rounds[step].filter(row => routes.includes(row.path))) {
      const options = { method: entry.method }
      if (entry.request !== null) {
        options.body = JSON.stringify(entry.request)
        options.headers = { 'content-type': 'application/json' }
      }
      const response = await request(origin, entry.path, options)
      assert.equal(response.status, entry.status, entry.path)
      if (typeof entry.body === 'string') {
        assert.equal(await response.text(), entry.body, entry.path)
      } else {
        assert.deepEqual(await response.json(), entry.body, entry.path)
      }
    }
  }
})

test('二进制资料摘要和传输范围一致', { skip: !Object.keys(release.assets).length }, async t => {
  const origin = await openSource(t)
  for (const [path, asset] of Object.entries(release.assets)) {
    await view(origin, asset.since ?? asset.ignoreEarlierResponseFrom ?? 0)
    const response = await request(origin, path)
    assert.equal(response.status, 200, path)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.digest)
    const partial = await request(origin, path, { headers: { range: 'bytes=0-7' } })
    assert.equal(partial.status, 206, path)
    assert.equal(partial.headers.get('content-range'), 'bytes 0-7/' + bytes.length)
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 8))
  }
})

test('印厂可沿旧校样领用单复取实际图幅', async t => {
  const origin = await openSource(t)
  await view(origin, 1)
  const [proof] = await (await request(origin, '/proofs')).json()
  const manifest = await (await request(origin, proof.manifest)).json()
  const [current] = await (await request(origin, '/jobs')).json()
  assert.notDeepEqual(manifest.requested.windows, current.windows)
  assert.equal(new Set(manifest.contents.map(item => item.window)).size, 2)
  for (const item of manifest.contents) {
    const piece = await request(origin, item.uri)
    assert.equal(piece.status, 200)
    assert.equal(createHash('sha256').update(Buffer.from(await piece.arrayBuffer())).digest('hex'), item.digest)
  }
})

test('印厂可在确认页断开后查到实收，锁版保留原印版', async t => {
  const origin = await openSource(t)
  const [before] = await (await request(origin, '/press')).json()
  const payload = { plate: before.plate, plateVersion: before.version, window: 'L', transmission: 'press-14',
    manifest: [{ uri: '/tiles/w1/W/0/0.png' }] }
  const send = () => request(origin, '/press', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  assert.equal((await send()).status, 503)
  await view(origin, 1)
  const saved = await (await request(origin, '/press/receipts?transmission=press-14')).json()
  assert.equal(saved.window, 'L')
  assert.deepEqual(saved.manifest, payload.manifest)
  assert.equal((await send()).status, 200)
  assert.equal((await (await request(origin, '/press')).json())[0].state, 'locked')
  await view(origin, 2)
  const [approval] = await (await request(origin, '/reprint')).json()
  assert.equal(approval.priorPlate, before.plate)
  assert.notEqual(approval.plate, before.plate)
})
