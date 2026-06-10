import { calcRsDelta, calcPriceChangePct } from './rsCalculator';
import { getEffectiveDisplayRs } from './ibdRsRankingTableUtils';

export function clampIbdDeltaDays(raw, fallback) {
  const x = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(x) || x < 1) return fallback;
  return Math.min(365, Math.max(1, x));
}

/**
 * 依 filters.deltaShortDays / deltaLongDays 寫入 delta5d、delta20d（RS 變化），
 * 依 filters.pctShortDays / pctLongDays 寫入 pricePctShort、pricePctLong（股價漲跌幅）。
 */
export function enrichIbdRsRow(s, filters) {
  const dShort = clampIbdDeltaDays(filters.deltaShortDays, 5);
  const dLong  = clampIbdDeltaDays(filters.deltaLongDays,  20);
  const pShort = clampIbdDeltaDays(filters.pctShortDays,   5);
  const pLong  = clampIbdDeltaDays(filters.pctLongDays,    20);
  const curRs  = getEffectiveDisplayRs(s);
  const pm     = s.priceMap && typeof s.priceMap === 'object' ? s.priceMap : null;
  const anchor = s.ibdRsLastCloseDate ?? null;
  return {
    ...s,
    delta5d:       calcRsDelta(curRs, s.ibdRsHistory, dShort),
    delta20d:      calcRsDelta(curRs, s.ibdRsHistory, dLong),
    pricePctShort: pm && anchor ? calcPriceChangePct(pm, anchor, pShort) : (s.pricePct5d  ?? null),
    pricePctLong:  pm && anchor ? calcPriceChangePct(pm, anchor, pLong)  : (s.pricePct20d ?? null),
  };
}
