import React, { useState, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { setDoc, onSnapshot } from 'firebase/firestore';
import { WHITEBOARD_DOC_REF } from '../utils/firebaseConfig';
import styles from './Whiteboard.module.css';

// 便利貼顏色選項
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
  const [formData, setFormData] = useState({
    id: '',
    content: '',
    tags: '',
    color: NOTE_COLORS[0],
  });
  const [editingId, setEditingId] = useState(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [timeFilter, setTimeFilter] = useState('ALL');

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

  // 處理表單輸入
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  // 提交表單
  const handleFormSubmit = (e) => {
    e.preventDefault();
    
    if (!formData.content.trim()) {
      alert('請輸入便利貼內容！');
      return;
    }

    // 將標籤用空白分隔，多個空白合併為一個
    const tagsStr = formData.tags.trim().split(/\s+/).filter(t => t).join(' ');
    
    const noteToSave = {
      ...formData,
      tags: tagsStr,
      createdAt: editingId 
        ? notes.find(n => n.id === editingId)?.createdAt || Date.now()
        : Date.now(),
      updatedAt: Date.now(),
    };

    let updatedNotes;
    if (editingId) {
      updatedNotes = notes.map(note =>
        note.id === editingId ? { ...noteToSave, id: editingId } : note
      );
      setEditingId(null);
    } else {
      const newNote = {
        ...noteToSave,
        id: uuidv4(),
      };
      updatedNotes = [newNote, ...notes];
    }

    saveNotesToCloud(updatedNotes);
    
    setFormData({
      id: '',
      content: '',
      tags: '',
      color: NOTE_COLORS[0],
    });
  };

  // 刪除便利貼
  const handleDelete = (id) => {
    if (window.confirm('確定要刪除這張便利貼嗎？')) {
      const updatedNotes = notes.filter(note => note.id !== id);
      saveNotesToCloud(updatedNotes);
    }
  };

  // 完成便利貼
  const handleComplete = (id) => {
    const updatedNotes = notes.map(note =>
      note.id === id ? { ...note, completed: true, completedAt: Date.now() } : note
    );
    saveNotesToCloud(updatedNotes);
  };


  // 編輯便利貼
  const handleEdit = (note) => {
    setFormData({
      id: note.id,
      content: note.content,
      tags: note.tags || '',
      color: note.color || NOTE_COLORS[0],
    });
    setEditingId(note.id);
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
        <h2>{editingId ? '編輯便利貼' : '白板'}</h2>
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
          {/* 表單區域 */}
          <form onSubmit={handleFormSubmit} className={styles.formContainer}>
            <h3 className={styles.sectionTitle}>{editingId ? '編輯便利貼' : '新增便利貼'}</h3>
            <div className={styles.formRow}>
              <textarea
                name="content"
                value={formData.content}
                onChange={handleInputChange}
                placeholder="輸入便利貼內容..."
                required
                rows="4"
                className={styles.contentInput}
              />
            </div>
            <div className={styles.formRow}>
              <input
                type="text"
                name="tags"
                value={formData.tags}
                onChange={handleInputChange}
                placeholder="標籤（用空格分隔）"
                className={styles.tagsInput}
              />
            </div>
            <div className={styles.formRow}>
              <div className={styles.colorPicker}>
                <label>顏色：</label>
                <div className={styles.colorOptions}>
                  {NOTE_COLORS.map(color => (
                    <button
                      key={color}
                      type="button"
                      className={`${styles.colorOption} ${formData.color === color ? styles.colorSelected : ''}`}
                      style={{ backgroundColor: color }}
                      onClick={() => setFormData(prev => ({ ...prev, color }))}
                      title={color}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className={styles.formActions}>
              <button type="submit" className={styles.submitBtn}>
                {editingId ? '更新' : '新增'}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setFormData({
                      id: '',
                      content: '',
                      tags: '',
                      color: NOTE_COLORS[0],
                    });
                  }}
                  className={styles.cancelBtn}
                >
                  取消
                </button>
              )}
            </div>
          </form>

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

        {/* 右側便利貼網格 */}
        <div className={styles.rightContent}>
          <div className={styles.notesGrid}>
        {filteredNotes.length === 0 ? (
          <div className={styles.emptyState}>
            {notes.length === 0 ? '還沒有便利貼，建立第一張吧！' : '沒有匹配的便利貼'}
          </div>
        ) : (
          filteredNotes.map(note => (
            <div
              key={note.id}
              className={styles.note}
              style={{ backgroundColor: note.color || NOTE_COLORS[0] }}
            >
              <div className={styles.noteHeader}>
                <span className={styles.noteTime}>{formatTime(note.createdAt)}</span>
                <div className={styles.noteActions}>
                  <button
                    onClick={() => handleEdit(note)}
                    className={styles.editBtn}
                    title="編輯"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => handleDelete(note.id)}
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
              {/* 完成按鈕（右下角） */}
              <button
                onClick={() => handleComplete(note.id)}
                className={styles.completeBtn}
                title="標記為完成"
              >
                ✓
              </button>
            </div>
          ))
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default WhiteboardComponent;
