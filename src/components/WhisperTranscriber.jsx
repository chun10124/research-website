import React, { useRef, useState, useEffect } from 'react';

const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const STORAGE_KEY = 'whisper_openai_api_key';

const OPTIMIZE_PROMPT = `角色設定： 你是一位極度嚴謹的「專業財經速記員」，專門處理各種產業的法說會、訪談錄音。
核心任務： 請將下方的原始逐字稿進行「可讀性優化」。你的唯一目標是提升原文的可讀性，同時確保內容 100% 完整。
嚴格限制（不可違反）：

必須將所有數字改為阿拉伯數字（例如將「二七」改為 27 ）。
禁止摘要： 絕對不准濃縮、簡化或省略任何句子。即便語句碎裂，也要完整保留。
禁止列點： 不准將對話中的任何內容改寫為條列式摘要，一切以逐字稿呈現。
保留語氣： 保留說話者的原始口吻（如「那個」、「其實」、「我覺得」）。
禁止刪除數據： 所有的百分比、金額（幾億）、日期、案號（P1/P2）必須精確保留在原位。
執行動作：

自動分段： 在說話主題變更、或是語意轉折處強制換行。
加入主題標題： 在各分段上方加上 ### [主題名稱]，方便閱讀定位。
專業術語校正： 根據上下文修正音近錯字，並根據產業知識修正專業術語（例如：將「KOWAS」改為「CoWoS」）。
標點強化： 確保標點符號精確，讓長難句變得易讀。
待處理原文：
`;

const MINIMAL_PROMPT = `角色設定： 你現在是一位極簡主義的文字編輯。

任務目標： 請幫我優化下方這段文字。你的目標是「去蕪存菁」，僅針對句子內部的修辭進行微調。

執行準則（嚴格遵守）：

禁止結構變動： 不准更改段落順序、不准把內文變成列點（Bullet points）、不准做摘要。

保留原意與語氣： 盡可能保留我原本的用詞與敘事風格，不要把語氣變得太過正式或公關化。

僅刪除贅字： 專注於刪除冗贅的連接詞（例如：的部分、進行一個...的動作、其實、然後）、重複的詞彙或不必要的修飾語。

字數微調： 輸出後的總字數應與原稿相近，甚至略少，絕對不可增加內容。

待修改文字：
`;

