import React, { useState, useEffect, useMemo } from 'react';
import { setDoc, onSnapshot } from 'firebase/firestore';
import { WHITEBOARD_DOC_REF } from '../utils/firebaseConfig';
import styles from './Whiteboard.module.css';

// 便利貼顏色選項（與主頁面一致）
const NOTE_COLORS = [
  '#FFE5B4', // 淺黃色
  '#E1F5FE', // 淺藍色
  '#F3E5F5', // 淺紫色
  '#E8F5E9', // 淺綠色
  '#FFF3E0', // 淺橙色
  '#FCE4EC', // 淺粉色
];

function CompletedNotesComponent() {
  const [notes, setNotes] = useState([]);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [timeFilter, setTimeFilter] = useState('ALL');
  const [expandedNoteId, setExpandedNoteId] = useState(null); // 展開的便利貼ID

  // 從 Firebase 載入資料
  useEffect(() => {
    const unsubscribe = onSnapshot(WHITEBOARD_DOC_REF, (docSnapshot) => {
      if (docSnapshot.exists()) {
        const cloudData = docSnapshot.data();
        const notesData = cloudData.notes || [];
        setNotes(notesData.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
      } else {
        setNotes([]);
      }
    }, (error) => {
      console.error('Firestore 監聽失敗:', error);
    });

    return () => unsubscribe();
  }, []);

  // 取得所有標籤
  const allTags = useMemo(() => {
    const tagSet = new Set();
    notes.forEach(note => {
      if (note.tags && note.completed) {
        note.tags.split(/[\s,]+/).forEach(tag => {
          const trimmedTag = tag.trim();
          if (trimmedTag) tagSet.add(trimmedTag);
        });
      }
    });
    return Array.from(tagSet).sort();
  }, [notes]);

  // 取得已完成的便利貼（按完成時間排序）
  const completedNotes = useMemo(() => {
    return notes.filter(note => note.completed);
  }, [notes]);

  // 過濾已完成的便利貼
  const filteredNotes = useMemo(() => {
    let filtered = [...completedNotes];

    // 關鍵字搜尋
    if (searchKeyword.trim()) {
      const keyword = searchKeyword.trim().toLowerCase();
      filtered = filtered.filter(note =>
        note.content.toLowerCase().includes(keyword) ||
        (note.tags && note.tags.toLowerCase().includes(keyword))
      );
    }

    // 標籤篩選
    if (selectedTag) {
      filtered = filtered.filter(note =>
        note.tags && note.tags.split(/[\s,]+/).some(tag => tag.trim() === selectedTag)
      );
    }

    // 時間篩選
    if (timeFilter !== 'ALL') {
      const now = Date.now();
      let startTime = 0;
      switch (timeFilter) {
        case 'TODAY':
          startTime = new Date().setHours(0, 0, 0, 0);
          break;
        case 'WEEK':
          startTime = now - 7 * 24 * 60 * 60 * 1000;
          break;
        case 'MONTH':
          startTime = now - 30 * 24 * 60 * 60 * 1000;
          break;
        case 'QUARTER':
          startTime = now - 90 * 24 * 60 * 60 * 1000;
          break;
        case 'YEAR':
          startTime = now - 365 * 24 * 60 * 60 * 1000;
          break;
        default:
          break;
      }
      filtered = filtered.filter(note => (note.completedAt || 0) >= startTime);
    }

    return filtered.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  }, [completedNotes, searchKeyword, selectedTag, timeFilter]);

  // 保存到 Firebase
  const saveNotesToCloud = async (notesToSave) => {
    try {
      const sorted = notesToSave.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setNotes(sorted);
      await setDoc(WHITEBOARD_DOC_REF, { notes: notesToSave });
      console.log('白板資料已成功寫入 Firestore。');
    } catch (error) {
      console.error('寫入 Firestore 失敗:', error);
      alert('警告：資料寫入雲端失敗，請檢查網路連線。');
    }
  };

  // 刪除便利貼
  const handleDelete = (id) => {
    if (window.confirm('確定要刪除這張便利貼嗎？')) {
      const updatedNotes = notes.filter(note => note.id !== id);
      saveNotesToCloud(updatedNotes);
    }
  };

  // 格式化時間
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const dateStr = date.toLocaleDateString('zh-TW', { 
      year: 'numeric',
      month: '2-digit', 
      day: '2-digit' 
    });
    const timeStr = date.toLocaleTimeString('zh-TW', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false
    });
    return `${dateStr} ${timeStr}`;
  };

  // 高亮關鍵字
  const highlightKeyword = (text, keyword) => {
    if (!keyword || !keyword.trim()) return text;
    
    const keywordLower = keyword.trim().toLowerCase();
    const textLower = text.toLowerCase();
    const parts = [];
    let lastIndex = 0;
    let index = textLower.indexOf(keywordLower, lastIndex);
    let keyCounter = 0;
    
    while (index !== -1) {
      if (index > lastIndex) {
        parts.push(text.substring(lastIndex, index));
      }
      parts.push(
        <span 
          key={`highlight-${keyCounter++}`} 
          className={styles.highlight}
          style={{
            backgroundColor: '#ffd700',
            color: '#000',
            padding: '2px 4px',
            borderRadius: '3px',
            fontWeight: '700',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
            border: '1px solid rgba(0, 0, 0, 0.2)',
            display: 'inline-block',
            position: 'relative',
            zIndex: 10
          }}
        >
          {text.substring(index, index + keyword.length)}
        </span>
      );
      lastIndex = index + keyword.length;
      index = textLower.indexOf(keywordLower, lastIndex);
    }
    
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }
    
    return parts.length > 0 ? parts : text;
  };

  return (
    <div className={styles.whiteboardContainer}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>已完成的便利貼</h2>
        <button
          onClick={() => {
            window.location.href = '/research-website/whiteboard';
          }}
          className={styles.backBtn}
        >
          ← 返回
        </button>
      </div>

      <div className={styles.mainLayout}>
        {/* 左側欄 */}
        <div className={styles.leftSidebar}>
          {/* 標籤列表 */}
          <div className={styles.tagsSection}>
            <h3 className={styles.sectionTitle}>標籤</h3>
            <div className={styles.tagsList}>
              <button
                className={`${styles.tagButton} ${selectedTag === '' ? styles.tagButtonActive : ''}`}
                onClick={() => setSelectedTag('')}
              >
                全部
              </button>
              {allTags.map(tag => (
                <button
                  key={tag}
                  className={`${styles.tagButton} ${selectedTag === tag ? styles.tagButtonActive : ''}`}
                  onClick={() => setSelectedTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {/* 篩選和搜尋區域 */}
          <div className={styles.filterSection}>
            <h3 className={styles.sectionTitle}>篩選</h3>
            <input
              type="text"
              placeholder="關鍵字搜尋..."
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              className={styles.searchInput}
            />
            <select
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value)}
              className={styles.timeSelect}
            >
              <option value="ALL">全部時間</option>
              <option value="TODAY">今天</option>
              <option value="WEEK">近一週</option>
              <option value="MONTH">近一月</option>
              <option value="QUARTER">近一季</option>
              <option value="YEAR">近一年</option>
            </select>
            <div className={styles.filterInfo}>
              顯示 {filteredNotes.length} / {completedNotes.length} 張
            </div>
          </div>
        </div>

        {/* 背景遮罩 */}
        {expandedNoteId && (
          <div 
            className={styles.overlay}
            onClick={() => setExpandedNoteId(null)}
          />
        )}

        {/* 右側便利貼網格 */}
        <div className={styles.rightContent}>
          <div className={styles.notesGrid}>
            {filteredNotes.length === 0 ? (
              <div className={styles.emptyState}>
                {completedNotes.length === 0 ? '還沒有已完成的便利貼' : '沒有匹配的便利貼'}
              </div>
            ) : (
              filteredNotes.map(note => (
                <div
                  key={note.id}
                  className={`${styles.note} ${styles.completedNote} ${expandedNoteId === note.id ? styles.noteExpanded : ''}`}
                  style={{ backgroundColor: note.color || NOTE_COLORS[0] }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedNoteId(expandedNoteId === note.id ? null : note.id);
                  }}
                >
                  <div className={styles.noteHeader}>
                    <span className={styles.noteTime}>
                      完成於：{formatTime(note.completedAt)}
                    </span>
                    <div className={styles.noteActions}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(note.id);
                        }}
                        className={styles.deleteBtn}
                        title="刪除"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className={styles.noteContent}>
                    {highlightKeyword(note.content, searchKeyword)}
                  </div>
                  {note.tags && (
                    <div className={styles.noteTags}>
                      {note.tags.split(/\s+/).filter(t => t).map((tag, idx) => {
                        const tagHighlighted = highlightKeyword(tag, searchKeyword);
                        return (
                          <span key={idx} className={styles.tag}>
                            {tagHighlighted}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CompletedNotesComponent;
