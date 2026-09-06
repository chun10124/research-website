"""設定載入。所有可調參數集中在同層 config.toml，程式不硬編數值。"""
import tomllib
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent / 'config.toml'

def load(path=None):
    with open(path or CONFIG_PATH, 'rb') as f:
        return tomllib.load(f)

CFG = load()
COMMON = CFG['common']
MA_SHORT, MA_LONG = COMMON['ma']['short'], COMMON['ma']['long']
BARS = COMMON['bars']
HISTORY_DAYS = COMMON['history_days']
COLS = COMMON['cols']
ROWS_PER_PAGE = COMMON['rows_per_page']
MIN_COLS = COMMON['min_cols']
PRICE = CFG['price']
CHIP = CFG['chip']
SIGNAL = CHIP['signal']
