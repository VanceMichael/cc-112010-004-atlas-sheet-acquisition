// 实物领取：按规划清单逐件下载原始切片，用目录声明的 sha256 核对；
// 产物按运行目录落盘，清单与切片一一对应，可逐件复取。

import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { collectObjects } from './planner.mjs'

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function localPathFor(uri) {
  // /tiles/b1/W/0/0.png -> tiles/b1/W/0/0.png
  return uri.replace(/^\//, '')
}

export async function acquire(plan, client, outDir, { step, sourceBase, fetchMissing = true } = {}) {
  const objects = collectObjects(plan)
  const records = []
  const failures = []

  await mkdir(join(outDir, 'tiles'), { recursive: true })
  for (const object of objects) {
    const record = { ...object, localPath: localPathFor(object.uri), verification: null }
    if (fetchMissing) {
      const result = await client.getBytes(object.uri)
      if (result.status !== 200) {
        record.verification = { ok: false, reason: `领取返回 ${result.status}` }
        failures.push({ uri: object.uri, reason: record.verification.reason })
        records.push(record)
        continue
      }
      const digest = sha256(result.bytes)
      if (digest !== object.digest) {
        record.verification = { ok: false, reason: `校验和不符：实得 ${digest}，清单 ${object.digest}` }
        failures.push({ uri: object.uri, reason: record.verification.reason })
      } else {
        const target = join(outDir, record.localPath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, result.bytes)
        const etag = result.headers.get('etag')
        record.verification = {
          ok: true,
          digest,
          bytes: result.bytes.length,
          etag: etag?.replaceAll('"', '') ?? null,
        }
      }
    }
    records.push(record)
  }

  const manifest = buildManifest(plan, records, { step, sourceBase, failures })
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { manifest, failures }
}

export function buildManifest(plan, records, { step, sourceBase, failures = [] } = {}) {
  return {
    schema: 'prepress-acquisition/1',
    job: plan.job,
    base: plan.base,
    scale: plan.scale ?? null,
    source: sourceBase ?? null,
    releaseStep: step ?? null,
    generatedAt: new Date().toISOString(),
    delivery: {
      complete: plan.complete && failures.length === 0,
      missingCells: plan.windows.flatMap(window => window.missing),
      failures,
    },
    windows: plan.windows.map(window => ({
      window: window.window,
      theme: window.theme,
      edition: window.edition,
      base: window.base,
      scale: window.scale,
      extent: window.extent,
      bleed: window.bleed,
      region: window.region,
      ownership: window.ownership,
      outside: window.outside,
      counts: window.counts,
      cells: window.layers.flatMap(layer =>
        layer.cells.map(cell => ({
          layer: layer.role,
          edition: cell.edition,
          matrix: cell.matrix,
          row: cell.row,
          col: cell.col,
          status: cell.status,
          cellArea: cell.cellArea,
          ownedArea: cell.ownedArea,
          sides: cell.sides,
          uri: cell.resolution?.uri ?? null,
          inherited: cell.inherited ?? false,
          reason: cell.reason ?? null,
        })),
      ),
    })),
    objects: records.map(record => ({
      uri: record.uri,
      localPath: record.localPath,
      digest: record.digest,
      physicalEdition: record.physicalEdition,
      inherited: record.inherited,
      verification: record.verification,
      references: record.references,
    })),
  }
}

// 离线复核：对已落盘清单重新计算校验和，确认逐件可复取。
export async function verifyLocal(outDir) {
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const problems = []
  for (const object of manifest.objects) {
    let bytes
    try {
      bytes = await readFile(join(outDir, object.localPath))
    } catch {
      problems.push({ uri: object.uri, reason: '本地切片缺失，无法复取' })
      continue
    }
    const digest = sha256(bytes)
    if (digest !== object.digest) {
      problems.push({ uri: object.uri, reason: `校验和不符：本地 ${digest}，清单 ${object.digest}` })
    }
  }
  return { ok: problems.length === 0, problems, manifest }
}
