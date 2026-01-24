import React, { useState, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { setDoc, onSnapshot } from 'firebase/firestore';
import { WHITEBOARD_DOC_REF } from '../utils/firebaseConfig';
import styles from './Whiteboard.module.css';

// 便利貼顏色
const NOTE_COLORS = [
  '#FFE5B4', // 淺黃色
  '#E1F5FE', // 淺藍色
  '#F3E5F5', // 淺紫色
  '#E8F5E9', // 淺綠色
  '#FFF3E0', // 淺橙色
  '#FCE4EC', // 淺粉色
];

function WhiteboardComponent() {
  const [notes, setNotes] = useState([]);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [timeFilter, setTimeFilter] = useState('ALL');
  const [expandedNoteId, setExpandedNoteId] = useState(null); // 展開的便利貼ID
  const [editingNote, setEditingNote] = useState(null); // 正在編輯的便利貼

  // 從 Firebase 載入資料
  useEffect(() => {
    const unsubscribe = onSnapshot(WHITEBOARD_DOC_REF, (docSnapshot) => {
      if (docSnapshot.exists()) {
        const cloudData = docSnapshot.data();
        const notesData = cloudData.notes || [];
        setNotes(notesData.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
        console.log('白板資料已從 Firestore 載入並即時同步。');
      } else {
        console.log('Firestore 文件不存在，從空白白板開始。');
        setNotes([]);
      }
    }, (error) => {
      console.error('Firestore 監聽失敗:', error);
    });

    return () => unsubscribe();
  }, []);

  // 儲存到 Firebase
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

  // 取得所有標籤
  const allTags = useMemo(() => {
    const tagSet = new Set();
    notes.forEach(note => {
      if (note.tags) {
        // 支援空白和逗號分隔（向後兼容）
        note.tags.split(/[\s,]+/).forEach(tag => {
          const trimmedTag = tag.trim();
          if (trimmedTag) tagSet.add(trimmedTag);
        });
      }
    });
    return Array.from(tagSet).sort();
  }, [notes]);

  // 過濾便利貼（排除已完成的）
  const filteredNotes = useMemo(() => {
    let filtered = notes.filter(note => !note.completed);

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
      filtered = filtered.filter(note => (note.createdAt || 0) >= startTime);
    }

    return filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [notes, searchKeyword, selectedTag, timeFilter]);

  // 新增便利貼
  const handleAddNote = () => {
    const newNote = {
      id: uuidv4(),
      content: '',
      tags: '',
      color: NOTE_COLORS[0],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setEditingNote(newNote);
    setExpandedNoteId(newNote.id);
  };

  // 保存編輯
  const handleSaveNote = () => {
    if (!editingNote.content.trim()) {
      alert('請輸入便利貼內容！');
      return;
    }

    const tagsStr = editingNote.tags.trim().split(/\s+/).filter(t => t).join(' ');
    const noteToSave = {
      ...editingNote,
      tags: tagsStr,
      updatedAt: Date.now(),
    };

    let updatedNotes;
    const existingNote = notes.find(n => n.id === editingNote.id);
    
    if (existingNote) {
      updatedNotes = notes.map(note =>
        note.id === editingNote.id ? noteToSave : note
      );
    } else {
      updatedNotes = [noteToSave, ...notes];
    }

    saveNotesToCloud(updatedNotes);
    
    // 清除编辑和展开状态
    setEditingNote(null);
    setExpandedNoteId(null);
  };

  // 取消編輯
  const handleCancelEdit = () => {
    // 清除编辑和展开状态
    setEditingNote(null);
    setExpandedNoteId(null);
  };

  // 刪除便利貼
  const handleDelete = (id) => {
    if (window.confirm('確定要刪除這張便利貼嗎？')) {
      const updatedNotes = notes.filter(note => note.id !== id);
      saveNotesToCloud(updatedNotes);
      
      // 如果删除的是正在编辑的便利贴，清除编辑状态
      if (editingNote && editingNote.id === id) {
        setEditingNote(null);
        setExpandedNoteId(null);
      }
    }
  };

  // 完成便利貼
  const handleComplete = (id) => {
    if (window.confirm('確定要標記為完成嗎？完成後將移至已完成頁面。')) {
      const updatedNotes = notes.map(note =>
        note.id === id ? { ...note, completed: true, completedAt: Date.now() } : note
      );
      saveNotesToCloud(updatedNotes);
    }
  };


  // 編輯便利貼
  const handleEdit = (note) => {
    setEditingNote({ ...note });
    setExpandedNoteId(note.id);
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
      // 添加關鍵字前的文本
      if (index > lastIndex) {
        parts.push(text.substring(lastIndex, index));
      }
      // 添加高亮的關鍵字（使用內聯樣式確保在所有背景色上都顯示）
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
    
    // 添加剩餘文本
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }
    
    return parts.length > 0 ? parts : text;
  };

  // 取得已完成的便利貼數量
  const completedCount = useMemo(() => {
    return notes.filter(note => note.completed).length;
  }, [notes]);

  return (
    <div className={styles.whiteboardContainer}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <h2>白板</h2>
        {completedCount > 0 && (
          <button
            onClick={() => {
              window.location.href = '/research-website/completed-notes';
            }}
            className={styles.completedBtn}
          >
            已完成 ({completedCount})
          </button>
        )}
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
              顯示 {filteredNotes.length} / {notes.length} 張
            </div>
          </div>
        </div>

        {/* 背景遮罩 */}
        {expandedNoteId && (
          <div 
            className={styles.overlay}
            onClick={() => {
              setExpandedNoteId(null);
              setEditingNote(null);
            }}
          />
        )}

        {/* 右側便利貼網格 */}
        <div className={styles.rightContent}>
          <div className={styles.notesGrid}>
          {filteredNotes.length === 0 ? (
          <div className={styles.emptyState}>
            {notes.length === 0 ? '還沒有便利貼，建立第一張吧！' : '沒有匹配的便利貼'}
          </div>
        ) : (
          <>
            {filteredNotes.map(note => (
              <div
                key={note.id}
                className={`${styles.note} ${expandedNoteId === note.id ? styles.noteExpanded : ''}`}
                style={{ backgroundColor: note.color || NOTE_COLORS[0] }}
                onClick={(e) => {
                  e.stopPropagation();
                  // 點擊便利貼就進入編輯模式
                  if (!editingNote || editingNote.id !== note.id) {
                    handleEdit(note);
                  }
                }}
              >
                {editingNote && editingNote.id === note.id ? (
                  /* 編輯模式 */
                  <div className={styles.editingForm} onClick={(e) => e.stopPropagation()}>
                    <div className={styles.noteHeader}>
                      <span className={styles.noteTime}>{formatTime(note.createdAt)}</span>
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
                    <textarea
                      value={editingNote.content}
                      onChange={(e) => setEditingNote({ ...editingNote, content: e.target.value })}
                      placeholder="輸入便利貼內容..."
                      className={styles.editTextarea}
                      autoFocus
                    />
                    <input
                      type="text"
                      value={editingNote.tags}
                      onChange={(e) => setEditingNote({ ...editingNote, tags: e.target.value })}
                      placeholder="標籤（空格分隔）"
                      className={styles.editTagsInput}
                    />
                    <div className={styles.editColorPicker}>
                      {NOTE_COLORS.map(color => (
                        <button
                          key={color}
                          type="button"
                          className={`${styles.colorOption} ${editingNote.color === color ? styles.colorSelected : ''}`}
                          style={{ backgroundColor: color }}
                          onClick={() => setEditingNote({ ...editingNote, color })}
                        />
                      ))}
                    </div>
                    <div className={styles.editActions}>
                      <button onClick={handleSaveNote} className={styles.saveBtn}>保存</button>
                      <button onClick={handleCancelEdit} className={styles.cancelBtn}>取消</button>
                    </div>
                  </div>
                ) : (
                  /* 顯示模式 */
                  <>
                    <div className={styles.noteHeader}>
                      <span className={styles.noteTime}>{formatTime(note.createdAt)}</span>
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
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleComplete(note.id);
                      }}
                      className={styles.completeBtn}
                      title="標記為完成"
                    >
                      ✓
                    </button>
                  </>
                )}
              </div>
            ))}
            {/* 新增中的便利貼 */}
            {editingNote && !notes.find(n => n.id === editingNote.id) && (
              <div
                className={`${styles.note} ${styles.noteExpanded}`}
                style={{ backgroundColor: editingNote.color }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className={styles.editingForm}>
                  <div className={styles.noteHeader}>
                    <span className={styles.noteTime}>新便利貼</span>
                  </div>
                  <textarea
                    value={editingNote.content}
                    onChange={(e) => setEditingNote({ ...editingNote, content: e.target.value })}
                    placeholder="輸入便利貼內容..."
                    className={styles.editTextarea}
                    autoFocus
                  />
                  <input
                    type="text"
                    value={editingNote.tags}
                    onChange={(e) => setEditingNote({ ...editingNote, tags: e.target.value })}
                    placeholder="標籤（空格分隔）"
                    className={styles.editTagsInput}
                  />
                  <div className={styles.editColorPicker}>
                    {NOTE_COLORS.map(color => (
                      <button
                        key={color}
                        type="button"
                        className={`${styles.colorOption} ${editingNote.color === color ? styles.colorSelected : ''}`}
                        style={{ backgroundColor: color }}
                        onClick={() => setEditingNote({ ...editingNote, color })}
                      />
                    ))}
                  </div>
                  <div className={styles.editActions}>
                    <button onClick={handleSaveNote} className={styles.saveBtn}>保存</button>
                    <button onClick={handleCancelEdit} className={styles.cancelBtn}>取消</button>
                  </div>
                </div>
              </div>
            )}
          </>
          )}
          </div>
        </div>
      </div>

      {/* 新增按鈕（浮動在右下角） */}
      <button
        onClick={handleAddNote}
        className={styles.addNoteBtn}
        title="新增便利貼"
      >
        +
      </button>
    </div>
  );
}

export default WhiteboardComponent;
