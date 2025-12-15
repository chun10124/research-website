/* 負責與 Firebase 溝通，並定義數據模型 */ 

import { db } from './firebase';
import { collection, doc, updateDoc, onSnapshot, query, orderBy } from "firebase/firestore";

const COLLECTION = "stockWatchlist";

// 監聽清單 (即時更新)
export const subscribeWatchlist = (callback) => {
  const q = query(collection(db, COLLECTION), orderBy("category", "asc"));
  return onSnapshot(q, (snapshot) => {
    const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    callback(data);
  });
};

// Excel 式編輯：更新單一欄位 (EPS, 目標價, 備註)
export const updateAnalysisField = async (id, data) => {
  const ref = doc(db, COLLECTION, id);
  return await updateDoc(ref, {
    ...data,
    updatedAt: Date.now()
  });
};