/**
 * 搜尋接下來一年內的重大事件：使用 Perplexity API（具網路搜尋）。
 * apiKey 由 Docusaurus customFields.perplexityApiKey 傳入。
 * 申請：https://www.perplexity.ai/settings/api
 */

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar';

/**
 * @param {string} keyword
 * @param {string} [apiKey] - Perplexity API key
 * @returns {Promise<{ events: Array<{ id, title, start, end }>, error?: string, source: 'api'|'mock' }>}
 */
export async function searchUpcomingEvents(keyword, apiKey) {
  const k = String(keyword).trim();
  if (!k) return { events: [], source: 'mock' };

  const key = (apiKey && String(apiKey).trim()) || '';

  if (key) {
    try {
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);
      const nextYear = new Date(today);
      nextYear.setFullYear(nextYear.getFullYear() + 1);
      const nextYearStr = nextYear.toISOString().slice(0, 10);

      const prompt = `你是一位專業的產業研究員。請搜尋網路即時資訊，找出與「${k}」相關且在未來一年內（${todayStr} 到 ${nextYearStr}）發生的所有重大事件。

          請包含：
          1. 官方已公告的確切日期（如法說會、財報日）。
          2. 根據往年慣例預估的週期性事件（如營收公告、股東會）。
          3. 產業重要展會（如 COMPUTEX、CES）。

          請「只」回傳一個 JSON 陣列，格式為：[{"title":"事件名稱","date":"YYYY-MM-DD"}]。
          請盡可能列出 5 到 15 個事件，不要回傳任何 Markdown 或解釋文字。`;

      const res = await fetch(PERPLEXITY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: PERPLEXITY_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.5,
          max_tokens: 2048,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        let msg = `API 錯誤 ${res.status}`;
        try {
          const j = JSON.parse(errBody);
          const errMsg = j.error?.message || j.message || '';
          if (res.status === 429 || errMsg.toLowerCase().includes('rate') || errMsg.toLowerCase().includes('limit') || errMsg.toLowerCase().includes('quota')) {
            msg = '請求頻率或額度已達上限，請稍後再試。';
          } else if (errMsg) {
            msg = errMsg;
          }
        } catch (_) {}
        return { events: [], error: msg, source: 'api' };
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) return { events: [], error: '沒有取得回覆', source: 'api' };

      const cleaned = text
        .replace(/^[\s\n]*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
      let list;
      try {
        list = JSON.parse(cleaned);
      } catch (_) {
        return { events: [], error: '回覆格式無法解析，請再試一次', source: 'api' };
      }
      if (!Array.isArray(list)) list = [list].filter(Boolean);

      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const oneYearEnd = new Date(now);
      oneYearEnd.setFullYear(oneYearEnd.getFullYear() + 1);

      const events = [];
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const title = (item?.title ?? item?.name ?? '').trim();
        const dateStr = item?.date ?? item?.reportDate ?? item?.start ?? '';
        if (!title || !dateStr) continue;
        const start = new Date(dateStr + 'T12:00:00');
        if (isNaN(start.getTime()) || start < now || start > oneYearEnd) continue;
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        events.push({
          id: `pplx-${k}-${i}-${start.getTime()}`,
          title,
          start,
          end,
        });
      }
      events.sort((a, b) => a.start - b.start);
      return { events, source: 'api' };
    } catch (err) {
      console.error('Perplexity 搜尋失敗:', err);
      return { events: [], error: err.message || '搜尋失敗，請稍後再試', source: 'api' };
    }
  }

  // 無 key：mock
  const now = new Date();
  const oneYearLater = new Date(now);
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
  const mockTemplates = [
    { title: `${k} 法說會`, monthOffset: 1, day: 15 },
    { title: `${k} 財報公布`, monthOffset: 2, day: 10 },
    { title: `${k} 股東會`, monthOffset: 4, day: 20 },
    { title: `${k} 除權息`, monthOffset: 6, day: 25 },
    { title: `${k} 新品發表`, monthOffset: 3, day: 8 },
    { title: `${k} 分析師日`, monthOffset: 5, day: 12 },
    { title: `${k} 業績說明會`, monthOffset: 8, day: 5 },
    { title: `${k} 年度展望`, monthOffset: 11, day: 18 },
  ];
  const events = mockTemplates
    .map((t, i) => {
      const start = new Date(now);
      start.setMonth(start.getMonth() + t.monthOffset);
      start.setDate(t.day);
      start.setHours(0, 0, 0, 0);
      if (start < now) start.setFullYear(start.getFullYear() + 1);
      if (start > oneYearLater) return null;
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return { id: `mock-${k}-${i}-${start.getTime()}`, title: t.title, start, end };
    })
    .filter(Boolean);
  await new Promise((r) => setTimeout(r, 300));
  return { events, source: 'mock' };
}

/** 是否已設定 API Key */
export function hasEventSearchApiKey(apiKey) {
  return !!(apiKey && String(apiKey).trim());
}
