// 印厂合成坐标采用本地平面米制，范围统一为 [xmin, ymin, xmax, ymax]，
// 左、下含边界，右、上不含边界（半开区间）。

export function rectArea(rect) {
  const width = rect[2] - rect[0]
  const height = rect[3] - rect[1]
  return width > 0 && height > 0 ? width * height : 0
}

export function isEmpty(rect) {
  return rectArea(rect) === 0
}

export function intersects(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

export function intersect(a, b) {
  const rect = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ]
  return isEmpty(rect) ? null : rect
}

// a \ b，返回至多四块不重叠的剩余矩形（半开区间下边界相切不会产生零面积碎片）。
export function subtractRect(a, b) {
  if (!intersects(a, b)) return [a]
  const pieces = []
  // 先切左、右条带，保证中间列的 x 方向宽度恒为正。
  const left = b[0] > a[0] ? [a[0], a[1], b[0], a[3]] : null
  const right = b[2] < a[2] ? [b[2], a[1], a[2], a[3]] : null
  if (left) pieces.push(left)
  if (right) pieces.push(right)
  const x0 = Math.max(a[0], b[0])
  const x1 = Math.min(a[2], b[2])
  // 中间列再切下、上条带。
  if (b[1] > a[1]) pieces.push([x0, a[1], x1, b[1]])
  if (b[3] < a[3]) pieces.push([x0, b[3], x1, a[3]])
  return pieces.filter(rect => !isEmpty(rect))
}

// 从 a 中依次扣除若干矩形。
export function subtractRects(a, rects) {
  let remain = [a]
  for (const rect of rects.filter(r => r && !isEmpty(r))) {
    remain = remain.flatMap(piece => subtractRect(piece, rect))
  }
  return remain.filter(rect => !isEmpty(rect))
}

// 出血向四个方向外扩。
export function expand(extent, bleed) {
  return [extent[0] - bleed, extent[1] - bleed, extent[2] + bleed, extent[3] + bleed]
}

// 矩阵切片几何：origin 为左上原点，列向东加一，行向南加一。
export function cellArea(matrix, row, col) {
  const [ox, oy] = matrix.origin
  const [dx, dy] = matrix.step
  return [ox + col * dx, oy - (row + 1) * dy, ox + (col + 1) * dx, oy - row * dy]
}

export function matrixCells(matrix) {
  const [cols, rows] = matrix.size
  const cells = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({ matrix: matrix.id, row, col, area: cellArea(matrix, row, col) })
    }
  }
  return cells
}

// 判断矩形贴在窗口区域的哪一侧（可同时贴多侧），用于报告“哪一侧边界缺什么”。
export function touchingSides(rect, region) {
  const sides = []
  if (rect[0] <= region[0]) sides.push('west')
  if (rect[1] <= region[1]) sides.push('south')
  if (rect[2] >= region[2]) sides.push('east')
  if (rect[3] >= region[3]) sides.push('north')
  return sides
}
