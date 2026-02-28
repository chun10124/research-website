import React, { useState, useMemo, useCallback } from 'react';
import styles from './InvestorCalendar.module.css';

const VIEWS = [
  { id: 'month', label: '月' },
  { id: 'quarter', label: '季' },
  { id: 'half', label: '半年' },
  { id: 'year', label: '年' },
];

const TAGS_STORAGE_KEY = 'investor-calendar-tags';

// 預設範例事件（可改為從 Firebase/localStorage 載入），無標籤
const DEFAULT_EVENTS = [
  { id: '1', title: '財報公布', date: '2025-03-15', tags: [] },
  { id: '2', title: 'FOMC 會議', date: '2025-03-19', tags: [] },
  { id: '3', title: '除息日', date: '2025-03-20', tags: [] },
  { id: '4', title: '法說會', date: '2025-03-25', tags: [] },
  { id: '5', title: '季底結算', date: '2025-03-31', tags: [] },
  { id: '6', title: 'Q1 財報', date: '2025-04-30', tags: [] },
  { id: '7', title: '股東會', date: '2025-05-15', tags: [] },
];

function loadCustomTags() {
  try {
    const raw = localStorage.getItem(TAGS_STORAGE_KEY);
    if (raw !== null && raw !== undefined) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) {}
  return [];
}

function getTagColor(tagName, customTags) {
  const t = customTags.find((c) => c.name === tagName);
  return t ? t.color : '#6b7280';
}

function getMonthStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function getQuarterStart(d) {
  const m = d.getMonth();
  const q = Math.floor(m / 3) * 3;
  return new Date(d.getFullYear(), q, 1);
}

function getHalfStart(d) {
  const m = d.getMonth();
  const h = m < 6 ? 0 : 6;
  return new Date(d.getFullYear(), h, 1);
}

function getYearStart(d) {
  return new Date(d.getFullYear(), 0, 1);
}

function addMonths(d, n) {
  const out = new Date(d);
  out.setMonth(out.getMonth() + n);
  return out;
}

function formatRange(viewId, base) {
  const y = base.getFullYear();
  const m = base.getMonth();
  if (viewId === 'month') return `${y}年${m + 1}月`;
  if (viewId === 'quarter') {
    const end = addMonths(base, 2);
    return `${y}年${m + 1}月～${end.getMonth() + 1}月`;
  }
  if (viewId === 'half') {
    const shortYear = String(y).slice(-2);
    return m < 6 ? `1H${shortYear}` : `2H${shortYear}`;
  }
  if (viewId === 'year') return `${y}年`;
  return '';
}

function getCellsForView(viewId, base) {
  const cells = [];
  if (viewId === 'month') {
    const start = getMonthStart(base);
    const startDay = start.getDay();
    const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    const prevFill = startDay;
    const total = Math.ceil((prevFill + daysInMonth) / 7) * 7;
    for (let i = 0; i < total; i++) {
      if (i < prevFill) {
        cells.push({ type: 'pad', date: null });
      } else {
        const day = i - prevFill + 1;
        if (day <= daysInMonth) {
          const d = new Date(base.getFullYear(), base.getMonth(), day);
          cells.push({ type: 'day', date: d, label: String(day) });
        } else {
          cells.push({ type: 'pad', date: null });
        }
      }
    }
  } else if (viewId === 'quarter') {
    const start = getMonthStart(base);
    for (let i = 0; i < 3; i++) {
      const monthDate = addMonths(start, i);
      cells.push({
        type: 'monthBlock',
        date: monthDate,
        label: `${monthDate.getMonth() + 1}月`,
      });
    }
  } else if (viewId === 'half') {
    const y = base.getFullYear();
    const startMonth = base.getMonth() < 6 ? 0 : 6;
    for (let i = 0; i < 6; i++) {
      const monthDate = addMonths(new Date(y, startMonth, 1), i);
      cells.push({
        type: 'monthBlock',
        date: monthDate,
        label: `${monthDate.getMonth() + 1}月`,
      });
    }
  } else if (viewId === 'year') {
    const start = getYearStart(base);
    for (let i = 0; i < 12; i++) {
      const monthDate = addMonths(start, i);
      cells.push({
        type: 'monthBlock',
        date: monthDate,
        label: `${monthDate.getMonth() + 1}月`,
      });
    }
  }
  return cells;
}