export default function WhisperTranscriber() {
  const [isDragging, setIsDragging] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [progressText, setProgressText] = useState('');
  const [transcript, setTranscript] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedMinimalPrompt, setCopiedMinimalPrompt] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setApiKey(saved);
  }, []);

  const saveApiKey = (key) => {
    setApiKey(key);
    if (key) {
      localStorage.setItem(STORAGE_KEY, key);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  // 把 Float32Array PCM（16kHz 單聲道）封裝成 WAV Blob
  const encodeWav = (samples, sampleRate = 16000) => {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = samples.length * 2;

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  };

  // 上傳單一 Blob 到 Whisper API 並回傳文字
  const transcribeBlob = async (blob, filename) => {
    const formData = new FormData();
    formData.append('file', blob, filename);
    formData.append('model', 'whisper-1');
    formData.append('language', 'zh');
    formData.append('response_format', 'text');

    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error('API Key 無效或已過期，請重新輸入。');
      const errBody = await res.text();
      throw new Error(`OpenAI API 錯誤 (${res.status}): ${errBody}`);
    }

    return (await res.text()).trim();
  };

  const handleFile = async (file) => {
    if (!apiKey) {
      setShowKeyInput(true);
      setError('請先輸入 OpenAI API Key。');
      return;
    }

    setError('');
    setTranscript('');
    setFileName(file.name);
    setPhase('transcribing');

    const MAX_DIRECT_BYTES = 25 * 1024 * 1024; // 25MB

    try {
      // ── 路徑 A：原始檔案 ≤ 25MB，直接丟給 OpenAI，行為跟以前一樣 ──
      if (file.size <= MAX_DIRECT_BYTES) {
        setProgressText('正在上傳至 OpenAI Whisper API...');
        const text = await transcribeBlob(file, file.name);
        setTranscript(text);
        setPhase('done');
        setProgressText('');
        return;
      }

      // ── 路徑 B：原始檔案 > 25MB，才走「解碼 → 切段 → WAV → 逐段上傳」 ──
      const SAMPLE_RATE = 16000;
      // 16kHz 16-bit mono = 32000 bytes/sec；留 1MB buffer，每塊最多 24MB
      const MAX_CHUNK_BYTES = 24 * 1024 * 1024;
      const CHUNK_SAMPLES = Math.floor((MAX_CHUNK_BYTES - 44) / 2);

      setProgressText('解碼音訊...');
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const pcm = audioBuffer.getChannelData(0);

      const totalChunks = Math.ceil(pcm.length / CHUNK_SAMPLES);
      const parts = [];

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SAMPLES;
        const slice = pcm.slice(start, start + CHUNK_SAMPLES);
        setProgressText(`轉譯中 ${i + 1} / ${totalChunks} 段...`);
        const wav = encodeWav(slice, SAMPLE_RATE);
        const text = await transcribeBlob(wav, `chunk_${i + 1}.wav`);
        parts.push(text);
      }

      setTranscript(parts.join(' '));
      setPhase('done');
      setProgressText('');
    } catch (err) {
      console.error(err);
      setError(err?.message || '轉譯失敗，請稍後再試。');
      setPhase('error');
      setProgressText('');
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleCopy = async () => {
    if (!transcript) return;
    await navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyPrompt = async () => {
    await navigator.clipboard.writeText(OPTIMIZE_PROMPT);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const handleCopyMinimalPrompt = async () => {
    await navigator.clipboard.writeText(MINIMAL_PROMPT);
    setCopiedMinimalPrompt(true);
    setTimeout(() => setCopiedMinimalPrompt(false), 2000);
  };

  const isActive = phase === 'transcribing';

  return (
    <section
      style={{
        padding: '10px',
        maxWidth: '450px',
        margin: '10px 0',
        borderRadius: '8px',
        border: '1px solid var(--ifm-color-primary-light)',
        background: 'var(--ifm-background-color)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '10px',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Whisper 逐字稿</h2>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button
            type="button"
            onClick={handleCopyPrompt}
            title="複製逐字稿分段整理指令"
            style={{
              fontSize: '0.7rem',
              padding: '3px 8px',
              borderRadius: '4px',
              border: '1px solid var(--ifm-color-emphasis-300)',
              background: copiedPrompt ? 'var(--ifm-color-success)' : 'transparent',
              color: copiedPrompt ? '#fff' : 'var(--ifm-color-emphasis-600)',
              cursor: 'pointer',
              transition: 'background 0.2s, color 0.2s',
            }}
          >
            {copiedPrompt ? '已複製' : '分段整理'}
          </button>
          <button
            type="button"
            onClick={handleCopyMinimalPrompt}
            title="複製極簡編輯指令"
            style={{
              fontSize: '0.7rem',
              padding: '3px 8px',
              borderRadius: '4px',
              border: '1px solid var(--ifm-color-emphasis-300)',
              background: copiedMinimalPrompt
                ? 'var(--ifm-color-success)'
                : 'transparent',
              color: copiedMinimalPrompt ? '#fff' : 'var(--ifm-color-emphasis-600)',
              cursor: 'pointer',
              transition: 'background 0.2s, color 0.2s',
            }}
          >
            {copiedMinimalPrompt ? '已複製' : '極簡編輯'}
          </button>
          <button
            type="button"
            onClick={() => setShowKeyInput((v) => !v)}
            style={{
              fontSize: '0.7rem',
              padding: '3px 8px',
              borderRadius: '999px',
              border: '1px solid var(--ifm-color-emphasis-300)',
              background: apiKey
                ? 'var(--ifm-color-success)'
                : 'var(--ifm-color-emphasis-200)',
              color: apiKey ? '#fff' : 'var(--ifm-color-emphasis-700)',
              cursor: 'pointer',
            }}
          >
            {apiKey ? 'API Key ✓' : '設定 API Key'}
          </button>
        </div>
      </div>

      {showKeyInput && (
        <div
          style={{
            marginBottom: '10px',
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
          }}
        >
          <input
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => saveApiKey(e.target.value)}
            style={{
              flex: 1,
              padding: '6px 10px',
              fontSize: '0.85rem',
              borderRadius: '6px',
              border: '1px solid var(--ifm-color-emphasis-300)',
              background: 'var(--ifm-background-color)',
              color: 'var(--ifm-font-color-base)',
            }}
          />
          {apiKey && (
            <button
              type="button"
              onClick={() => {
                saveApiKey('');
                setShowKeyInput(true);
              }}
              style={{
                fontSize: '0.75rem',
                padding: '4px 8px',
                borderRadius: '6px',
                border: '1px solid var(--ifm-color-emphasis-300)',
                background: 'var(--ifm-color-danger)',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              清除
            </button>
          )}
        </div>
      )}

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !isActive && inputRef.current?.click()}
        style={{
          borderRadius: '6px',
          border: `1px solid ${
            isDragging
              ? 'var(--ifm-color-primary)'
              : 'var(--ifm-color-primary-lighter)'
          }`,
          padding: '14px 12px',
          textAlign: 'center',
          cursor: isActive ? 'default' : 'pointer',
          transition: 'background 0.15s ease, border-color 0.15s ease',
          background: isDragging
            ? 'rgba(0,122,255,0.06)'
            : 'var(--ifm-background-color)',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={handleInputChange}
        />

        {isActive ? (
          <div>
            <div style={{ marginBottom: '8px', fontSize: '0.9rem' }}>
              {progressText}
            </div>
            <div
              style={{
                height: '6px',
                borderRadius: '999px',
                background: 'var(--ifm-color-emphasis-200)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: '100%',
                  background: `linear-gradient(90deg, var(--ifm-color-primary) 0%, transparent 50%, var(--ifm-color-primary) 100%)`,
                  backgroundSize: '200% 100%',
                  animation: 'whisper-shimmer 1.5s linear infinite',
                  borderRadius: '999px',
                }}
              />
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: '1.5rem', marginBottom: '4px' }}>💿</div>
            <div style={{ fontSize: '0.9rem' }}>
              <strong>拖曳錄音檔到這裡</strong>，或點擊選擇檔案
            </div>
            <div
              style={{
                fontSize: '0.75rem',
                marginTop: '4px',
                color: 'var(--ifm-color-emphasis-500)',
              }}
            >
              拖曳或點選錄音檔｜OpenAI Whisper API
            </div>
            {fileName && (
              <div
                style={{
                  marginTop: '8px',
                  fontSize: '0.85rem',
                  color: 'var(--ifm-color-emphasis-600)',
                }}
              >
                上次：{fileName}
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <div
          style={{
            marginTop: '8px',
            color: 'var(--ifm-color-danger)',
            fontSize: '0.8rem',
          }}
        >
          ⚠️ {error}
        </div>
      )}

      <div
        className="whisper-transcript-box"
        style={{
          marginTop: '10px',
          position: 'relative',
          borderRadius: '4px',
          border: '1px solid var(--ifm-color-primary-lighter)',
          padding: '8px 10px',
          paddingRight: '56px',
          background: 'var(--ifm-background-color)',
          minHeight: '52px',
          maxHeight: '180px',
          overflowY: 'auto',
        }}
      >
        <button
          type="button"
          onClick={handleCopy}
          disabled={!transcript}
          title={copied ? '已複製' : '複製'}
          style={{
            position: 'absolute',
            top: '6px',
            right: '6px',
            width: '28px',
            height: '28px',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
            border: '1px solid var(--ifm-color-emphasis-300)',
            background: transcript
              ? copied
                ? 'var(--ifm-color-success)'
                : 'transparent'
              : 'transparent',
            color: transcript
              ? copied
                ? '#fff'
                : 'var(--ifm-color-emphasis-600)'
              : 'var(--ifm-color-emphasis-400)',
            cursor: transcript ? 'pointer' : 'not-allowed',
            transition: 'background-color 0.2s ease, color 0.2s ease',
          }}
        >
          {copied ? (
            <span style={{ fontSize: '0.75rem' }}>✓</span>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>

        <div
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: '0.9rem',
            lineHeight: '1.5',
          }}
        >
          {transcript || (
            <span style={{ color: 'var(--ifm-color-emphasis-400)' }}>
              逐字稿會顯示在這裡。
            </span>
          )}
        </div>
      </div>

      <style>{`
        @keyframes whisper-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .whisper-transcript-box {
          scrollbar-width: thin;
          scrollbar-color: var(--ifm-color-emphasis-200) transparent;
        }
        .whisper-transcript-box::-webkit-scrollbar {
          width: 5px;
        }
        .whisper-transcript-box::-webkit-scrollbar-track {
          background: transparent;
        }
        .whisper-transcript-box::-webkit-scrollbar-thumb {
          background: var(--ifm-color-emphasis-200);
          border-radius: 3px;
        }
        .whisper-transcript-box::-webkit-scrollbar-thumb:hover {
          background: var(--ifm-color-emphasis-300);
        }
      `}</style>
    </section>
  );
}
