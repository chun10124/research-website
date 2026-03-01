import React, { useState, useMemo, createContext, useContext, useEffect, useRef } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay, differenceInDays, isSameDay, startOfDay, addDays } from 'date-fns';
import zhTW from 'date-fns/locale/zh-TW';
import { setDoc, onSnapshot } from 'firebase/firestore';
import { CALENDAR_DOC_REF } from '../utils/firebaseConfig';
import { searchUpcomingEvents, hasEventSearchApiKey } from '../utils/eventSearchApi';
import { TagsContext, INITIAL_TAGS } from './CalendarContext';
import { QuarterView, HalfYearView } from './CalendarViews';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import styles from './InvestorCalendar.module.css';

const baseLocalizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales: { 'zh-TW': zhTW },
});

const localizer = {
  ...baseLocalizer,
  visibleDays(date, localizer) {
    const first = baseLocalizer.firstVisibleDay(date, localizer);
    return Array.from({ length: 35 }, (_, i) => addDays(first, i));
  },
};

const INITIAL_EVENTS = [];

const PRESET_COLORS = ['#5C6BC0', '#26A69A', '#66BB6A', '#42A5F5', '#AB47BC', '#EC407A', '#FFA726', '#8D6E63'];


function EventComponent({ event, title, continuesPrior, continuesAfter }) {
  const { typeColors } = useContext(TagsContext);
  const isSingleDay = !continuesPrior && !continuesAfter;
  const firstTag = event.tags?.[0] || event.resource;
  const color = typeColors[firstTag] || '#1e3a8a';
  const blockStyle = {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 11,
  };
  if (isSingleDay) {
    return (
      <span style={blockStyle} title={title}>
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: color,
            verticalAlign: 'middle',
            marginRight: 4,
            flexShrink: 0,
          }}
        />
        {title}
      </span>
    );
  }
  return <span style={blockStyle} title={title}>{title}</span>;
}

function eventStyleGetter(typeColors) {
  return (event, start, end) => {
    const firstTag = event.tags?.[0] || event.resource;
    const color = typeColors[firstTag] || '#1e3a8a';
    const isSingleDay = start && end && (isSameDay(start, end) || differenceInDays(end, start) <= 1);
    return {
      style: {
        backgroundColor: isSingleDay ? 'transparent' : color,
        color: isSingleDay ? 'inherit' : '#fff',
        borderRadius: '3px',
        opacity: isSingleDay ? 0.95 : 0.65,
        fontSize: 11,
        padding: '1px 5px',
        lineHeight: 1.3,
        minHeight: 18,
        border: 'none',
      },
    };
  };
}

const LS_KEY = 'pplx_api_key';
const getStoredKey = () => (typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) || '' : '');

