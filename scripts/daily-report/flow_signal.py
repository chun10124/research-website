"""外資／投信連買訊號 — 1:1 移植自 src/features/StockAnalysis/utils/analysisUtils.js:129
   的 calculateFlowSignal（唯讀，未修改原檔）。

原始邏輯：對每日買賣超計算滑動 z-score（vs 過去 250 日），
連續 2 天以上 z > 門檻才算「有效大買」→ active。
訊號結束後保留 3 日餘溫（persist）。

⚠️ 這與 calculateForeignForce（外資「持股」10 日 ROC 衝破 700 日標準差、
   存成 foreignSignal/foreignBCount）是兩套不同訊號，勿混用。

陣列皆為 newest-first（index 0 = 最新）。
"""
import math
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from settings import SIGNAL                                    # noqa: E402

Z_THRESHOLD  = SIGNAL['z_threshold']
HIST_WINDOW  = SIGNAL['hist_window']
PERSIST_DAYS = SIGNAL['persist_days']
MIN_DAYS     = SIGNAL['min_days']

def calc_streak(arr, z_threshold=Z_THRESHOLD, hist_window=HIST_WINDOW):
    a = [x for x in (arr or []) if x is not None]
    if len(a) < hist_window + 2:
        return dict(days=0, cum=0.0, active=False, persist=0, persist_days=0)

    max_scan = min(PERSIST_DAYS + 20, len(a) - hist_window - 1)
    w_sum = sum(a[1:hist_window + 1])
    w_sq  = sum(v * v for v in a[1:hist_window + 1])
    z = []
    for i in range(max_scan):
        mean = w_sum / hist_window
        var  = max(0.0, w_sq / hist_window - mean * mean)
        std  = math.sqrt(var)
        z.append((a[i] - mean) / std if std > 0 else 0.0)
        out = a[i + 1]
        inv = a[i + 1 + hist_window] if i + 1 + hist_window < len(a) else 0
        w_sum += inv - out
        w_sq  += inv * inv - out * out

    days = cum = 0
    for i in range(len(z)):
        if z[i] > z_threshold:
            days += 1; cum += a[i]
        else:
            break
    active = days >= MIN_DAYS

    persist = persist_days = 0
    if not active:
        i = days
        while i < len(z):
            if z[i] > z_threshold:
                j, past = i, 0
                while j < len(z) and z[j] > z_threshold:
                    past += 1; j += 1
                if past >= MIN_DAYS:
                    persist = max(0, PERSIST_DAYS - (i - 1)); persist_days = past
                break
            i += 1
    return dict(days=days, cum=cum, active=active, persist=persist, persist_days=persist_days)

def flow_signal(stock):
    """回傳 (外資, 投信) 兩組 streak 結果。"""
    return calc_streak(stock.get('instForeign')), calc_streak(stock.get('instTrust'))
