"""
RS強勢股週報生成器 - 2026-04-12
輸出: output/20260412_rs_report.pdf
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
import os

# ── 字型設定：嘗試系統中文字型 ──
FONT_NAME = 'NotoSansTC'
FONT_PATHS = [
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/Library/Fonts/Arial Unicode MS.ttf',
]
font_loaded = False
for fp in FONT_PATHS:
    if os.path.exists(fp):
        try:
            pdfmetrics.registerFont(TTFont(FONT_NAME, fp))
            font_loaded = True
            break
        except Exception:
            continue

if not font_loaded:
    # 改用 Helvetica（只顯示英文）
    FONT_NAME = 'Helvetica'

OUTPUT_PATH = '/Users/tzuchun/程式碼/研究網站/research-website/temp_scripts/output/20260412_rs_report.pdf'

# ── 顏色定義 ──
COLOR_DARK   = colors.HexColor('#1a1a2e')
COLOR_NAVY   = colors.HexColor('#16213e')
COLOR_ACCENT = colors.HexColor('#0f3460')
COLOR_GOLD   = colors.HexColor('#e94560')
COLOR_GREEN  = colors.HexColor('#00b894')
COLOR_ORANGE = colors.HexColor('#fdcb6e')
COLOR_LIGHT  = colors.HexColor('#f8f9fa')
COLOR_GRAY   = colors.HexColor('#636e72')
COLOR_WHITE  = colors.white
COLOR_RED    = colors.HexColor('#d63031')

# ── 樣式 ──
styles = getSampleStyleSheet()

def S(name, **kw):
    return ParagraphStyle(name, fontName=FONT_NAME, **kw)

TITLE   = S('Title2',   fontSize=22, textColor=COLOR_DARK, spaceAfter=4, leading=28, alignment=TA_CENTER)
SUBTITLE= S('Sub',      fontSize=11, textColor=COLOR_GRAY, spaceAfter=12, alignment=TA_CENTER)
H1      = S('H1',       fontSize=14, textColor=COLOR_WHITE, spaceAfter=6, leading=20,
             backColor=COLOR_ACCENT, leftIndent=-12, borderPadding=(6,12,6,12))
H2      = S('H2',       fontSize=12, textColor=COLOR_ACCENT, spaceAfter=4, leading=18, spaceBefore=10)
BODY    = S('Body2',    fontSize=9,  textColor=COLOR_DARK,  spaceAfter=3, leading=14)
SMALL   = S('Small',    fontSize=8,  textColor=COLOR_GRAY,  spaceAfter=2, leading=12)
BOLD    = S('Bold2',    fontSize=9,  textColor=COLOR_DARK,  spaceAfter=3, leading=14)
NOTE    = S('Note',     fontSize=8,  textColor=COLOR_GRAY,  spaceAfter=2, leading=11, leftIndent=10)
TAG_G   = S('TagG',     fontSize=8,  textColor=COLOR_GREEN, leading=11)
TAG_R   = S('TagR',     fontSize=8,  textColor=COLOR_RED,   leading=11)
WARN    = S('Warn',     fontSize=8,  textColor=COLOR_RED,   spaceAfter=2, leading=11)

def hr(color=COLOR_ACCENT, thickness=0.8):
    return HRFlowable(width='100%', thickness=thickness, color=color, spaceAfter=6, spaceBefore=4)

def table_style_base(header_color=COLOR_ACCENT):
    return TableStyle([
        ('BACKGROUND', (0,0), (-1,0), header_color),
        ('TEXTCOLOR',  (0,0), (-1,0), COLOR_WHITE),
        ('FONTNAME',   (0,0), (-1,-1), FONT_NAME),
        ('FONTSIZE',   (0,0), (-1,0), 8),
        ('FONTSIZE',   (0,1), (-1,-1), 7.5),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [COLOR_LIGHT, COLOR_WHITE]),
        ('GRID',       (0,0), (-1,-1), 0.3, colors.HexColor('#dee2e6')),
        ('ALIGN',      (0,0), (-1,-1), 'CENTER'),
        ('ALIGN',      (1,1), (1,-1), 'LEFT'),
        ('VALIGN',     (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 3),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('LEFTPADDING', (0,0), (-1,-1), 5),
        ('RIGHTPADDING', (0,0), (-1,-1), 5),
    ])

# ══════════════════════════════════════
# 資料區
# ══════════════════════════════════════

REPORT_DATE = '2026-04-12'

SECTOR_DATA = [
    {
        'id': 1,
        'sector': 'ABF載板 / PCB',
        'catalyst': '● AI GPU需求持續爆發，ABF供需缺口法人預估2028年達42%\n● 外資（大摩、高盛、花旗）齊升評，南電目標價升至750元\n● ABF漲價趨勢確立，2026年售價年增率估2-3成\n● T-glass供應瓶頸加劇缺貨，量價齊揚',
        'stocks': [
            ('8046','南電',   99, '+1', '16.2', '41.8', '0.995','0.635','667',  '否'),
            ('3037','欣興',   99, '+1', '30.6', '36.9', '1.000','0.738','638',  '否'),
            ('2383','台光電', 98,  '0', '19.6', '39.6', '1.000','0.701','3420', '否'),
            ('3189','景碩',   97,  '0', '14.8', '31.2', '0.952','0.695','381',  '否'),
            ('2313','華通',   98, '+1',  '7.5', '40.2', '1.000','0.469','286',  '否'),
            ('6213','聯茂',   96, '+4', '31.3', '60.3', '0.979','0.683','214',  '否'),
            ('4958','臻鼎-KY',94, '+4', '20.7', '51.9', '1.000','0.653','265',  '否'),
            ('2316','楠梓電', 94, '+4', '18.6', '24.3', '0.912','0.866','118',  '外資連買3日'),
            ('8039','台虹',   95, '+1', '23.4', '17.6', '1.000','0.873','137',  '否'),
            ('6274','台燿',   98, '+2', '29.7', '65.4', '1.000','0.633','808',  '外資連買7日★'),
            ('2368','金像電', 98,  '0', '15.2', '21.4', '0.993','0.841','1090', '否'),
        ],
        'recommend': '欣興(3037)、台光電(2383) — 主升段確立，外資持續升評，動能強但未過度延伸',
        'risk': '若AI資本支出因關稅/景氣疑慮收縮，需注意短線過熱修正',
    },
    {
        'id': 2,
        'sector': '探針卡 / 半導體測試',
        'catalyst': '● AI ASIC、HBM4測試需求爆發，MEMS探針卡單價遠高於傳統\n● CoWoS、先進封裝產能擴張，測試頻率大幅提升\n● 旺矽合約負債創新高，產能擴充超過30%\n● 謝金河點名探針卡為"飆股代名詞"',
        'stocks': [
            ('6223','旺矽',   99, '+1', '17.0', '40.6', '1.000','0.719','4620','否'),
            ('6515','穎崴',   99, '+1',  '8.8', '34.4', '0.918','0.639','7930','否'),
            ('6217','中探針', 99, '+1', '31.8','109.3', '1.000','0.588','236.5','否'),
        ],
        'recommend': '旺矽(6223) — 三引擎（ASIC+HBM+CPO）、RS99、產能擴充確認，是本輪最強結構股之一',
        'risk': '中探針20日漲幅達109%，短線明顯延伸，須等回測再進',
    },
    {
        'id': 3,
        'sector': '光通訊 / 矽光子 / CPO',
        'catalyst': '● 輝達砸400億入股光通訊供應鏈，矽光子題材大爆發\n● CPO（共封裝光學）進入量產初期，51.2T/102.4T規格推進\n● OFC 2026展覽帶動資金回流，聯亞毛利衝上48%\n● 低軌衛星（Starlink競爭）帶動光模組需求',
        'stocks': [
            ('3081','聯亞',   99,  '0', '33.8', '48.9', '1.000','0.631','2315','否'),
            ('6451','訊芯-KY',96, '+21','41.6','128.0', '1.000','0.671','432', '否'),
            ('6442','光聖',   98,  '0', '14.5', '28.5', '0.981','0.589','2325','否'),
            ('2455','全新',   95, '+2', '13.5', '35.0', '1.000','0.644','299', '否'),
            ('6830','汎銓',   98, '+1', '36.2', '78.1', '1.000','0.574','700', '外資連買2日'),
            ('3491','昇達科', 97,  '0', '21.4', '43.5', '1.000','0.684','1815','否'),
            ('4979','華星光', 94, '-1', '19.7', '17.2', '0.947','0.530','449.5','否'),
        ],
        'recommend': '聯亞(3081) — Nvidia入股背書+毛利擴張+RS99；全新(2455) — 相對未延伸',
        'risk': '訊芯-KY已漲128%，屬超級延伸段，Minervini邏輯建議等待新底部',
    },
    {
        'id': 4,
        'sector': 'GaN / 砷化鎵 / RF',
        'catalyst': '● Wi-Fi 7滲透率2026年估翻倍，PA用GaN需求高增長\n● 低軌衛星、航太、軍工GaN PA放量\n● 恩智浦(NXP)退出5G PA市場，台廠三雄迎轉單商機\n● 4月投資攻略點名穩懋、聯亞為低軌衛星+光通訊雙題材',
        'stocks': [
            ('3105','穩懋',   97, '+1', '23.2', '55.2', '1.000','0.636','464', '否'),
            ('2455','全新',   95, '+2', '13.5', '35.0', '1.000','0.644','299', '否'),
            ('4577','達航科技',98, '+1', '25.6', '36.4', '1.000','0.716','127.5','否'),
            ('3163','波若威', 99,  '0', '45.5', '63.6', '1.000','0.729','1260','否'),
        ],
        'recommend': '穩懋(3105) — Wi-Fi 7+衛星+轉單三重催化；達航科技(4577) — 動能強、VCP佳',
        'risk': '穩懋p20d已55%，屬偏延伸，宜等5-10%回測',
    },
    {
        'id': 5,
        'sector': 'AI散熱 / 電源管理',
        'catalyst': '● AI伺服器水冷滲透率高盛估2026年快速攀升\n● ASIC自研晶片散熱規格更嚴，帶動高階散熱模組需求\n● 台達電同時受惠AI電源（PSU/VR）及散熱\n● 健策、高力攻AI GPU液冷散熱背板',
        'stocks': [
            ('3017','奇鋐',   97,  '0',  '7.3', '21.8', '0.991','0.625','2265','否'),
            ('3653','健策',   97, '+1',  '4.4', '18.4', '0.948','0.711','4125','否'),
            ('8996','高力',   97,  '0', '14.5', '24.7', '1.000','0.694','1040','否'),
            ('2308','台達電', 97, '-1', '17.6', '23.9', '1.000','0.844','1735','否'),
        ],
        'recommend': '台達電(2308) — RS97、VCP 0.844（最佳型態），20日漲幅僅24%，相對穩健；高力(8996) — RS97、接近突破',
        'risk': '散熱股本波已漲幅大，需留意若大盤修正散熱個股易回吐',
    },
    {
        'id': 6,
        'sector': '半導體設備 / 先進封裝',
        'catalyst': '● CoWoS產線擴張帶動台廠設備/化學品需求\n● AI先進封裝裝置訂單能見度高（辛耘漲停受惠AI先進封裝）\n● 晶圓廠2026年資本支出創歷史新高\n● 外資連買辛耘(2日)、弘塑(1日)',
        'stocks': [
            ('3583','辛耘',   94, '+17', '44.7', '81.2', '1.000','0.750','673',  '外資連買2日'),
            ('3131','弘塑',   95,  '+3',  '8.2', '61.7', '0.915','0.442','3170', '外資連買1日'),
            ('6640','均華',   97,  '+3', '15.1', '66.1', '1.000','0.517','1600', '否'),
            ('3264','欣銓',   94,   '0', '13.9', '22.7', '1.000','0.806','189',  '否'),
            ('3030','德律',   95,  '+1', '18.1', '19.8', '1.000','0.891','303',  '否'),
        ],
        'recommend': '欣銓(3264) — 最未延伸，VCP 0.806；德律(3030) — RS95、VCP 0.891，型態最佳',
        'risk': '辛耘、均華、弘塑近20日漲幅60-80%，屬延伸段，勿追高',
    },
    {
        'id': 7,
        'sector': '被動元件 / MLCC',
        'catalyst': '● AI伺服器電源高壓化，MLCC單價上漲，禾伸堂客製化MLCC全球第一\n● 法人預估禾伸堂2026年EPS 8元→2027年13元\n● 日台同步擴產至2029年，中長期能見度高\n● 外資連買禾伸堂達9日（最長）',
        'stocks': [
            ('3026','禾伸堂', 93, '+17', '36.6', '82.2', '1.000','0.727','194', '外資連買9日★★'),
        ],
        'recommend': '禾伸堂(3026) — 外資連買9日為本清單最強外資訊號，但20日漲82%過度延伸，等整理',
        'risk': '短線嚴重延伸，等待20MA附近整理後再評估進場',
    },
    {
        'id': 8,
        'sector': '連接器 / 高速線纜',
        'catalyst': '● AI資料中心升級800G/1.6T，高速連接器需求爆炸\n● 貿聯-KY為AI伺服器線束龍頭，客戶涵蓋輝達/CSP\n● 尖點切入AI測試載板及高速連接，外資連買1日',
        'stocks': [
            ('3665','貿聯-KY',97, '+2', '15.2', '32.9', '1.000','0.566','2200','否'),
            ('8021','尖點',   99,  '0', '28.0', '31.2', '1.000','0.832','317.5','外資連買1日'),
            ('3167','大量',   99, '+2', '56.3', '96.0', '1.000','0.728','633', '否'),
        ],
        'recommend': '貿聯-KY(3665) — 最穩健，RS97、p20d 32.9%；尖點(8021) — RS99、VCP 0.832最佳型態',
        'risk': '大量p5d已56%、p20d 96%，嚴重過熱',
    },
    {
        'id': 9,
        'sector': '記憶體 / BMC / 資料儲存',
        'catalyst': '● AI伺服器BMC晶片：信驊市占率超高，幾乎壟斷\n● 旺宏NOR Flash受惠汽車/AI Edge需求復甦\n● 宜鼎工業級SSD切入AI Edge儲存',
        'stocks': [
            ('5274','信驊',   97, '+1', '11.2', '25.1', '0.995','0.640','12580','否'),
            ('2337','旺宏',   98, '-1', '15.0', '46.4', '0.896','0.524','146',  '否'),
            ('5289','宜鼎',   97, '-1', '24.1', '16.1', '0.811','0.574','1155', '否'),
        ],
        'recommend': '信驊(5274) — BMC壟斷地位+RS97+p20d僅25%，最健康；宜鼎(5289) — 相對低調但pos6m仍在高位',
        'risk': '旺宏RS連續下滑，動能趨緩，觀察',
    },
]

# 外資+RS 交叉清單
FOREIGN_CROSS = [
    ('3026','禾伸堂',  93, '+17',36.6, 82.2,'1.000','0.727', 9,'★★★ 最強外資信號（但已延伸）'),
    ('4971','IET-KY', 98,  '+0',11.6, 34.4,'1.000','0.353', 8,'★★★ 外資連買8日，未過度延伸'),
    ('6274','台燿',   98,  '+2',29.7, 65.4,'1.000','0.633', 7,'★★  外資連買7日，ABF上游材料'),
    ('8358','金居',   96,  '+1',12.6, 21.3,'0.720','0.811', 4,'★   銅箔，VCP佳但pos6m偏低'),
    ('2316','楠梓電', 94,  '+4',18.6, 24.3,'0.912','0.866', 3,'★   PCB，型態良好'),
    ('6830','汎銓',   98,  '+1',36.2, 78.1,'1.000','0.574', 2,'★   光通訊量測，近期大漲'),
    ('3583','辛耘',   94, '+17',44.7, 81.2,'1.000','0.750', 2,'★   先進封裝設備，大漲後整理待確認'),
    ('8021','尖點',   99,  '+0',28.0, 31.2,'1.000','0.832', 1,'★★  RS99+VCP 0.832，型態最佳'),
    ('3131','弘塑',   95,  '+3', 8.2, 61.7,'0.915','0.442', 1,'    設備股'),
]

# 最終推薦清單
PICKS = {
    '短線（1-2週）動能強，型態健康': [
        ('欣興',  '3037','ABF載板龍頭','RS99、pos6m 1.0、VCP 0.738，外資升評，未過度延伸','p20d 37%'),
        ('旺矽',  '6223','探針卡龍頭','RS99、ASIC+HBM三引擎，擴產確認，合約負債新高','p20d 41%'),
        ('台光電','2383','ABF上游CCL','RS98、pos6m 1.0、VCP 0.701，高盛看多','p20d 40%'),
        ('尖點',  '8021','高速連接器/測試','RS99、VCP 0.832（本清單最高），外資買超','p20d 31%'),
        ('聯亞',  '3081','光通訊/矽光子','RS99、Nvidia入股效應、毛利率衝48%','p20d 49%'),
    ],
    '中線（1個月）題材明確，等待整理後進場': [
        ('台達電','2308','AI電源+散熱','RS97、VCP 0.844（最佳），20日僅漲24%，最健康的大型股','p20d 24%'),
        ('信驊',  '5274','BMC晶片壟斷','RS97、p20d僅25%，BMC市占率無可撼動','p20d 25%'),
        ('穩懋',  '3105','GaN+衛星+轉單','RS97、三重催化，等5-8%回測後進場','p20d 55%（需等整理）'),
        ('IET-KY','4971','光通訊模組','RS98、外資連買8日，p20d 34%相對健康','p20d 34%'),
        ('楠梓電','2316','PCB','RS94、外資連買3日、VCP 0.866，型態穩','p20d 24%'),
    ],
    '觀察名單（強勢但已延伸，等新底部）': [
        ('訊芯-KY','6451','矽光子CPO','p20d已128%，等待建立新底部再評估','p20d 128%'),
        ('辛耘',  '3583','先進封裝設備','p20d 81%，外資雖買但嚴重延伸','p20d 81%'),
        ('禾伸堂','3026','MLCC','外資連買9日訊號最強，但20日漲82%','p20d 82%'),
        ('台燿',  '6274','ABF材料','外資連買7日，但p20d已65%','p20d 65%'),
    ],
}

SECTOR_OUTLOOK = [
    ('ABF載板/PCB',  '主升段', '供需缺口持續擴大，法人集體升評，多頭格局確立', '◎◎◎'),
    ('探針卡',       '主升段', 'AI ASIC+HBM雙引擎，旺矽擴產確認，族群帶頭', '◎◎◎'),
    ('光通訊/矽光子','急漲段', 'Nvidia入股為中長期題材，短線已過熱須等整理', '◎◎'),
    ('GaN/RF',       '主升段', '多重催化（Wi-Fi7+衛星+轉單），仍在合理區間', '◎◎◎'),
    ('AI散熱',       '整理段', '本波前段強股，此刻多已偏延伸，等回測機會', '◎◎'),
    ('半導體設備',   '急漲段', 'CoWoS擴產明確，但辛耘/均華已過熱，等整理', '◎◎'),
    ('被動元件',     '急漲段', '外資訊號強，但個股延伸，中線布局等回測', '◎'),
    ('連接器',       '初升段', '800G題材，貿聯/尖點型態良好', '◎◎◎'),
    ('BMC/記憶體',   '主升段', '信驊壟斷格局，型態健康，適合中線', '◎◎'),
]

NOTE_FOREIGN = '⚠️ 注意：stockWatchlist 中的外資資料共涵蓋 203 檔，並非全市場完整外資資料。RS強勢股中，有 9 檔同時出現在外資買超清單中，為多重確認訊號最強的候選股。'
NOTE_MINERVINI = '本報告選股邏輯遵循 Mark Minervini SEPA 方法：RS強勢（≥95）、股價創6個月新高（pos6m≥0.90）、動能強勁但未過度延伸（p20d建議30-60%）、VCP型態良好（≥0.65）、有明確基本面催化劑。'

# ══════════════════════════════════════
# PDF 生成
# ══════════════════════════════════════

doc = SimpleDocTemplate(
    OUTPUT_PATH,
    pagesize=A4,
    leftMargin=2*cm, rightMargin=2*cm,
    topMargin=2*cm, bottomMargin=2*cm,
)

story = []

# ── 封面 ──
story.append(Spacer(1, 1.5*cm))
story.append(Paragraph('台股 RS 強勢股週報', TITLE))
story.append(Paragraph(f'報告日期：{REPORT_DATE}　｜　資料來源：Firestore ibdRsRatings + stockWatchlist', SUBTITLE))
story.append(hr(COLOR_GOLD, 1.5))
story.append(Spacer(1, 0.3*cm))

# 統計摘要 box
summary_data = [
    ['統計項目', '數值', '說明'],
    ['RS ≥ 85 股票總數', '286 檔', '全市場上市+上櫃'],
    ['RS ≥ 90 + 高位 + 動能強', '121 檔', 'Minervini 初篩條件'],
    ['外資買超信號（watchlist）', '25 檔', 'foreignSignal = B'],
    ['RS強勢 ∩ 外資買超', '9 檔', '雙重確認最強候選'],
    ['資料截止日', '2026-04-10', 'Firestore 最新同步'],
]
t = Table(summary_data, colWidths=[5.5*cm, 3*cm, 8*cm])
t.setStyle(table_style_base(COLOR_NAVY))
story.append(t)
story.append(Spacer(1, 0.5*cm))

story.append(Paragraph(NOTE_MINERVINI, NOTE))
story.append(Spacer(1, 0.3*cm))
story.append(Paragraph(NOTE_FOREIGN, NOTE))
story.append(Spacer(1, 0.5*cm))

# ── 產業題材分類 ──
story.append(hr())
story.append(Paragraph('一、產業題材分類與強勢股清單', H1))
story.append(Spacer(1, 0.3*cm))

COL_HDR = ['代碼','股名','RS','RS月変','5日%','20日%','位置','VCP','收盤','外資']
COL_W   = [1.3*cm, 2.0*cm, 0.8*cm, 1.2*cm, 1.2*cm, 1.2*cm, 1.2*cm, 1.2*cm, 1.5*cm, 3.5*cm]

for sec in SECTOR_DATA:
    story.append(Paragraph(f"【{sec['id']}】{sec['sector']}", H2))
    # catalyst
    for line in sec['catalyst'].split('\n'):
        if line.strip():
            story.append(Paragraph(line.strip(), BODY))
    story.append(Spacer(1, 0.15*cm))

    # table
    rows = [COL_HDR]
    for s in sec['stocks']:
        rows.append(list(s))
    t = Table(rows, colWidths=COL_W)
    ts = table_style_base()
    # highlight pos6m >= 0.99 rows
    for i, s in enumerate(sec['stocks'], 1):
        if float(s[6]) >= 0.99:
            ts.add('BACKGROUND', (0,i), (-1,i), colors.HexColor('#e8f5e9'))
        if '★' in str(s[9]):
            ts.add('BACKGROUND', (9,i), (9,i), colors.HexColor('#fff3e0'))
    t.setStyle(ts)
    story.append(t)

    story.append(Spacer(1, 0.1*cm))
    story.append(Paragraph(f'▶ 推薦：{sec["recommend"]}', BOLD))
    story.append(Paragraph(f'⚠ 風險：{sec["risk"]}', WARN))
    story.append(Spacer(1, 0.4*cm))

# ── 外資+RS交叉清單 ──
story.append(PageBreak())
story.append(hr())
story.append(Paragraph('二、RS強勢 × 外資買超 交叉清單', H1))
story.append(Spacer(1, 0.2*cm))
story.append(Paragraph('以下為同時出現在「RS強勢清單」與「外資連續買超」的股票，為多空信號最強的候選組合。', BODY))
story.append(Spacer(1, 0.2*cm))

fg_hdr = ['代碼','股名','RS','RS月変','5日%','20日%','pos6m','VCP','外資連買日','備註說明']
fg_w   = [1.3*cm,2.0*cm,0.8*cm,1.2*cm,1.2*cm,1.2*cm,1.2*cm,1.2*cm,2.0*cm,4.3*cm]
fg_rows = [fg_hdr]
for r in FOREIGN_CROSS:
    fg_rows.append(list(r))
t = Table(fg_rows, colWidths=fg_w)
ts = table_style_base(COLOR_GOLD)
ts.add('TEXTCOLOR', (0,0),(-1,0), COLOR_DARK)
# highlight top 3
for i in range(1, 4):
    ts.add('BACKGROUND', (0,i),(-1,i), colors.HexColor('#fff8e1'))
t.setStyle(ts)
story.append(t)
story.append(Spacer(1, 0.5*cm))

# ── 最終操作建議 ──
story.append(hr())
story.append(Paragraph('三、操作建議 — 依 Minervini SEPA 邏輯', H1))
story.append(Spacer(1, 0.2*cm))

for category, picks in PICKS.items():
    story.append(Paragraph(f'【{category}】', H2))
    pick_hdr = ['股名','代碼','產業','選股理由','目前延伸度']
    pick_w   = [2.0*cm,1.4*cm,3.0*cm,7.0*cm,2.8*cm]
    pick_rows = [pick_hdr] + [list(p) for p in picks]
    t = Table(pick_rows, colWidths=pick_w)
    ts2 = table_style_base(COLOR_GREEN if '短線' in category else
                           COLOR_ACCENT if '中線' in category else COLOR_GRAY)
    t.setStyle(ts2)
    story.append(t)
    story.append(Spacer(1, 0.3*cm))

# ── 產業後市評估 ──
story.append(Spacer(1, 0.3*cm))
story.append(hr())
story.append(Paragraph('四、各產業後市評估（未來1個月）', H1))
story.append(Spacer(1, 0.2*cm))

outlook_hdr = ['產業', '目前段位', '評估說明', '看法']
outlook_w   = [3.0*cm, 2.0*cm, 9.5*cm, 1.5*cm]
outlook_rows = [outlook_hdr] + [list(r) for r in SECTOR_OUTLOOK]
t = Table(outlook_rows, colWidths=outlook_w)
ts3 = table_style_base(COLOR_NAVY)
# color code outlook column
for i, row in enumerate(SECTOR_OUTLOOK, 1):
    score = row[3].count('◎')
    if score == 3:
        ts3.add('BACKGROUND', (3,i),(3,i), colors.HexColor('#c8e6c9'))
    elif score == 2:
        ts3.add('BACKGROUND', (3,i),(3,i), colors.HexColor('#fff9c4'))
    else:
        ts3.add('BACKGROUND', (3,i),(3,i), colors.HexColor('#ffccbc'))
t.setStyle(ts3)
story.append(t)

# ── 免責聲明 ──
story.append(Spacer(1, 0.8*cm))
story.append(hr(COLOR_GRAY, 0.5))
story.append(Paragraph(
    '本報告為個人研究用途，依據 Firestore 資料庫 RS 排名系統及公開網路資訊整理，不構成投資建議。'
    '所有股價與漲跌幅資料截至 2026-04-10，投資請自行評估風險。',
    SMALL
))

doc.build(story)
print(f'PDF 已生成：{OUTPUT_PATH}')
