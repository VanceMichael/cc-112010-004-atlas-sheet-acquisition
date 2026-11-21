import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeSource } from '../source.mjs'
import { SourceClient } from '../lib/http.mjs'
import { EditionStore, cellKey } from '../lib/store.mjs'
import { planWindow } from '../lib/planner.mjs'
import { runAcquisition } from '../lib/run.mjs'
import { verifyLocal } from '../lib/acquire.mjs'
import { listProofs, refetchProof } from '../lib/proofs.mjs'
import { PressHandover, manifestForWindow } from '../lib/press.mjs'
import { reviewPlan } from '../lib/review.mjs'
import { intersect, subtractRect } from '../lib/geo.mjs'

async function openSource(t) {
  const server = makeSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return 'http://127.0.0.1:' + server.address().port
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prepress-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function loadAt(source, step) {
  const client = new SourceClient(source)
  await client.setStep(step)
  const store = new EditionStore(client)
  await store.bootstrap({ currentStep: step })
  const jobs = await store.loadJobs()
  const job = jobs[0]
  for (const id of new Set([job.base, ...job.windows.map(w => w.edition)])) {
    await store.catalog(id)
  }
  return { client, store, job }
}

// ---------- 几何基础 ----------

test('半开区间相切不相交；内切扣减只保留零个碎片', () => {
  assert.deepEqual(intersect([0, 0, 10, 10], [10, 0, 20, 10]), null)
  const parts = subtractRect([0, 0, 100, 100], [40, 40, 60, 60])
  assert.deepEqual(parts, [[0, 0, 40, 100], [60, 0, 100, 100], [40, 0, 60, 40], [40, 60, 60, 100]])
})

// ---------- 第 0 次发布：完整可交付，且与历史校样清单一致 ----------

test('step0 规划逐窗归属矩阵，与历史校样记账完全一致', async t => {
  const source = await openSource(t)
  const { store, job } = await loadAt(source, 0)

  const left = planWindow(job, job.windows[0], store, { scale: '1:25000' })
  const right = planWindow(job, job.windows[1], store)

  // 左窗只落在 W 服务区（优先级 2），右窗横跨 W/E，交叠区归 W。
  assert.deepEqual(left.ownership.map(o => o.matrix), ['W'])
  assert.deepEqual(right.ownership.map(o => o.matrix), ['W', 'E'])

  const count = (window, status) => window.layers.flatMap(l => l.cells).filter(c => c.status === status).length
  // L：b1 与 w1 各 6 格 W；R：b1 与 s1 各 4 格 W + 4 格 E。
  assert.equal(count(left, 'available'), 12)
  assert.equal(count(right, 'available'), 16)
  assert.equal(left.missing.length, 0)
  assert.equal(right.missing.length, 0)

  // 与资料源里留存的历史校样 contents 逐件比对。
  const client = new SourceClient(source)
  await client.setStep(1)
  const proof = await client.requireJson('/proofs/proof-P7-1')
  const expected = proof.contents.map(item => `${item.window}|${item.edition}|${item.uri}`).sort()
  const actual = [left, right].flatMap(window =>
    window.layers.flatMap(layer => layer.cells
      .filter(c => c.status === 'available')
      .map(c => `${window.window}|${c.edition}|${c.resolution.uri}`)),
  ).sort()
  assert.deepEqual(actual, expected)
})

test('step0 采集落盘、校验和核对、可复跑且可离线复校', async t => {
  const source = await openSource(t)
  const dirA = join(await tempDir(t), 'a')
  const first = await runAcquisition({ source, step: 0, jobId: 'P-7', scale: '1:25000', outDir: dirA })
  assert.equal(first.manifest.delivery.complete, true)
  assert.equal(first.review.deliverable, true)
  assert.equal(first.failures.length, 0)

  // 24 个物理对象全部落盘且 sha256 与目录声明一致。
  assert.equal(first.manifest.objects.length, 24)
  for (const object of first.manifest.objects) {
    assert.equal(object.verification.ok, true, object.uri)
    const bytes = await readFile(join(dirA, object.localPath))
    assert.equal(object.digest, object.verification.digest)
    assert.equal(bytes.length, object.verification.bytes)
  }

  // 跨窗复用的是底图 b1 的 4 个共享切片，且没有任何版次混用。
  assert.deepEqual(first.review.reuse.map(r => r.uri).sort(), [
    '/tiles/b1/W/0/1.png', '/tiles/b1/W/0/2.png', '/tiles/b1/W/1/1.png', '/tiles/b1/W/1/2.png',
  ])
  assert.equal(first.review.mixing.length, 0)

  // 复跑同一发布时刻得到同一份清单（去掉时间戳后逐字节一致）。
  const dirB = join(await tempDir(t), 'b')
  const second = await runAcquisition({ source, step: 0, jobId: 'P-7', scale: '1:25000', outDir: dirB })
  const stable = manifest => {
    const copy = JSON.parse(JSON.stringify(manifest))
    delete copy.generatedAt
    return copy
  }
  assert.deepEqual(stable(second.manifest), stable(first.manifest))

  // 离线逐件复校。
  const verification = await verifyLocal(dirA)
  assert.equal(verification.ok, true)
})

// ---------- 留白与缺件必须分账：合成目录做单元验证 ----------

test('blank 留白、outside 越界与 missing 缺件分三类记账，不混成透明层', () => {
  const matrix = {
    id: 'M', crs: 'LOCAL:M', origin: [0, 100], step: [50, 50], size: [2, 2],
    area: [0, 0, 100, 100], priority: 1,
  }
  const store = {
    matrices: new Map([['M', matrix]]),
    editions: new Map([
      ['t1', { id: 't1', area: [0, 0, 100, 100], blank: [[0, 50, 50, 100]] }],
      ['t2', { id: 't2', area: [50, 0, 100, 100] }],
    ]),
    catalogMaps: new Map([
      ['t1', new Map([
        [cellKey('M', 0, 1), { edition: 't1', matrix: 'M', row: 0, col: 1, uri: '/tiles/t1/M/0/1.png', sha256: 'x' }],
        [cellKey('M', 1, 1), { edition: 't1', matrix: 'M', row: 1, col: 1, uri: '/tiles/t1/M/1/1.png', sha256: 'y' }],
      ])],
      ['t2', new Map()],
    ]),
    resolveEntry: (editionId, entry) => ({ uri: entry.uri, digest: entry.sha256, chain: [], broken: false }),
  }
  const job = { job: 'J', base: 't1', windows: [] }
  const windowSpec = { id: 'W', extent: [5, 5, 95, 95], bleed: 0, theme: 'x', edition: 't2' }
  const planned = planWindow(job, { ...windowSpec, edition: 't1' }, store)
  const byCell = (row, col) => planned.layers.find(l => l.edition === 't1').cells
    .find(c => c.row === row && c.col === col)
  assert.equal(byCell(0, 0).status, 'blank')   // 明示 blank
  assert.equal(byCell(0, 1).status, 'available')
  assert.equal(byCell(1, 0).status, 'missing') // 覆盖范围内无目录对象
  assert.equal(byCell(1, 1).status, 'available')

  const planned2 = planWindow(job, windowSpec, store)
  const t2Layer = planned2.layers.find(l => l.edition === 't2')
  const t2cells = t2Layer.cells
  // t2 只覆盖东半幅：西列 2 格整体 outside，东列无目录对象 = missing。
  assert.ok(t2cells.every(c => c.col === 0 ? c.status === 'outside' : c.status === 'missing'))
  const t2counts = t2cells.reduce((acc, cell) => (acc[cell.status] += 1, acc), { available: 0, blank: 0, missing: 0, outside: 0 })
  assert.equal(t2counts.outside, 2)
  assert.equal(t2counts.missing, 2)
})

// ---------- 第 1 次发布：继承、缺件、底图不兼容、changeArea 牵连 ----------

test('step1 只有明示 inherits 的老切片可沿用，未声明的按缺件', async t => {
  const source = await openSource(t)
  const { store, job } = await loadAt(source, 1)
  const left = planWindow(job, job.windows[0], store)

  const w2 = left.layers.find(l => l.edition === 'w2').cells
  const inherited = w2.filter(c => c.status === 'available' && c.inherited)
  // w2 目录里 4 条 inherits 指向 w1，且校验和与 w1 目录逐环一致。
  assert.equal(inherited.length, 4)
  for (const cell of inherited) {
    assert.match(cell.resolution.uri, /^\/tiles\/w1\//)
    assert.equal(cell.resolution.broken, false)
  }
  // W/1/2 在 w2 覆盖范围内却既无 uri 也无 inherits：缺件，且贴窗口东侧边界。
  const hole = w2.find(c => c.matrix === 'W' && c.row === 1 && c.col === 2)
  assert.equal(hole.status, 'missing')
  assert.ok(hole.sides.includes('east'))

  // 本版底图仍是 b1（job.base 未换），b1 全量可取；真正缺 W/1/2 的是 b2 目录，
  // 由“w2 仅兼容 b2”的不兼容审查连带暴露。
  const b1 = left.layers.find(l => l.edition === 'b1').cells
  assert.equal(b1.find(c => c.row === 1 && c.col === 2).status, 'available')

  // 直接按 b2 规划同一窗口：W/1/2 在 b2 覆盖范围内却无 uri 且未声明 inherits，
  // 必须记缺件——防止窗口边缘半块图继续引用未被明示沿用的 b1 旧切片。
  const jobOnB2 = { ...job, base: 'b2', windows: job.windows.map(w => ({ ...w, edition: 'w2' })) }
  const onB2 = planWindow(jobOnB2, jobOnB2.windows[0], store)
  const b2hole = onB2.layers.find(l => l.role === 'base').cells.find(c => c.row === 1 && c.col === 2)
  assert.equal(b2hole.status, 'missing')
  assert.ok(b2hole.sides.includes('east'))
})

test('step1 审查：底图不兼容、换版牵连邻窗待审、旧校样仍可查', async t => {
  const source = await openSource(t)
  const dir = join(await tempDir(t), 's1')
  const result = await runAcquisition({ source, step: 1, jobId: 'P-7', scale: '1:25000', outDir: dir })

  assert.equal(result.review.deliverable, false)
  const states = Object.fromEntries(result.review.windows.map(w => [w.window, w.status]))
  assert.equal(states.L, 'pendingReview')
  assert.equal(states.R, 'pendingReview') // 编辑只改 L，但 changeArea 扩到 R

  // 邻窗复领原因可解释。
  const neighbor = result.review.neighborReasons.find(r => r.window === 'R')
  assert.ok(neighbor && /换版/.test(neighbor.reason))

  // 底图不兼容：w2 仅兼容 b2，job.base 仍是 b1，这是本场景的合版阻断项。
  assert.ok(result.review.findings.some(f => f.kind === 'incompatibleBase' && f.window === 'L'))
  // 缺件已逐格记账（w2 的 W/1/2，贴东南侧边界），下载阶段不会去碰目录之外的 URL。
  assert.equal(result.manifest.delivery.missingCells.length, 1)
  assert.deepEqual(result.manifest.delivery.missingCells[0].sides, ['south', 'east'])
  assert.ok(result.manifest.objects.every(o => !o.uri.includes('/w2/W/1/2')))

  // 旧校样仍按原清单逐件可查可取。
  const client = new SourceClient(source)
  const proofDir = join(await tempDir(t), 'proof')
  const [proof] = await listProofs(client)
  const bundle = await refetchProof(client, proof, proofDir)
  assert.equal(bundle.refetch.ok, true)
  assert.equal(bundle.contents.length, 28)
  assert.equal(new Set(bundle.contents.map(c => c.window)).size, 2)
})

test('继承链校验和断裂时按缺件处理，不允许冒充可领', () => {
  const store = new EditionStore({ requireJson: async () => [] })
  store.catalogMaps.set('new', new Map([
    [cellKey('M', 0, 0), { edition: 'new', matrix: 'M', row: 0, col: 0, inherits: '/tiles/old/M/0/0.png', sha256: 'child-sum' }],
  ]))
  store.catalogMaps.set('old', new Map([
    [cellKey('M', 0, 0), { edition: 'old', matrix: 'M', row: 0, col: 0, uri: '/tiles/old/M/0/0.png', sha256: 'parent-sum' }],
  ]))
  const resolution = store.resolveEntry('new', store.catalogMaps.get('new').get(cellKey('M', 0, 0)))
  assert.equal(resolution.broken, true)
})

// ---------- 印厂交接：503 回执、锁版、重开版 ----------

test('503 后凭 receipts 核对实收，未见回执不移除旧料；锁版后拒绝新料', async t => {
  const source = await openSource(t)
  const dir = join(await tempDir(t), 'press')
  const client = new SourceClient(source)
  await client.setStep(0)
  const handover = new PressHandover(client, dir)

  const [plate0] = await handover.listPlates()
  assert.equal(plate0.state, 'open')
  const manifest = [{ uri: '/tiles/w1/W/0/0.png' }]
  const outcome = await handover.handover({
    plate: plate0.plate, plateVersion: plate0.version, window: 'L',
    transmission: 'press-14', manifest,
  })
  // step0 服务端返回 503，但请求已落库。
  assert.equal(outcome.state, 'awaiting-receipt')
  const receipt = await handover.pollReceipt('press-14', { attempts: 5, interval: 10 })
  assert.ok(receipt)
  assert.equal(receipt.window, 'L')
  assert.deepEqual(receipt.manifest, manifest)

  // 同一 transmission 重放内容一致：服务端幂等返回 200。
  const replay = await handover.handover({
    plate: plate0.plate, plateVersion: plate0.version, window: 'L',
    transmission: 'press-14', manifest,
  })
  assert.equal(replay.state, 'accepted')

  // 切换到 step1：印版锁定，新交接被拒，回执仍按实际接收清单查阅。
  await client.setStep(1)
  const [locked] = await handover.listPlates()
  assert.equal(locked.state, 'locked')
  const rejected = await handover.handover({
    plate: locked.plate, plateVersion: locked.version, window: 'L',
    transmission: 'press-15', manifest,
  })
  assert.equal(rejected.state, 'rejected')
  const accepted = await handover.acceptedByPlate(locked.plate)
  assert.equal(accepted.state, 'locked')
  assert.ok(accepted.accepted.some(a => a.window === 'R'))

  // 重开单给出新印版，新印版开放且不受旧版锁定影响。
  await client.setStep(2)
  const reprints = await handover.listReprints()
  assert.equal(reprints[0].priorPlate, 'T70')
  assert.notEqual(reprints[0].plate, 'T70')
  const plates = await handover.listPlates()
  const fresh = plates.find(p => p.plate === reprints[0].plate)
  assert.equal(fresh.state, 'open')
  const ontoNew = await handover.handover({
    plate: fresh.plate, plateVersion: fresh.version, window: 'L',
    transmission: 'press-16', manifest,
  })
  assert.equal(ontoNew.state, 'accepted')
})

test('交接清单从采集清单按窗生成，空清单拒绝提交', async t => {
  const source = await openSource(t)
  const dir = join(await tempDir(t), 'hm')
  const { manifest } = await runAcquisition({ source, step: 0, outDir: dir })
  const forL = manifestForWindow(manifest, 'L')
  assert.ok(forL.length > 0)
  assert.ok(forL.every(item => manifest.objects.some(o => o.uri === item.uri &&
    o.references.some(r => r.window === 'L'))))
  assert.deepEqual(manifestForWindow(manifest, 'NOPE'), [])

  const client = new SourceClient(source)
  const handover = new PressHandover(client, dir)
  await assert.rejects(() => handover.handover({
    plate: 'T70', plateVersion: 'c1', window: 'L', transmission: 'x', manifest: [],
  }), /交接清单为空/)
})

// ---------- 合版审查：拼版底图不一致与同层混用版次 ----------

test('相邻窗口底图版次不一致时两窗送回编辑复核；同层混用版次单独告警', () => {
  const cell = (window, layer, edition, uri, matrix = 'W', row = 0, col = 0) => ({
    status: 'available', edition, matrix, row, col,
    cellArea: [0, 0, 1, 1], ownedArea: 1, sides: [],
    resolution: { uri, digest: `d-${uri}`, broken: false, inherited: uri.includes('old') },
  })
  const makeWindow = (id, baseUri, themeUri) => ({
    window: id, region: [0, 0, 10, 10], counts: { available: 2, blank: 0, missing: 0, outside: 0 },
    missing: [], outsideParts: [],
    layers: [
      { role: 'base', edition: 'b2', cells: [cell(id, 'base', 'b2', baseUri)] },
      { role: 'theme', edition: 't1', cells: [cell(id, 'theme', 't1', themeUri)] },
    ],
  })
  const plan = {
    job: 'J', base: 'b2', complete: true,
    windows: [
      makeWindow('L', '/tiles/b2/W/0/0.png', '/tiles/t1/W/0/0.png'),
      makeWindow('R', '/tiles/b1/W/0/0.png', '/tiles/t1/W/0/1.png'),
    ],
  }
  const store = { editions: new Map([['t1', { id: 't1', compatibleBase: ['b1', 'b2'] }]]) }
  const review = reviewPlan(plan, store)
  assert.ok(review.findings.some(f => f.kind === 'baseMismatchAcrossWindows'))
  assert.equal(review.deliverable, false)
  assert.deepEqual(review.windows.map(w => w.status), ['pendingReview', 'pendingReview'])

  // 同层出现两个版次的物理件即混用（与跨窗复用区分开）。
  const mixedPlan = {
    job: 'J2', base: 'b1', complete: true,
    windows: [{
      window: 'L', region: [0, 0, 10, 10], counts: { available: 2, blank: 0, missing: 0, outside: 0 },
      missing: [], outsideParts: [],
      layers: [{
        role: 'theme',
        cells: [
          cell('L', 'theme', 't1', '/tiles/t1/W/0/0.png', 'W', 0, 0),
          cell('L', 'theme', 't2', '/tiles/t2/W/0/1.png', 'W', 0, 1),
        ],
      }],
    }],
  }
  const mixedReview = reviewPlan(mixedPlan, { editions: new Map() })
  assert.equal(mixedReview.mixing.length, 1)
  assert.deepEqual(mixedReview.mixing[0].editions, ['t1', 't2'])
})
