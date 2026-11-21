// 一次可复领的印前采集编排：固定发布时刻 -> 加载 job/版本/目录 -> 规划 -> 审查 -> 落盘。
// 运行目录中的 manifest 记录来源地址、发布序号、比例、矩阵归属与每件对象的校验和，
// 重跑同一发布时刻必须得到同一份清单。

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SourceClient } from './http.mjs'
import { EditionStore } from './store.mjs'
import { planJob } from './planner.mjs'
import { acquire } from './acquire.mjs'
import { reviewPlan, neighborReacquisitionReasons } from './review.mjs'

export async function runAcquisition({ source, step, jobId, scale, outDir, download = true }) {
  const client = new SourceClient(source)
  await mkdir(outDir, { recursive: true })

  const ready = await client.ready()
  if (step !== undefined) await client.setStep(step)
  const effectiveStep = step ?? ready.step

  const store = new EditionStore(client)
  await store.bootstrap({ currentStep: effectiveStep })
  const jobs = await store.loadJobs()
  const job = jobs.find(row => row.job === jobId) ?? jobs[0]
  if (!job) throw new Error(`资料源没有作业 ${jobId ?? '(任一)'}`)

  // 预载本作业涉及的全部版本目录。
  const editionIds = new Set([job.base, ...job.windows.map(window => window.edition)])
  for (const editionId of editionIds) await store.catalog(editionId)

  const plan = planJob(job, store, { scale })

  // 换版牵连信息：patch 中带 changeArea 的版本 + job.change 指向的窗口。
  const changeAreas = [...store.editions.values()]
    .filter(edition => edition.changeArea)
    .map(edition => ({ edition: edition.id, area: edition.changeArea }))
  const changedWindows = job.change ? [job.change] : []
  const review = reviewPlan(plan, store, { changedWindows, changeAreas })
  review.neighborReasons = neighborReacquisitionReasons(plan, review)

  const { manifest, failures } = await acquire(plan, client, outDir, {
    step: effectiveStep,
    sourceBase: source,
    fetchMissing: download,
  })
  manifest.review = review
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const report = {
    outDir,
    job: job.job,
    releaseStep: effectiveStep,
    delivery: manifest.delivery,
    review,
    downloadFailures: failures,
  }
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  return { manifest, review, plan, failures, report, client, store }
}
