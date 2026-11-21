#!/usr/bin/env node
// 印前采集命令行：
//   acquire   按发布时刻与作业生成逐窗领图清单并下载原始切片
//   verify    对已落盘清单逐件复算校验和
//   proofs    列出历史校样
//   refetch   沿旧校样领用单逐件复取
//   plates    查看待印版、锁版状态与逐窗实收
//   handover  逐窗向印厂交接（503 自动转回执核对）
//   reprint   查看重开单
//
// 示例：
//   node cli.mjs acquire --source http://127.0.0.1:4173 --step 1 --job P-7 --scale 1:25000 --out runs/P7-s1

import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { SourceClient } from './lib/http.mjs'
import { runAcquisition } from './lib/run.mjs'
import { verifyLocal } from './lib/acquire.mjs'
import { listProofs, refetchProof } from './lib/proofs.mjs'
import { PressHandover, manifestForWindow } from './lib/press.mjs'
import { readFile } from 'node:fs/promises'

const options = {
  source: { type: 'string', default: process.env.SOURCE ?? 'http://127.0.0.1:4173' },
  step: { type: 'string' },
  job: { type: 'string' },
  scale: { type: 'string' },
  out: { type: 'string' },
  proof: { type: 'string' },
  plate: { type: 'string' },
  'plate-version': { type: 'string' },
  window: { type: 'string' },
  transmission: { type: 'string' },
  manifest: { type: 'string' },
  'no-download': { type: 'boolean', default: false },
}

async function main() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true })
  const command = positionals[0]
  const outDir = resolve(values.out ?? 'runs/latest')
  const applyStep = async client => {
    if (values.step !== undefined) await client.setStep(Number(values.step))
  }

  switch (command) {
    case 'acquire': {
      const result = await runAcquisition({
        source: values.source,
        step: values.step === undefined ? undefined : Number(values.step),
        jobId: values.job,
        scale: values.scale ?? null,
        outDir,
        download: !values['no-download'],
      })
      printAcquisition(result)
      break
    }
    case 'verify': {
      const verification = await verifyLocal(outDir)
      console.log(verification.ok ? `复校通过：${verification.manifest.objects.length} 件全部与清单校验和一致` : '复校发现问题：')
      for (const problem of verification.problems) console.log(`- ${problem.uri}: ${problem.reason}`)
      if (!verification.ok) process.exitCode = 1
      break
    }
    case 'proofs': {
      const client = new SourceClient(values.source)
      await applyStep(client)
      const proofs = await listProofs(client)
      console.log(JSON.stringify(proofs, null, 2))
      break
    }
    case 'refetch': {
      if (!values.proof) throw new Error('--proof 必填（领用单 manifest 路径或校样 id）')
      const client = new SourceClient(values.source)
      await applyStep(client)
      const proofPath = values.proof.startsWith('/') ? values.proof : `/proofs/${values.proof}`
      const [proof] = (await listProofs(client)).filter(item => item.manifest === proofPath || item.id === values.proof)
      if (!proof) throw new Error(`校样 ${values.proof} 不在 /proofs 索引中`)
      const bundle = await refetchProof(client, proof, outDir)
      console.log(bundle.refetch.ok
        ? `校样 ${bundle.proofId} 逐件复取完成：${bundle.contents.length} 件，校验和全部一致`
        : `校样 ${bundle.proofId} 复取存在失败：`)
      for (const failure of bundle.refetch.failures) console.log(`- ${failure.uri}: ${failure.reason}`)
      if (!bundle.refetch.ok) process.exitCode = 1
      break
    }
    case 'plates': {
      const client = new SourceClient(values.source)
      await applyStep(client)
      const handover = new PressHandover(client, outDir)
      const plates = await handover.listPlates()
      for (const plate of plates) {
        console.log(`印版 ${plate.plate}（版次 ${plate.version}，${plate.state === 'locked' ? '已锁定' : '开放'}，作业 ${plate.job}）`)
        for (const accepted of plate.accepted) {
          const detail = accepted.editions ? `校样 ${accepted.proof}，版本 ${accepted.editions.join('、')}`
            : `transmission ${accepted.transmission}，实收 ${accepted.manifest?.length ?? 0} 件`
          console.log(`  已收窗口 ${accepted.window}：${detail}`)
        }
      }
      break
    }
    case 'handover': {
      for (const key of ['plate', 'plate-version', 'window', 'transmission', 'manifest']) {
        if (!values[key]) throw new Error(`--${key} 必填`)
      }
      const acquisitionManifest = JSON.parse(await readFile(resolve(values.manifest), 'utf8'))
      const manifest = manifestForWindow(acquisitionManifest, values.window)
      if (!manifest.length) throw new Error(`窗口 ${values.window} 在清单中没有可交接的对象`)
      const client = new SourceClient(values.source)
      await applyStep(client)
      const handover = new PressHandover(client, outDir)
      const outcome = await handover.handover({
        plate: values.plate,
        plateVersion: values['plate-version'],
        window: values.window,
        transmission: values.transmission,
        manifest,
      })
      if (outcome.state === 'awaiting-receipt') {
        const receipt = await handover.pollReceipt(values.transmission)
        console.log(receipt
          ? `回执核对成功：印版 ${receipt.plate} 窗口 ${receipt.window} 已实收 ${receipt.manifest.length} 件`
          : '仍未见到印厂接收记录，旧料保留在本版；稍后可用 receipts 子命令继续核对')
        if (!receipt) process.exitCode = 1
      } else if (outcome.state === 'accepted') {
        console.log(`印厂已接收：${outcome.receipt.plate}/${outcome.receipt.window}，transmission=${values.transmission}`)
      } else {
        console.log(`交接被拒：${JSON.stringify(outcome.reason)}`)
        process.exitCode = 1
      }
      break
    }
    case 'receipts': {
      if (!values.transmission) throw new Error('--transmission 必填')
      const client = new SourceClient(values.source)
      await applyStep(client)
      const handover = new PressHandover(client, outDir)
      const receipt = await handover.checkReceipt(values.transmission)
      console.log(receipt ? JSON.stringify(receipt, null, 2) : '未查到交接回执')
      if (!receipt) process.exitCode = 1
      break
    }
    case 'reprint': {
      const client = new SourceClient(values.source)
      await applyStep(client)
      const handover = new PressHandover(client, outDir)
      console.log(JSON.stringify(await handover.listReprints(), null, 2))
      break
    }
    default:
      console.log('可用命令：acquire | verify | proofs | refetch | plates | handover | receipts | reprint')
      process.exitCode = 1
  }
}

