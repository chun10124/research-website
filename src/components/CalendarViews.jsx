import React, { useContext } from 'react';
import { addMonths, addDays, endOfMonth, format, isWithinInterval } from 'date-fns';
import zhTW from 'date-fns/locale/zh-TW';
import { TagsContext } from './CalendarContext';

const DEFAULT_COLORS = { CORE: '#5C6BC0', EARNINGS: '#26A69A', INDUSTRY: '#66BB6A' };

function createMultiMonthView(monthCount) {
  const View = (props) => {
    const { typeColors = DEFAULT_COLORS } = useContext(TagsContext) || {};
    const {
      date,
      events,
      localizer,
      accessors,
      onSelectEvent,
      onSelectSlot,
      selectable,
      getters,
    } = props;
    const months = [];
    for (let i = 0; i < monthCount; i++) {
      months.push(addMonths(new Date(date.getFullYear(), Math.floor(date.getMonth() / monthCount) * monthCount, 1), i));
    }

    const cardStyle = {
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 180,
      background: '#fff',
      position: 'relative',
    };
    const monthLabelStyle = {
      position: 'absolute',
      top: 6,
      right: 8,
      fontSize: 11,
      fontWeight: 600,
      color: '#64748b',
    };
    const cellStyle = {
      flex: 1,
      padding: 10,
      paddingTop: 26,
      cursor: selectable ? 'pointer' : 'default',
    };
    const eventRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 6px',
      marginBottom: 1,
      borderRadius: 6,
      fontSize: 12,
      lineHeight: 1.35,
      color: '#1e293b',
      cursor: 'pointer',
      transition: 'background 0.12s ease',
    };

    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(monthCount, 3)}, 1fr)`,
          gap: 16,
          padding: '12px 16px 16px 16px',
          height: '100%',
          overflow: 'auto',
          background: '#f8fafc',
        }}
      >
        {months.map((monthStart) => {
          const monthEnd = endOfMonth(monthStart);
          const monthEvents = events.filter((e) => {
            const start = accessors.start(e);
            const end = accessors.end(e);
            const lastInclusive = addDays(end, -1);
            const eventEndDay = new Date(lastInclusive.getFullYear(), lastInclusive.getMonth(), lastInclusive.getDate());
            const eventStartDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
            return eventStartDay <= monthEnd && eventEndDay >= monthStart;
          });

          const monthLabel = `${monthStart.getMonth() + 1}M${String(monthStart.getFullYear()).slice(-2)}`;
          return (
            <div key={monthStart.getTime()} style={cardStyle}>
              <span style={monthLabelStyle}>{monthLabel}</span>
              <div
                style={cellStyle}
                onClick={(e) => {
                  if (!selectable || e.target.closest('.calendar-list-event')) return;
                  onSelectSlot?.({
                    start: monthStart,
                    end: monthEnd,
                    action: 'click',
                  });
                }}
              >
                {monthEvents.length > 0 && monthEvents.map((event) => {
                  const firstTag = event.tags?.[0] || event.resource;
                  const color = typeColors[firstTag] || '#1e3a8a';
                  const start = accessors.start(event);
                  const end = accessors.end(event);
                  const lastDay = addDays(end, -1);
                  const dateStr = format(start, 'yyyy-MM-dd') === format(lastDay, 'yyyy-MM-dd')
                    ? format(start, 'M/d', { locale: zhTW })
                    : `${format(start, 'M/d', { locale: zhTW })}–${format(lastDay, 'M/d', { locale: zhTW })}`;
                  return (
                    <div
                      key={accessors.id?.(event) ?? event.id}
                      className="calendar-list-event"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectEvent?.(event);
                      }}
                      style={{
                        ...eventRowStyle,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(0,0,0,0.04)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 2,
                          background: color,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ flexShrink: 0, color: '#1e293b', fontSize: 11 }}>{dateStr}</span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={event.title}
                      >
                        {event.title}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  View.range = (date, { localizer }) => {
    const base = new Date(date.getFullYear(), Math.floor(date.getMonth() / monthCount) * monthCount, 1);
    return {
      start: base,
      end: addMonths(endOfMonth(addMonths(base, monthCount - 1)), 1),
    };
  };

  View.navigate = (date, action, { localizer }) => {
    switch (action) {
      case 'PREV':
        return addMonths(date, -monthCount);
      case 'NEXT':
        return addMonths(date, monthCount);
      default:
        return date;
    }
  };

  View.title = (date, { localizer }) => {
    const base = new Date(date.getFullYear(), Math.floor(date.getMonth() / monthCount) * monthCount, 1);
    const y = String(base.getFullYear()).slice(-2);
    if (monthCount === 12) return format(base, 'yyyy年', { locale: zhTW });
    if (monthCount === 6) return `${Math.floor(base.getMonth() / 6) + 1}H${y}`;
    if (monthCount === 3) return `${Math.floor(base.getMonth() / 3) + 1}Q${y}`;
    const end = addMonths(base, monthCount - 1);
    return `${format(base, 'yyyy年M月', { locale: zhTW })} - ${format(end, 'M月', { locale: zhTW })}`;
  };

  return View;
}

export const QuarterView = createMultiMonthView(3);
export const HalfYearView = createMultiMonthView(6);
export const YearView = createMultiMonthView(12);
