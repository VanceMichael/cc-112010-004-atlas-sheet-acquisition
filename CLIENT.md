# 印前可复领采集客户端

在资料源（`serve.mjs`）之上实现的印前采集与印厂交接客户端，全部使用 Node 内置能力，无第三方依赖。

## 业务规则落地

| 规则 | 实现位置 | 说明 |
| --- | --- | --- |
| 出血外扩、矩阵归属、行列边界 | `lib/geo.mjs`、`lib/planner.mjs` | 半开区间 `[xmin,ymin,xmax,ymax]`；窗口横跨两套矩阵时按 `priority` 切分归属区，交叠区归高优先级矩阵 |
| 老切片仅在明示 `inherits` 时可沿用 | `lib/store.mjs` | 沿继承链逐环展开，校验和与父版目录逐环核对；未声明继承一律不引用 |
| 留白与缺件分账 | `lib/planner.mjs` | `blank`（发布方明示）、`outside`（供应商边缘/专题不覆盖）允许留白；`missing`（覆盖范围内目录缺件）按缺件记，三者不合并 |
| 校验和确认实物与空间归属 | `lib/acquire.mjs` | 逐件下载并核对 sha256（含 ETag），清单记录矩阵、行列、归属区与引用窗口 |
| 可复领 | `lib/run.mjs`、`cli.mjs verify` | 固定发布序号重跑得到同一份清单；离线可对落盘切片逐件复算 |
| 局部修订牵连邻窗 | `lib/review.mjs` | `changeArea` 与任何窗口采集区相交即标 `pendingReview`，含编辑未点选的窗；旧校样仍按原清单可查 |
| 交付条件 | `lib/review.mjs` | 无缺件、底图在专题版 `compatibleBase` 内、无同层混用、无待审，才判 `deliverable` |
| 复用与混用区分 | `lib/review.mjs` | 同一物理切片被多窗引用记为复用；同一窗口同一层出现两个版次记为混用告警 |
| 503 不等于失败 | `lib/press.mjs` | 交接返回 503 进入 `awaiting-receipt`，轮询 `/press/receipts` 核对实收；未见接收记录不移除旧料 |
| 锁版与重开 | `lib/press.mjs` | 锁定印版拒绝新材料；`/reprint` 的新印版开放，不受另一张版锁定影响 |
| 按印版找回实收 | `lib/press.mjs`、`cli.mjs plates` | 合并 `/press` 的 accepted 与回执，逐窗列出实际接收清单 |

## 命令

```bash
npm start                                   # 先启动资料源（默认 127.0.0.1:4173）

# 采集：固定发布时刻、作业、比例，产出逐窗清单与原始切片
node cli.mjs acquire --step 0 --job P-7 --scale 1:25000 --out runs/P7-step0

# 离线复校（逐件重算 sha256）
node cli.mjs verify --out runs/P7-step0

# 历史校样：索引与沿旧清单逐件复取
node cli.mjs proofs --step 1
node cli.mjs refetch --proof proof-P7-1 --step 1 --out runs/proof

# 印厂交接：503 自动转回执轮询；发件箱落 <out>/outbox.json
node cli.mjs handover --step 2 --plate T71 --plate-version c1 \
  --window L --transmission press-001 \
  --manifest runs/P7-step1/manifest.json --out runs/press

# 回执核对、印版实收视图、重开单
node cli.mjs receipts --transmission press-001 --step 2 --out runs/press
node cli.mjs plates --step 1 --out runs/press
node cli.mjs reprint --step 2 --out runs/press
```

## 产物

```
runs/<run>/
├── manifest.json     # 逐窗领图清单：矩阵归属、格位状态、物理对象、校验和、审查结论
├── report.json       # 机读交付报告（缺件、待审原因、邻窗复领理由）
├── tiles/...         # 原始切片，路径与来源 URI 同构
└── outbox.json       # 仅交接流程：每个 transmission 的状态机与回执
```

格位状态四分类：`available`（可领，含继承件）、`blank`（明示留白）、`outside`（边缘/不覆盖留白）、`missing`（缺件）。

## 测试

```bash
npm test
```

`test/client.test.mjs` 覆盖：几何半开区间、与历史校样清单逐件一致、可复跑与离线复校、留白/缺件分账、继承链核对与断裂处理、`changeArea` 牵连、底图兼容性、503 回执轮询、锁版拒绝、重开新印版交接。