function printAcquisition({ manifest, review, failures }) {
  console.log(`作业 ${manifest.job}｜发布序号 ${manifest.releaseStep}｜比例 ${manifest.scale ?? '未指定'}`)
  for (const window of manifest.windows) {
    console.log(`窗口 ${window.window}（${window.theme}/${window.edition}，出血 ${window.bleed}m）：${JSON.stringify(window.counts)}，归属矩阵 ${window.ownership.map(o => o.matrix).join('、')}`)
    for (const cell of window.cells.filter(c => c.status !== 'available')) {
      console.log(`  [${cell.status}] ${cell.edition} ${cell.matrix}/${cell.row}/${cell.col} ${cell.sides.join('/')}侧 — ${cell.reason}`)
    }
  }
  console.log(`物理对象 ${manifest.objects.length} 件；跨窗复用 ${review.reuse.length} 件；混用告警 ${review.mixing.length} 条`)
  for (const state of review.windows) {
    console.log(`窗口 ${state.window} 审查状态：${state.status === 'ready' ? '可交付' : '待审'}`)
    for (const reason of state.reasons) console.log(`  - ${reason}`)
  }
  if (failures.length) {
    console.log('下载失败：')
    for (const failure of failures) console.log(`  - ${failure.uri}: ${failure.reason}`)
  }
  console.log(review.deliverable && manifest.delivery.complete && !failures.length
    ? '结论：合版件可交付'
    : '结论：不可交付，按报告处理缺件/待审项')
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
