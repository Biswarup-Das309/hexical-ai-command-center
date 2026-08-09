export interface TTYTerminalGeometry {
  readonly cols: number
  readonly rows: number
}

const DEFAULT_CELL_WIDTH = 8.25
const DEFAULT_CELL_HEIGHT = 18

export function calculateTTYTerminalGeometry(
  width: number,
  height: number,
  cellWidth = DEFAULT_CELL_WIDTH,
  cellHeight = DEFAULT_CELL_HEIGHT
): TTYTerminalGeometry {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0
  const safeCellWidth = Number.isFinite(cellWidth) && cellWidth > 0 ? cellWidth : DEFAULT_CELL_WIDTH
  const safeCellHeight = Number.isFinite(cellHeight) && cellHeight > 0 ? cellHeight : DEFAULT_CELL_HEIGHT
  return Object.freeze({
    cols: Math.max(1, Math.floor(safeWidth / safeCellWidth)),
    rows: Math.max(1, Math.floor(safeHeight / safeCellHeight))
  })
}

