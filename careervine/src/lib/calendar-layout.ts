/**
 * Classic calendar column-packing for overlapping timed events.
 * Groups overlapping intervals into clusters, greedily assigns columns,
 * then sets each event's columnCount to the max columns used in its cluster.
 */

export type TimedInterval = {
  id: string | number;
  startMs: number;
  endMs: number;
};

export type LayoutSlot = {
  columnIndex: number;
  columnCount: number;
};

/**
 * Assign horizontal slots for a list of timed events in one day column.
 * Returns a map from event id → { columnIndex, columnCount }.
 */
export function packOverlappingEvents<T extends TimedInterval>(
  events: T[]
): Map<T["id"], LayoutSlot> {
  const result = new Map<T["id"], LayoutSlot>();
  if (events.length === 0) return result;

  const sorted = [...events].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return a.endMs - b.endMs;
  });

  // Cluster: maximal set of events connected by overlapping transitive closure
  const clusters: T[][] = [];
  let current: T[] = [];
  let clusterEnd = -Infinity;

  for (const ev of sorted) {
    if (current.length === 0 || ev.startMs < clusterEnd) {
      current.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMs);
    } else {
      clusters.push(current);
      current = [ev];
      clusterEnd = ev.endMs;
    }
  }
  if (current.length > 0) clusters.push(current);

  for (const cluster of clusters) {
    // columnEnds[i] = endMs of the last event placed in column i
    const columnEnds: number[] = [];
    const assignments = new Map<T["id"], number>();

    for (const ev of cluster) {
      let col = columnEnds.findIndex((end) => end <= ev.startMs);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(ev.endMs);
      } else {
        columnEnds[col] = ev.endMs;
      }
      assignments.set(ev.id, col);
    }

    const columnCount = Math.max(1, columnEnds.length);
    for (const ev of cluster) {
      result.set(ev.id, {
        columnIndex: assignments.get(ev.id) ?? 0,
        columnCount,
      });
    }
  }

  return result;
}

/** CSS left/width percentages for a packed slot (with small gutter). */
export function slotStyle(
  slot: LayoutSlot,
  opts: { gutterPct?: number; padPx?: number } = {}
): { left: string; width: string } {
  const gutterPct = opts.gutterPct ?? 1;
  const { columnIndex, columnCount } = slot;
  const widthPct = (100 - gutterPct) / columnCount;
  const leftPct = columnIndex * widthPct;
  return {
    left: `${leftPct}%`,
    width: `${widthPct}%`,
  };
}
