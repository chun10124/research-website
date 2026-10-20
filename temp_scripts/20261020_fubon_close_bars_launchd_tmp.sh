#!/bin/zsh
# launchd 每日呼叫：抓富邦收盤 K 棒並寫入 Firestore；憑據讀鑰匙圈與 ~/.fubon/cert.p12
# 非交易日（快照日期≠今日）Python 端會直接結束，不寫入。同一天已寫過就跳過，避免醒來重複跑。
cd "${0:A:h}/.."
TODAY=$(TZ=Asia/Taipei date +%Y%m%d)
LOG_DIR=output/fubon_close_bars
mkdir -p "$LOG_DIR"
if [[ -f "$LOG_DIR/.written_$TODAY" ]]; then
  echo "[$(date '+%F %T')] $TODAY 已寫入過，略過" >> "$LOG_DIR/launchd.log"
  exit 0
fi
# 13:35 前快照尚未收盤（醒來時間早於收盤的情況）
HM=$(TZ=Asia/Taipei date +%H%M)
if (( 10#$HM < 1335 )); then
  echo "[$(date '+%F %T')] 尚未收盤（$HM），略過" >> "$LOG_DIR/launchd.log"
  exit 0
fi
{
  echo "=== $(date '+%F %T') ==="
  temp_scripts/.venv_fubon/bin/python temp_scripts/20261020_fubon_close_bars_tmp.py --write && touch "$LOG_DIR/.written_$TODAY"
  echo "exit=$?"
} >> "$LOG_DIR/launchd.log" 2>&1
