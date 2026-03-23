import { calcRsDelta } from './rsCalculator';
import { getEffectiveDisplayRs } from './ibdRsRankingTableUtils';

export function clampIbdDeltaDays(raw, fallback) {
  const x = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(x) || x < 1) return fallback;
  return Math.min(365, Math.max(1, x));
}

/**
 * 與 RS 首頁相同：依 filters.deltaShortDays / deltaLongDays 寫入 delta5d、delta20d（欄位名沿用）
 */
export function enrichIbdRsRow(s, filters) {
  const dShort = clampIbdDeltaDays(filters.deltaShortDays, 5);
  const dLong = clampIbdDeltaDays(filters.deltaLongDays, 20);
  const curRs = getEffectiveDisplayRs(s);
  return {
    ...s,
    delta5d: calcRsDelta(curRs, s.ibdRsHistory, dShort),
    delta20d: calcRsDelta(curRs, s.ibdRsHistory, dLong),
  };
}