export default function InvestorCalendar() {
  const [perplexityApiKey, setPerplexityApiKey] = useState(getStoredKey);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [tags, setTags] = useState(INITIAL_TAGS);
  const [editingTag, setEditingTag] = useState(null);
  const [tagForm, setTagForm] = useState({ label: '', color: '#26A69A' });
  const typeColors = useMemo(
    () => Object.fromEntries(tags.map((t) => [t.value, t.color])),
    [tags]
  );
  const [events, setEvents] = useState(INITIAL_EVENTS);
  const [selectedTags, setSelectedTags] = useState(
    () => Object.fromEntries(INITIAL_TAGS.map((o) => [o.value, true]))
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [form, setForm] = useState({
    title: '',
    start: null,
    end: null,
    tagsStr: '',
  });
  const [calendarReady, setCalendarReady] = useState(false);
  const isFromSnapshotRef = useRef(false);
  const [eventSearchOpen, setEventSearchOpen] = useState(false);
  const [eventSearchKeyword, setEventSearchKeyword] = useState('');
  const [eventSearchResults, setEventSearchResults] = useState([]);
  const [eventSearchSelected, setEventSearchSelected] = useState(new Set());
  const [eventSearchLoading, setEventSearchLoading] = useState(false);
  const [eventSearchError, setEventSearchError] = useState(null);
  const [eventSearchSource, setEventSearchSource] = useState(null);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      CALENDAR_DOC_REF,
      (snap) => {
        setCalendarReady(true);
        if (!snap.exists()) return;
        const d = snap.data();
        const rawEvents = d.events || [];
        const parsedEvents = rawEvents.map((e) => ({
          ...e,
          start: e.start ? new Date(e.start) : new Date(),
          end: e.end ? new Date(e.end) : new Date(),
        }));
        isFromSnapshotRef.current = true;
        setEvents(parsedEvents);
        if (Array.isArray(d.tags)) setTags(d.tags.map((t) => ({ value: t.value, label: t.label, color: t.color })));
        if (d.selectedTags && typeof d.selectedTags === 'object') setSelectedTags(d.selectedTags);
      },
      (err) => console.error('日曆 Firestore 監聽失敗:', err)
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!calendarReady) return;
    if (isFromSnapshotRef.current) {
      isFromSnapshotRef.current = false;
      return;
    }
    const stripUndefined = (obj) => {
      if (obj === null || obj === undefined) return null;
      if (Array.isArray(obj)) return obj.map(stripUndefined).filter((v) => v !== undefined);
      if (typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) continue;
          const next = stripUndefined(v);
          if (next !== undefined) out[k] = next;
        }
        return out;
      }
      return obj;
    };
    const payload = stripUndefined({
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start?.toISOString?.() ?? new Date(e.start).toISOString(),
        end: e.end?.toISOString?.() ?? new Date(e.end).toISOString(),
        allDay: e.allDay,
        tags: e.tags,
        resource: e.resource,
        createdOrder: e.createdOrder,
      })),
      tags: tags.map((t) => ({ value: t.value, label: t.label, color: t.color })),
      selectedTags,
    });
    setDoc(CALENDAR_DOC_REF, payload).catch((err) =>
      console.error('日曆寫入 Firestore 失敗:', err)
    );
  }, [calendarReady, events, tags, selectedTags]);

  const openAdd = (slot) => {
    setEditingEvent(null);
    const start = startOfDay(new Date(slot.start));
    const slotEnd = new Date(slot.end);
    const daysSpan = differenceInDays(slotEnd, slot.start);
    const end = daysSpan > 1 ? addDays(startOfDay(slotEnd), 1) : addDays(start, 1);
    setForm({
      title: '',
      start,
      end,
      tagsStr: '',
    });
    setModalOpen(true);
  };

  const parseTags = (s) => {
    const labelToValue = Object.fromEntries(tags.map((t) => [t.label, t.value]));
    return (s || '')
      .trim()
      .split(/\s+/)
      .map((t) => {
        const trimmed = t.trim();
        return labelToValue[trimmed] || trimmed.toUpperCase();
      })
      .filter(Boolean);
  };

  const openEdit = (event) => {
    setEditingEvent(event);
    const tags = event.tags || (event.resource ? [event.resource] : []);
    const start = startOfDay(new Date(event.start));
    const rawEnd = event.end ? new Date(event.end) : addDays(start, 1);
    let end = startOfDay(rawEnd);
    if (end <= start) {
      end = addDays(start, 1);
    } else if (!event.allDay) {
      end = addDays(end, 1);
    }
    setForm({
      title: event.title,
      start,
      end,
      tagsStr: tags.join(' '),
    });
    setModalOpen(true);
  };

  const handleSave = () => {
    if (!form.title.trim()) return;
    const tagList = parseTags(form.tagsStr);
    const payload = {
      id: editingEvent?.id ?? Date.now(),
      title: form.title.trim(),
      start: form.start,
      end: form.end,
      allDay: true,
      tags: tagList,
      resource: tagList[0],
      createdOrder: editingEvent?.createdOrder ?? Date.now(),
    };
    const existingValues = new Set(tags.map((t) => t.value));
    const newTagValues = tagList.filter((v) => !existingValues.has(v));
    if (newTagValues.length) {
      const colorIndex = tags.length % PRESET_COLORS.length;
      setTags((prev) => [
        ...prev,
        ...newTagValues.map((v, i) => ({
          value: v,
          label: v,
          color: PRESET_COLORS[(colorIndex + i) % PRESET_COLORS.length],
        })),
      ]);
      setSelectedTags((prev) => ({
        ...prev,
        ...Object.fromEntries(newTagValues.map((v) => [v, true])),
      }));
    }
    if (editingEvent) {
      setEvents((prev) => prev.map((e) => (e.id === editingEvent.id ? payload : e)));
    } else {
      setEvents((prev) => [...prev, payload]);
    }
    setModalOpen(false);
  };

  const handleDelete = () => {
    if (!editingEvent) return;
    const ok = window.confirm(`確定要刪除事件「${editingEvent.title}」嗎？`);
    if (!ok) return;
    setEvents((prev) => prev.filter((e) => e.id !== editingEvent.id));
    setModalOpen(false);
  };

  const filteredEvents = events
    .filter((e) => {
      const evTags = e.tags || (e.resource ? [e.resource] : []);
      if (evTags.length === 0) return true;
      return evTags.some((t) => selectedTags[t] !== false);
    })
    .sort((a, b) => {
      const aIsSpan = differenceInDays(a.end, a.start) > 1;
      const bIsSpan = differenceInDays(b.end, b.start) > 1;
      if (aIsSpan !== bIsSpan) return aIsSpan ? -1 : 1;
      const startDiff = a.start - b.start;
      if (startDiff !== 0) return startDiff;
      return (a.createdOrder ?? a.id ?? 0) - (b.createdOrder ?? b.id ?? 0);
    });

  const toggleTag = (value) => {
    setSelectedTags((prev) => ({ ...prev, [value]: !prev[value] }));
  };

  const openTagEdit = (tag) => {
    setEditingTag(tag);
    setTagForm({ label: tag.label, color: tag.color });
  };

  const saveTagEdit = () => {
    if (!editingTag || !tagForm.label.trim()) return;
    setTags((prev) =>
      prev.map((t) =>
        t.value === editingTag.value ? { ...t, label: tagForm.label.trim(), color: tagForm.color } : t
      )
    );
    setEditingTag(null);
  };

  const runEventSearch = async () => {
    const q = eventSearchKeyword.trim();
    if (!q) return;
    setEventSearchLoading(true);
    setEventSearchResults([]);
    setEventSearchSelected(new Set());
    setEventSearchError(null);
    try {
      const { events, error, source } = await searchUpcomingEvents(q, perplexityApiKey);
      setEventSearchResults(events || []);
      setEventSearchError(error || null);
      setEventSearchSource(source || null);
    } finally {
      setEventSearchLoading(false);
    }
  };

  const toggleSearchResult = (id) => {
    setEventSearchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addSearchResultsToCalendar = () => {
    const toAdd = eventSearchResults.filter((e) => eventSearchSelected.has(e.id));
    if (toAdd.length === 0) return;
    const baseId = Date.now();
    const newEvents = toAdd.map((ev, i) => ({
      id: baseId + i,
      title: ev.title,
      start: startOfDay(new Date(ev.start)),
      end: addDays(startOfDay(new Date(ev.start)), 1),
      allDay: true,
      tags: [],
      resource: undefined,
      createdOrder: baseId + i,
    }));
    setEvents((prev) => [...prev, ...newEvents]);
    setEventSearchSelected(new Set());
    setEventSearchOpen(false);
  };

  const handleDeleteTag = () => {
    if (!editingTag) return;
    const ok = window.confirm(`確定要刪除標籤「${editingTag.label}」嗎？`);
    if (!ok) return;
    const deletingValue = editingTag.value;
    const remainingTags = tags.filter((t) => t.value !== deletingValue);
    setTags(remainingTags);
    setSelectedTags((prev) => {
      const next = { ...prev };
      delete next[deletingValue];
      return next;
    });
    setEvents((prev) =>
      prev.map((e) => {
        const currentTags = e.tags || (e.resource ? [e.resource] : []);
        const nextTags = currentTags.filter((t) => t !== deletingValue);
        if (nextTags.length > 0) {
          return { ...e, tags: nextTags, resource: nextTags[0] };
        }
        return { ...e, tags: [], resource: undefined };
      })
    );
    setEditingTag(null);
  };

  const contextValue = useMemo(() => ({ tags, typeColors }), [tags, typeColors]);
  const [currentView, setCurrentView] = useState('month');

  return (
    <TagsContext.Provider value={contextValue}>
    <div className={styles.root} data-view={currentView}>
      <aside className={styles.sidebar}>
        <button
          type="button"
          className={styles.eventSearchBtn}
          onClick={() => setEventSearchOpen(true)}
        >
          搜尋重大事件
        </button>
        <div className={styles.sidebarTitle}>顯示標籤</div>
        {tags.map((o) => (
          <div key={o.value} className={styles.tagRow}>
            <label className={styles.tagLabel}>
              <input
                type="checkbox"
                checked={selectedTags[o.value] !== false}
                onChange={() => toggleTag(o.value)}
              />
              <span className={styles.tagDot} style={{ background: o.color }} />
              {o.label}
            </label>
            <button
              type="button"
              className={styles.tagEditBtn}
              onClick={() => openTagEdit(o)}
              title="編輯標籤"
            >
              編輯
            </button>
          </div>
        ))}
      </aside>
      <div className={styles.calendarWrap}>
        <Calendar
          localizer={localizer}
          events={filteredEvents}
        startAccessor="start"
        endAccessor="end"
        defaultView="month"
        views={{
          month: true,
          quarter: QuarterView,
          halfYear: HalfYearView,
        }}
        messages={{
          today: '今天',
          previous: '<',
          next: '>',
          month: '月',
          week: '週',
          day: '日',
          quarter: '季',
          halfYear: '半年',
        }}
        formats={{
          monthHeaderFormat: 'yyyy 年 M 月',
        }}
        defaultDate={new Date(2026, 3, 1)}
        eventPropGetter={eventStyleGetter(typeColors)}
        components={{ event: EventComponent }}
        culture="zh-TW"
        selectable
        onSelectSlot={openAdd}
        onSelectEvent={openEdit}
        onView={setCurrentView}
        view={currentView}
        />
      </div>
      {modalOpen && (
        <div className={styles.overlay} onClick={() => setModalOpen(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>
              {editingEvent ? '編輯事件' : '新增事件'}
            </h3>
            <div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>標題</label>
                <input
                  className={`${styles.input} ${styles.modalInput}`}
                  autoFocus
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="輸入事件標題"
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>輸入標籤（空格分隔）</label>
                <input
                  className={`${styles.input} ${styles.modalInput}`}
                  value={form.tagsStr}
                  onChange={(e) => setForm((f) => ({ ...f, tagsStr: e.target.value }))}
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>開始日期</label>
                <input
                  type="date"
                  className={styles.input}
                  value={format(form.start, 'yyyy-MM-dd')}
                  onChange={(e) => {
                    const d = new Date(e.target.value);
                    d.setHours(0, 0, 0, 0);
                    const prevEnd = form.end;
                    setForm((f) => ({
                      ...f,
                      start: d,
                      end: d < prevEnd ? prevEnd : addDays(d, 1),
                    }));
                  }}
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>結束日期</label>
                <input
                  type="date"
                  className={styles.input}
                  value={format(addDays(form.end, -1), 'yyyy-MM-dd')}
                  onChange={(e) => {
                    const lastDay = new Date(e.target.value);
                    lastDay.setHours(0, 0, 0, 0);
                    const endExclusive = addDays(lastDay, 1);
                    setForm((f) => ({
                      ...f,
                      end: endExclusive <= f.start ? addDays(f.start, 1) : endExclusive,
                    }));
                  }}
                />
              </div>
            </div>
            <div className={styles.modalActions}>
              {editingEvent && (
                <button type="button" onClick={handleDelete} className={`${styles.btn} ${styles.btnDanger}`}>
                  刪除
                </button>
              )}
              <button type="button" onClick={() => setModalOpen(false)} className={`${styles.btn} ${styles.btnSecondary}`}>
                取消
              </button>
              <button type="button" onClick={handleSave} className={`${styles.btn} ${styles.btnPrimary}`}>
                儲存
              </button>
            </div>
          </div>
        </div>
      )}
      {eventSearchOpen && (
        <div className={styles.overlay} onClick={() => setEventSearchOpen(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>搜尋重大事件</h3>

            {/* API Key 區塊 */}
            {hasEventSearchApiKey(perplexityApiKey) ? (
              <div className={styles.apiKeyRow}>
                <span className={styles.apiKeySet}>✓ Perplexity API Key 已設定</span>
                <button type="button" className={styles.apiKeyChangeBtn}
                  onClick={() => { setApiKeyInput(''); setShowApiKeyInput(true); }}>更換</button>
              </div>
            ) : (
              <div className={styles.apiKeyRow}>
                <span className={styles.apiKeyUnset}>尚未設定 API Key（將使用示範資料）</span>
                <button type="button" className={styles.apiKeyChangeBtn}
                  onClick={() => { setApiKeyInput(''); setShowApiKeyInput(true); }}>設定</button>
              </div>
            )}
            {showApiKeyInput && (
              <div className={styles.formGroup} style={{ display: 'flex', gap: 8 }}>
                <input className={styles.input} type="password" value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="貼上 Perplexity API Key（pplx-…）" style={{ flex: 1 }} />
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={() => {
                    const k = apiKeyInput.trim();
                    if (k) { localStorage.setItem(LS_KEY, k); setPerplexityApiKey(k); }
                    setShowApiKeyInput(false); setApiKeyInput('');
                  }}>儲存</button>
                <button type="button" className={`${styles.btn} ${styles.btnSecondary}`}
                  onClick={() => { setShowApiKeyInput(false); setApiKeyInput(''); }}>取消</button>
              </div>
            )}

            <div className={styles.formGroup}>
              <input
                className={`${styles.input} ${styles.modalInput}`}
                value={eventSearchKeyword}
                onChange={(e) => setEventSearchKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runEventSearch()}
                placeholder="輸入關鍵字，例如：台積電、NVIDIA、半導體"
              />
            </div>
            {eventSearchError && (
              <div className={styles.searchError}>{eventSearchError}</div>
            )}
            <div className={styles.modalActions} style={{ marginTop: 12, paddingTop: 12 }}>
              <button
                type="button"
                onClick={runEventSearch}
                disabled={eventSearchLoading || !eventSearchKeyword.trim()}
                className={`${styles.btn} ${styles.btnPrimary}`}
              >
                {eventSearchLoading ? '搜尋中…' : '搜尋'}
              </button>
            </div>
            {eventSearchResults.length > 0 && (
              <>
                {eventSearchSource === 'mock' && (
                  <p className={styles.searchHint}>目前為示範資料，點「設定」輸入 Perplexity API Key 後可查詢真實事件。</p>
                )}
                <div className={styles.searchResultList}>
                  {eventSearchResults.map((ev) => (
                    <label key={ev.id} className={styles.searchResultRow}>
                      <input
                        type="checkbox"
                        checked={eventSearchSelected.has(ev.id)}
                        onChange={() => toggleSearchResult(ev.id)}
                      />
                      <span className={styles.searchResultTitle}>{ev.title}</span>
                      <span className={styles.searchResultDate}>
                        {format(new Date(ev.start), 'yyyy/M/d')}
                      </span>
                    </label>
                  ))}
                </div>
                <div className={styles.modalActions}>
                  <button
                    type="button"
                    onClick={addSearchResultsToCalendar}
                    disabled={eventSearchSelected.size === 0}
                    className={`${styles.btn} ${styles.btnPrimary}`}
                  >
                    加入日曆（已選 {eventSearchSelected.size} 項）
                  </button>
                  <button
                    type="button"
                    onClick={() => setEventSearchOpen(false)}
                    className={`${styles.btn} ${styles.btnSecondary}`}
                  >
                    關閉
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {editingTag && (
        <div className={styles.overlay} onClick={() => setEditingTag(null)}>
          <div className={`${styles.modalSmall} ${styles.modal}`} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>編輯標籤</h3>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>名稱</label>
              <input
                className={styles.input}
                value={tagForm.label}
                onChange={(e) => setTagForm((f) => ({ ...f, label: e.target.value }))}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>顏色</label>
              <div className={styles.colorRow}>
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`${styles.colorSwatch} ${tagForm.color === c ? styles.colorSwatchActive : ''}`}
                    style={{ background: c }}
                    onClick={() => setTagForm((f) => ({ ...f, color: c }))}
                  />
                ))}
                <input
                  type="color"
                  className={styles.colorPicker}
                  value={tagForm.color}
                  onChange={(e) => setTagForm((f) => ({ ...f, color: e.target.value }))}
                />
              </div>
            </div>
            <div className={styles.modalActions}>
              <button type="button" onClick={handleDeleteTag} className={`${styles.btn} ${styles.btnDanger}`}>
                刪除
              </button>
              <button type="button" onClick={() => setEditingTag(null)} className={`${styles.btn} ${styles.btnSecondary}`}>
                取消
              </button>
              <button type="button" onClick={saveTagEdit} className={`${styles.btn} ${styles.btnPrimary}`}>
                儲存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </TagsContext.Provider>
  );
}