function dateToKey(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateKey(s) {
  if (!s || s.length < 10) return null;
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(5, 7), 10) - 1;
  const d = parseInt(s.slice(8, 10), 10);
  return new Date(y, m, d);
}

function addDays(key, n) {
  const d = parseDateKey(key);
  if (!d) return key;
  d.setDate(d.getDate() + n);
  return dateToKey(d);
}

function addMonthsToKey(key, n) {
  const d = parseDateKey(key);
  if (!d) return key;
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const target = new Date(y, m + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return dateToKey(target);
}

function addYears(key, n) {
  const d = parseDateKey(key);
  if (!d) return key;
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const target = new Date(y + n, m, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return dateToKey(target);
}

function daysBetween(a, b) {
  const d1 = parseDateKey(a);
  const d2 = parseDateKey(b);
  if (!d1 || !d2) return 0;
  return Math.round((d2 - d1) / (24 * 60 * 60 * 1000));
}

const FREQUENCY_OPTIONS = [
  { id: 'once', label: '一次' },
  { id: 'weekly', label: '每週' },
  { id: 'monthly', label: '每月' },
  { id: 'quarterly', label: '每季' },
  { id: 'yearly', label: '每年' },
];

function getEventStart(event) {
  return event.startDate || event.date;
}

function getEventEnd(event) {
  return event.endDate || event.date;
}

function getEventFrequency(event) {
  return event.frequency || 'once';
}

function isDateInEvent(dateKey, event) {
  const start = getEventStart(event);
  const end = getEventEnd(event);
  if (!start || !end) return false;
  const freq = getEventFrequency(event);
  if (dateKey < start) return false;
  if (freq === 'once') return dateKey <= end;
  const durationDays = Math.max(0, daysBetween(start, end));
  const maxOccurrences = 120; // cap for weekly ~2 years
  if (freq === 'weekly') {
    for (let n = 0; n < maxOccurrences; n++) {
      const s = addDays(start, n * 7);
      const e = addDays(end, n * 7);
      if (dateKey >= s && dateKey <= e) return true;
      if (s > dateKey) break;
    }
    return false;
  }
  if (freq === 'monthly') {
    for (let n = 0; n < 24; n++) {
      const s = addMonthsToKey(start, n);
      const e = addDays(s, durationDays);
      if (dateKey >= s && dateKey <= e) return true;
      if (s > dateKey) break;
    }
    return false;
  }
  if (freq === 'quarterly') {
    for (let n = 0; n < 12; n++) {
      const s = addMonthsToKey(start, n * 3);
      const e = addDays(s, durationDays);
      if (dateKey >= s && dateKey <= e) return true;
      if (s > dateKey) break;
    }
    return false;
  }
  if (freq === 'yearly') {
    for (let n = 0; n < 5; n++) {
      const s = addYears(start, n);
      const e = addDays(s, durationDays);
      if (dateKey >= s && dateKey <= e) return true;
      if (s > dateKey) break;
    }
    return false;
  }
  return dateKey <= end;
}

function eventInCell(event, cell) {
  if (!cell.date) return false;
  return isDateInEvent(dateToKey(cell.date), event);
}

function eventInMonthBlock(event, cell) {
  if (!cell.date || cell.type !== 'monthBlock') return false;
  const span = cell.monthSpan || 1;
  const startY = cell.date.getFullYear();
  const startM = cell.date.getMonth();
  for (let mi = 0; mi < span; mi++) {
    const monthDate = new Date(startY, startM + mi, 1);
    const cellY = monthDate.getFullYear();
    const cellM = monthDate.getMonth() + 1;
    const lastDay = new Date(cellY, cellM, 0).getDate();
    for (let d = 1; d <= lastDay; d++) {
      const dayKey = `${cellY}-${String(cellM).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (isDateInEvent(dayKey, event)) return true;
    }
  }
  return false;
}

export default function InvestorCalendar() {
  const [events, setEvents] = useState(() => {
    try {
      const raw = localStorage.getItem('investor-calendar-events');
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return DEFAULT_EVENTS;
  });

  const [customTags, setCustomTags] = useState(loadCustomTags);
  const [viewId, setViewId] = useState('month');
  const [baseDate, setBaseDate] = useState(() => new Date());
  const [visibleTags, setVisibleTags] = useState(() => {
    const tags = [...new Set(events.flatMap((e) => e.tags || []))];
    return Object.fromEntries(tags.map((t) => [t, true]));
  });
  const [transitioning, setTransitioning] = useState(false);
  const [editingTagId, setEditingTagId] = useState(null);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#6b7280');
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [isAddEventOpen, setIsAddEventOpen] = useState(false);
  const [editingEventId, setEditingEventId] = useState(null);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventDate, setNewEventDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newEventEndDate, setNewEventEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newEventTags, setNewEventTags] = useState([]);
  const [newEventTagsRaw, setNewEventTagsRaw] = useState('');
  const [newEventFrequency, setNewEventFrequency] = useState('once');

  const persistCustomTags = useCallback((next) => {
    setCustomTags(next);
    try {
      localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(next));
    } catch (_) {}
  }, []);

  const allTags = useMemo(() => {
    const fromEvents = new Set(events.flatMap((e) => e.tags || []));
    const fromCustom = new Set(customTags.map((t) => t.name));
    const customOrder = customTags.map((t) => t.name);
    const eventOnly = [...fromEvents].filter((n) => !fromCustom.has(n)).sort();
    return [...customOrder, ...eventOnly];
  }, [events, customTags]);

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      const tags = e.tags || [];
      return tags.some((t) => visibleTags[t]);
    });
  }, [events, visibleTags]);

  const toggleTag = useCallback((tag) => {
    setVisibleTags((prev) => ({ ...prev, [tag]: !prev[tag] }));
  }, []);

  const handleViewChange = useCallback((newViewId) => {
    if (newViewId === viewId) return;
    setTransitioning(true);
    setViewId(newViewId);
    setTimeout(() => setTransitioning(false), 320);
  }, [viewId]);

  const nav = useCallback((delta) => {
    setBaseDate((prev) => {
      const next = new Date(prev);
      if (viewId === 'month') next.setMonth(next.getMonth() + delta);
      else if (viewId === 'quarter') next.setMonth(next.getMonth() + delta * 3);
      else if (viewId === 'half') next.setMonth(next.getMonth() + delta * 6);
      else next.setFullYear(next.getFullYear() + delta);
      return next;
    });
  }, [viewId]);

  const cells = useMemo(() => getCellsForView(viewId, baseDate), [viewId, baseDate]);

  const rangeText = formatRange(viewId, baseDate);

  const persistEvents = useCallback((next) => {
    setEvents(next);
    try {
      localStorage.setItem('investor-calendar-events', JSON.stringify(next));
    } catch (_) {}
  }, []);

  const openAddEvent = useCallback(() => {
    const today = new Date().toISOString().slice(0, 10);
    setIsAddEventOpen(true);
    setNewEventTitle('');
    setNewEventDate(today);
    setNewEventEndDate(today);
    setNewEventTags([]);
    setNewEventTagsRaw('');
    setNewEventFrequency('once');
  }, []);

  const closeAddEvent = useCallback(() => {
    setIsAddEventOpen(false);
    setEditingEventId(null);
  }, []);

  const openEditEvent = useCallback((event) => {
    setEditingEventId(event.id);
    setIsAddEventOpen(true);
    setNewEventTitle(event.title || '');
    setNewEventDate(getEventStart(event));
    setNewEventEndDate(getEventEnd(event));
    setNewEventTags(event.tags || []);
    setNewEventTagsRaw('');
    setNewEventFrequency(getEventFrequency(event));
  }, []);

  const toggleNewEventTag = useCallback((tagName) => {
    setNewEventTags((prev) =>
      prev.includes(tagName) ? prev.filter((t) => t !== tagName) : [...prev, tagName]
    );
  }, []);

  const submitEventForm = useCallback(() => {
    const title = newEventTitle.trim();
    if (!title) return;
    const startDate = newEventDate.trim();
    if (!startDate) return;
    let endDate = newEventEndDate.trim();
    if (!endDate || endDate < startDate) endDate = startDate;
    const extra = newEventTagsRaw.trim() ? newEventTagsRaw.split(/\s+/).map((t) => t.trim()).filter(Boolean) : [];
    const tags = [...new Set([...newEventTags, ...extra])];
    if (editingEventId) {
      const updated = events.map((e) =>
        e.id === editingEventId ? { ...e, title, startDate, endDate, tags, frequency: newEventFrequency } : e
      );
      persistEvents(updated);
    } else {
      const id = String(Date.now());
      persistEvents([...events, { id, title, startDate, endDate, tags, frequency: newEventFrequency }]);
    }
    setVisibleTags((prev) => ({ ...prev, ...Object.fromEntries(tags.map((t) => [t, true])) }));
    closeAddEvent();
  }, [events, editingEventId, newEventTitle, newEventDate, newEventEndDate, newEventTags, newEventTagsRaw, newEventFrequency, persistEvents, closeAddEvent]);

  const startAddTag = useCallback(() => {
    setIsAddingTag(true);
    setNewTagName('');
    setNewTagColor('#6b7280');
    setEditingTagId(null);
  }, []);

  const saveNewTag = useCallback(() => {
    const name = newTagName.trim();
    if (!name) {
      setIsAddingTag(false);
      return;
    }
    if (customTags.some((t) => t.name === name)) {
      setIsAddingTag(false);
      return;
    }
    persistCustomTags([...customTags, { id: `t${Date.now()}`, name, color: newTagColor }]);
    setVisibleTags((prev) => ({ ...prev, [name]: true }));
    setIsAddingTag(false);
  }, [customTags, newTagName, newTagColor, persistCustomTags]);

  const startEditTag = useCallback((tag) => {
    const t = customTags.find((c) => c.name === tag);
    if (!t) return;
    setEditingTagId(t.id);
    setNewTagName(t.name);
    setNewTagColor(t.color);
    setIsAddingTag(false);
  }, [customTags]);

  const openEditTagOrCreate = useCallback((tagName) => {
    const existing = customTags.find((c) => c.name === tagName);
    if (existing) {
      startEditTag(tagName);
      return;
    }
    const newTag = { id: `t${Date.now()}`, name: tagName, color: '#6b7280' };
    persistCustomTags([...customTags, newTag]);
    setEditingTagId(newTag.id);
    setNewTagName(newTag.name);
    setNewTagColor(newTag.color);
    setIsAddingTag(false);
  }, [customTags, persistCustomTags, startEditTag]);

  const saveEditTag = useCallback(() => {
    const t = customTags.find((c) => c.id === editingTagId);
    if (!t) {
      setEditingTagId(null);
      return;
    }
    const name = newTagName.trim();
    if (!name) {
      setEditingTagId(null);
      return;
    }
    const oldName = t.name;
    const nextTags = customTags.map((c) =>
      c.id === editingTagId ? { ...c, name, color: newTagColor } : c
    );
    if (name !== oldName) {
      setEvents((prev) => {
        const updated = prev.map((e) => ({
          ...e,
          tags: (e.tags || []).map((tag) => (tag === oldName ? name : tag)),
        }));
        try {
          localStorage.setItem('investor-calendar-events', JSON.stringify(updated));
        } catch (_) {}
        return updated;
      });
    }
    persistCustomTags(nextTags);
    setVisibleTags((prev) => ({ ...prev, [name]: prev[oldName] ?? true }));
    setEditingTagId(null);
  }, [customTags, editingTagId, newTagName, newTagColor, persistCustomTags]);

  const deleteTag = useCallback((tagName) => {
    persistCustomTags(customTags.filter((t) => t.name !== tagName));
    setEvents((prev) => {
      const updated = prev.map((e) => ({
        ...e,
        tags: (e.tags || []).filter((t) => t !== tagName),
      }));
      try {
        localStorage.setItem('investor-calendar-events', JSON.stringify(updated));
      } catch (_) {}
      return updated;
    });
  }, [customTags, persistCustomTags]);

  const cancelTagForm = useCallback(() => {
    setIsAddingTag(false);
    setEditingTagId(null);
  }, []);

  return (
    <div className={styles.wrapper}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTitle}>顯示標籤</div>
        <ul className={styles.tagList}>
          {allTags.map((tag) => {
            const custom = customTags.find((t) => t.name === tag);
            const isEditing = custom && editingTagId === custom.id;
            if (isEditing) {
              return (
                <li key={tag} className={styles.tagEditRow}>
                  <input
                    type="text"
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    className={styles.tagEditInput}
                    placeholder="標籤名稱"
                  />
                  <input
                    type="color"
                    value={newTagColor}
                    onChange={(e) => setNewTagColor(e.target.value)}
                    className={styles.tagColorInput}
                    title="顏色"
                  />
                  <button type="button" className={styles.tagFormBtn} onClick={saveEditTag}>儲存</button>
                  <button type="button" className={styles.tagFormBtnCancel} onClick={cancelTagForm}>取消</button>
                </li>
              );
            }
            return (
              <li key={tag} className={styles.tagRow}>
                <label className={styles.tagLabel}>
                  <input
                    type="checkbox"
                    checked={visibleTags[tag] ?? true}
                    onChange={() => toggleTag(tag)}
                  />
                  <span className={styles.tagDot} style={{ backgroundColor: getTagColor(tag, customTags) }} />
                </label>
                <button
                  type="button"
                  className={styles.tagNameClickable}
                  onClick={() => openEditTagOrCreate(tag)}
                  title="點擊編輯"
                >
                  {tag}
                </button>
                {custom ? (
                  <button type="button" className={styles.tagActionBtn} onClick={() => deleteTag(tag)} title="刪除">×</button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {isAddingTag ? (
          <div className={styles.tagEditRow}>
            <input
              type="text"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              className={styles.tagEditInput}
              placeholder="標籤名稱"
            />
            <input
              type="color"
              value={newTagColor}
              onChange={(e) => setNewTagColor(e.target.value)}
              className={styles.tagColorInput}
              title="顏色"
            />
            <button type="button" className={styles.tagFormBtn} onClick={saveNewTag}>新增</button>
            <button type="button" className={styles.tagFormBtnCancel} onClick={cancelTagForm}>取消</button>
          </div>
        ) : (
          <button type="button" className={styles.addTagBtn} onClick={startAddTag}>
            新增標籤
          </button>
        )}
        {allTags.length === 0 && !isAddingTag && <p className={styles.noTags}>尚無標籤，可先新增標籤或新增事件</p>}
        <button type="button" className={styles.addEventBtn} onClick={openAddEvent}>
          新增事件
        </button>
      </aside>

      {(isAddEventOpen || editingEventId) && (
        <div className={styles.modalOverlay} onClick={closeAddEvent}>
          <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>{editingEventId ? '編輯事件' : '新增事件'}</div>
            <label className={styles.modalLabel}>
              事件標題
              <input
                type="text"
                value={newEventTitle}
                onChange={(e) => setNewEventTitle(e.target.value)}
                className={styles.modalInput}
                placeholder="輸入標題"
                autoFocus
              />
            </label>
            <label className={styles.modalLabel}>
              開始日期
              <input
                type="date"
                value={newEventDate}
                onChange={(e) => setNewEventDate(e.target.value)}
                className={styles.modalInput}
              />
            </label>
            <label className={styles.modalLabel}>
              結束日期
              <input
                type="date"
                value={newEventEndDate}
                onChange={(e) => setNewEventEndDate(e.target.value)}
                className={styles.modalInput}
                min={newEventDate}
              />
            </label>
            <div className={styles.modalLabel}>
              頻率
              <div className={styles.modalFrequencyRow}>
                {FREQUENCY_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={newEventFrequency === opt.id ? styles.modalTagChipActive : styles.modalTagChip}
                    onClick={() => setNewEventFrequency(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.modalLabel}>
              標籤
              <div className={styles.modalTagChips}>
                {customTags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={newEventTags.includes(t.name) ? styles.modalTagChipActive : styles.modalTagChip}
                    onClick={() => toggleNewEventTag(t.name)}
                    style={newEventTags.includes(t.name) ? { borderColor: t.color, color: t.color } : {}}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={newEventTagsRaw}
                onChange={(e) => setNewEventTagsRaw(e.target.value)}
                className={styles.modalInput}
                placeholder="或輸入標籤，以空格分隔"
                style={{ marginTop: '0.5rem' }}
              />
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.modalBtnCancel} onClick={closeAddEvent}>取消</button>
              <button type="button" className={styles.modalBtnSubmit} onClick={submitEventForm}>{editingEventId ? '儲存' : '新增'}</button>
            </div>
          </div>
        </div>
      )}

      <main className={styles.main}>
        <header className={styles.header}>
          <div className={styles.rangeRow}>
            <button type="button" className={styles.navBtn} onClick={() => nav(-1)} aria-label="上一個">
              ‹
            </button>
            <h1 className={styles.rangeTitle}>{rangeText}</h1>
            <button type="button" className={styles.navBtn} onClick={() => nav(1)} aria-label="下一個">
              ›
            </button>
          </div>
          <div className={styles.viewButtons}>
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={viewId === v.id ? styles.viewBtnActive : styles.viewBtn}
                onClick={() => handleViewChange(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </header>

        <div className={`${styles.gridWrap} ${transitioning ? styles.transitioning : ''}`} data-view={viewId}>
          {viewId === 'month' && (
            <div className={styles.weekdayRow}>
              {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
                <div key={w} className={styles.weekdayCell}>{w}</div>
              ))}
            </div>
          )}
          <div className={styles.grid}>
            {cells.map((cell, i) => (
              <Cell
                key={cell.date ? dateToKey(cell.date) + cell.type : i}
                cell={cell}
                viewId={viewId}
                events={filteredEvents}
                eventInCell={viewId === 'month' ? eventInCell : eventInMonthBlock}
                getTagColor={(name) => getTagColor(name, customTags)}
                onEditEvent={openEditEvent}
              />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

function Cell({ cell, viewId, events, eventInCell, getTagColor, onEditEvent }) {
  const cellEvents = events.filter((e) => eventInCell(e, cell));
  const isToday = cell.date && dateToKey(cell.date) === dateToKey(new Date());
  const tagColor = (tagName) => (getTagColor ? getTagColor(tagName) : '#6b7280');

  if (cell.type === 'pad') {
    return <div className={styles.cellPad} />;
  }

  if (viewId === 'month') {
    return (
      <div className={`${styles.cell} ${isToday ? styles.cellToday : ''}`}>
        <span className={styles.cellDay}>{cell.label}</span>
        <ul className={styles.eventList}>
          {cellEvents.map((e) => (
            <li
              key={e.id}
              className={styles.eventItem}
              title={e.title}
              role="button"
              tabIndex={0}
              onClick={() => onEditEvent && onEditEvent(e)}
              onKeyDown={(ev) => ev.key === 'Enter' && onEditEvent && onEditEvent(e)}
            >
              {(e.tags && e.tags[0]) ? (
                <span className={styles.eventTag} style={{ backgroundColor: tagColor(e.tags[0]) }} />
              ) : null}
              {e.title}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const formatEventDateRange = (e) => {
    const start = getEventStart(e);
    const end = getEventEnd(e);
    if (start === end) return start.slice(5, 7) + '/' + start.slice(8, 10);
    return `${start.slice(5, 7)}/${start.slice(8, 10)}-${end.slice(5, 7)}/${end.slice(8, 10)}`;
  };

  return (
    <div className={styles.monthBlock}>
      <div className={styles.monthBlockLabel}>{cell.label}</div>
      <ul className={styles.eventList}>
        {cellEvents.map((e) => (
          <li
            key={e.id}
            className={styles.eventItem}
            role="button"
            tabIndex={0}
            onClick={() => onEditEvent && onEditEvent(e)}
            onKeyDown={(ev) => ev.key === 'Enter' && onEditEvent && onEditEvent(e)}
          >
            {(e.tags && e.tags[0]) ? (
              <span className={styles.eventTag} style={{ backgroundColor: tagColor(e.tags[0]) }} />
            ) : null}
            <span className={styles.eventDate}>{formatEventDateRange(e)}</span> {e.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
