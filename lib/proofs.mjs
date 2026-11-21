// 历史校样复取：
// - /proofs 列出历史领用单索引，/proofs/<id> 是当时冻结的 requested 与 contents；
// - 历史校样与最新 jobs 分别发布，重开版不影响旧单逐件复取；
// - 复取时按清单里的 digest 逐件核对，404 不等于业务撤回，要如实记为复取失败。

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256 } from './acquire.mjs'

export async function listProofs(client) {
  return client.requireJson('/proofs')
}

export async function fetchProofManifest(client, manifestPath) {
  return client.requireJson(manifestPath)
}

export async function refetchProof(client, proofIndex, outDir) {
  const manifest = await fetchProofManifest(client, proofIndex.manifest)
  const contents = []
  const failures = []
  await mkdir(join(outDir, 'tiles'), { recursive: true })

  for (const item of manifest.contents) {
    const result = await client.getBytes(item.uri)
    const record = { ...item, localPath: item.uri.replace(/^\//, '') }
    if (result.status !== 200) {
      record.verification = { ok: false, reason: `复取返回 ${result.status}（404 不代表业务撤回，需人工核对资料源）` }
      failures.push(record)
      contents.push(record)
      continue
    }
    const digest = sha256(result.bytes)
    if (digest !== item.digest) {
      record.verification = { ok: false, reason: `校验和不符：实得 ${digest}，原清单 ${item.digest}` }
      failures.push(record)
    } else {
      const target = join(outDir, record.localPath)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, result.bytes)
      record.verification = { ok: true, digest, bytes: result.bytes.length }
    }
    contents.push(record)
  }

  const bundle = {
    schema: 'prepress-proof/1',
    proofId: manifest.id,
    requested: manifest.requested,
    sourceStep: null,
    contents,
    refetch: { ok: failures.length === 0, failures: failures.map(({ uri, reason }) => ({ uri, reason })) },
  }
  await writeFile(join(outDir, `proof-${manifest.id}.json`), JSON.stringify(bundle, null, 2), 'utf8')
  return bundle
}
