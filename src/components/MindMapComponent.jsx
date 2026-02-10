import React, { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { setDoc, onSnapshot, doc } from 'firebase/firestore';
import { MINDMAP_DOC_REF, db } from '../utils/firebaseConfig';
import styles from './MindMap.module.css';

function MindMapComponent({ mindMapId, onBack, onDelete }) {
  const [nodes, setNodes] = useState([]);
  const [connections, setConnections] = useState([]);
  const [textBoxes, setTextBoxes] = useState([]);
  const [arrows, setArrows] = useState([]);
  const [editingNode, setEditingNode] = useState(null);
  const [editingTextBox, setEditingTextBox] = useState(null);
  const [draggingNode, setDraggingNode] = useState(null);
  const [draggingTextBox, setDraggingTextBox] = useState(null);
  const [draggingArrow, setDraggingArrow] = useState(null);
  const [draggingArrowEnd, setDraggingArrowEnd] = useState(null); // 'start' 或 'end'
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [arrowContextMenu, setArrowContextMenu] = useState(null);
  const [selectedArrow, setSelectedArrow] = useState(null); // 選中的箭頭 ID
  const [hoveredNode, setHoveredNode] = useState(null);
  const [hoveredTextBox, setHoveredTextBox] = useState(null);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [clickStartPos, setClickStartPos] = useState(null);
  const [hasAutoCentered, setHasAutoCentered] = useState(false);
  const [nodeSearchQuery, setNodeSearchQuery] = useState('');
  const [isDrawingArrow, setIsDrawingArrow] = useState(false);
  const [arrowStart, setArrowStart] = useState(null);
  const [arrowPreviewEnd, setArrowPreviewEnd] = useState(null);
  const pinchStartRef = useRef(null);
  const canvasRef = useRef(null);
  const zoomPanRef = useRef({ zoom: 1, panX: 0, panY: 0 });
  const editorSearchInputRef = useRef(null);

  useEffect(() => {
    zoomPanRef.current = { zoom, panX: panOffset.x, panY: panOffset.y };
  }, [zoom, panOffset.x, panOffset.y]);

  // 邊界距離（px）
  const BOUNDARY_MARGIN = 20;

  // 從滑鼠或觸控取得 clientX, clientY
  const getClientCoords = (e) => {
    if (e.touches && e.touches.length > 0) {
      return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
    }
    if (e.changedTouches && e.changedTouches.length > 0) {
      return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
    }
    return { clientX: e.clientX, clientY: e.clientY };
  };

  // 編輯器頁面：禁用滾動和隱藏 footer
  useEffect(() => {
    const htmlElement = document.documentElement;
    const bodyElement = document.body;
    const mainElement = document.querySelector('main');
    const footerElement = document.querySelector('footer');
    const mainWrapper = document.querySelector('.main-wrapper');

    // 隱藏 footer
    if (footerElement) {
      footerElement.style.display = 'none';
    }

    // 禁用所有滾動
    if (htmlElement) {
      htmlElement.style.overflow = 'hidden';
      htmlElement.style.height = '100%';
    }
    if (bodyElement) {
      bodyElement.style.overflow = 'hidden';
      bodyElement.style.height = '100%';
    }
    if (mainWrapper) {
      mainWrapper.style.overflow = 'hidden';
      mainWrapper.style.height = '100vh';
    }
    if (mainElement) {
      mainElement.style.overflow = 'hidden';
      mainElement.style.height = 'calc(100vh - var(--ifm-navbar-height))';
    }

    return () => {
      // 恢復頁面滾動和 footer
      if (footerElement) {
        footerElement.style.display = '';
      }
      if (htmlElement) {
        htmlElement.style.overflow = '';
        htmlElement.style.height = '';
      }
      if (bodyElement) {
        bodyElement.style.overflow = '';
        bodyElement.style.height = '';
      }
      if (mainWrapper) {
        mainWrapper.style.overflow = '';
        mainWrapper.style.height = '';
      }
      if (mainElement) {
        mainElement.style.overflow = '';
        mainElement.style.height = '';
      }
    };
  }, []);

  // 獲取畫布尺寸
  useEffect(() => {
    const updateCanvasSize = () => {
      const canvasElement = document.querySelector(`.${styles.mindMapCanvas}`);
      if (canvasElement) {
        setCanvasSize({
          width: canvasElement.clientWidth,
          height: canvasElement.clientHeight,
        });
      }
    };

    // 延遲執行以確保 DOM 已渲染
    setTimeout(updateCanvasSize, 100);
    updateCanvasSize();
    window.addEventListener('resize', updateCanvasSize);
    return () => window.removeEventListener('resize', updateCanvasSize);
  }, []);

  // 限制節點位置在邊界內（基於畫布座標系）
  const constrainNodePosition = (node, x, y) => {
    if (canvasSize.width === 0 || canvasSize.height === 0) {
      // 如果畫布尺寸還未獲取，先不限制
      return { x, y };
    }

    // 計算節點在畫布座標系中的實際位置
    // 節點的實際顯示位置 = (x * zoom) + panOffset.x
    // 我們需要確保節點的實際顯示位置在可見區域內
    
    // 計算節點在螢幕上的實際位置範圍
    const nodeScreenLeft = x * zoom + panOffset.x;
    const nodeScreenTop = y * zoom + panOffset.y;
    const nodeScreenRight = nodeScreenLeft + node.width * zoom;
    const nodeScreenBottom = nodeScreenTop + node.height * zoom;

    // 計算允許的螢幕位置範圍
    const minScreenX = BOUNDARY_MARGIN;
    const maxScreenX = canvasSize.width - node.width * zoom - BOUNDARY_MARGIN;
    const minScreenY = BOUNDARY_MARGIN;
    const maxScreenY = canvasSize.height - node.height * zoom - BOUNDARY_MARGIN;

    // 限制螢幕位置
    let constrainedScreenX = Math.max(minScreenX, Math.min(maxScreenX, nodeScreenLeft));
    let constrainedScreenY = Math.max(minScreenY, Math.min(maxScreenY, nodeScreenTop));

    // 轉換回畫布座標系
    const constrainedX = (constrainedScreenX - panOffset.x) / zoom;
    const constrainedY = (constrainedScreenY - panOffset.y) / zoom;
    
    return {
      x: constrainedX,
      y: constrainedY,
    };
  };

  // 從 Firebase 載入資料
  useEffect(() => {
    if (!mindMapId) return;

    // 切換心智圖時重置自動居中標記
    setHasAutoCentered(false);
    setPanOffset({ x: 0, y: 0 });
    setZoom(1);

    const docRef = doc(db, `mindmaps`, mindMapId);
    const unsubscribe = onSnapshot(docRef, async (docSnapshot) => {
      if (docSnapshot.exists()) {
        const data = docSnapshot.data();
        const NODE_HEIGHT = 28;
        setNodes((data.nodes || []).map(n => ({ ...n, height: NODE_HEIGHT })));
        setConnections(data.connections || []);
        setTextBoxes(data.textBoxes || []);
        setArrows(data.arrows || []);
      } else {
        // 初始化新心智圖（從最左邊開始）
        const initialNode = {
          id: uuidv4(),
          text: '中心主題',
          x: 100,
          y: 300,
          width: calculateNodeWidth('中心主題'),
          height: 28,
        };
        const initialNodes = [initialNode];
        const initialConnections = [];
        setNodes(initialNodes);
        setConnections(initialConnections);
        setHasAutoCentered(false); // 重置自動居中標記
        // 儲存初始資料
        try {
          await setDoc(docRef, {
            nodes: initialNodes,
            connections: initialConnections,
            updatedAt: Date.now(),
          });
        } catch (error) {
          console.error('寫入 Firestore 失敗:', error);
        }
      }
    }, (error) => {
      console.error('Firestore 監聽失敗:', error);
    });

    return () => unsubscribe();
  }, [mindMapId]);

  // 自動定位到節點區域
  useEffect(() => {
    if (nodes.length === 0 || canvasSize.width === 0 || canvasSize.height === 0 || hasAutoCentered) {
      return;
    }

    // 計算所有節點的邊界框
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    nodes.forEach(node => {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x + node.width);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y + node.height);
    });

    // 計算節點區域的中心點
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // 計算畫布中心點
    const canvasCenterX = canvasSize.width / 2;
    const canvasCenterY = canvasSize.height / 2;

    // 調整 panOffset 使節點中心對齊到畫布中心
    // 公式：節點中心 * zoom + panOffset = 畫布中心
    // 所以：panOffset = 畫布中心 - 節點中心 * zoom
    const newPanOffsetX = canvasCenterX - centerX * zoom;
    const newPanOffsetY = canvasCenterY - centerY * zoom;

    setPanOffset({ x: newPanOffsetX, y: newPanOffsetY });
    setHasAutoCentered(true);
  }, [nodes, canvasSize, zoom, hasAutoCentered]);

  // 儲存到 Firebase
  const saveToFirebase = async (nodesToSave, connectionsToSave, textBoxesToSave = null, arrowsToSave = null) => {
    if (!mindMapId) return;
    try {
      const docRef = doc(db, `mindmaps`, mindMapId);
      const dataToSave = {
        nodes: nodesToSave,
        connections: connectionsToSave,
        updatedAt: Date.now(),
      };
      if (textBoxesToSave !== null) {
        dataToSave.textBoxes = textBoxesToSave;
      }
      if (arrowsToSave !== null) {
        dataToSave.arrows = arrowsToSave;
      }
      await setDoc(docRef, dataToSave);
    } catch (error) {
      console.error('寫入 Firestore 失敗:', error);
    }
  };

  // 獲取節點的子節點
  const getChildNodes = (nodeId) => {
    return connections
      .filter(conn => conn.from === nodeId)
      .map(conn => {
        const node = nodes.find(n => n.id === conn.to);
        return node ? { ...node, connectionId: conn.id } : null;
      })
      .filter(Boolean);
  };

  // 遞迴獲取所有子節點（包括子節點的子節點）
  const getAllDescendants = (nodeId) => {
    const descendants = new Set();
    const findChildren = (parentId) => {
      const children = connections
        .filter(conn => conn.from === parentId)
        .map(conn => conn.to);
      
      children.forEach(childId => {
        if (!descendants.has(childId)) {
          descendants.add(childId);
          findChildren(childId); // 遞迴查找
        }
      });
    };
    findChildren(nodeId);
    return Array.from(descendants);
  };

  // 檢測節點在哪個方向（相對於父節點）
  const getNodeDirection = (parentNode, childNode) => {
    const parentCenterX = parentNode.x + parentNode.width / 2;
    const parentCenterY = parentNode.y + parentNode.height / 2;
    const childCenterX = childNode.x + childNode.width / 2;
    const childCenterY = childNode.y + childNode.height / 2;

    const dx = childCenterX - parentCenterX;
    const dy = childCenterY - parentCenterY;

    // 使用更精確的判斷，考慮節點的實際位置
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    
    // 如果水平距離明顯大於垂直距離，判斷為左右
    // 調整閾值，讓水平方向的判斷更優先
    if (absDx > absDy * 0.8) {
      return dx > 0 ? 'right' : 'left';
    } 
    // 如果垂直距離明顯大於水平距離，判斷為上下
    else if (absDy > absDx * 0.8) {
      return dy > 0 ? 'bottom' : 'top';
    }
    // 如果距離相近，優先判斷為水平方向（因為通常子節點會在父節點左右）
    else {
      return absDx >= absDy ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
    }
  };

  // 計算節點寬度（根據文字內容，英文用較窄寬度避免節點過寬）
  const calculateNodeWidth = (text) => {
    const cjkWidth = 14;   // 中文字約 14px
    const asciiWidth = 11; // 英文字約 11px（8 太擠、14 太寬）
    const padding = 18;
    const maxChars = 15;
    const minWidth = 4 * cjkWidth; // 最小寬度約四個中文字

    const getCharWidth = (c) => (c.charCodeAt(0) < 128 ? asciiWidth : cjkWidth);

    if (!text || text.length === 0) {
      return minWidth + padding;
    }
    if (text.length < maxChars) {
      let visualWidth = 0;
      for (let i = 0; i < text.length; i++) {
        visualWidth += getCharWidth(text[i]);
      }
      return Math.max(minWidth, visualWidth) + padding;
    }
    // 十五個字或以上，使用固定寬度（允許換行）
    return maxChars * cjkWidth + padding;
  };

  // 檢測兩個節點是否重疊
  const checkOverlap = (node1, node2) => {
    // 檢查水平方向是否重疊
    const horizontalOverlap = !(node1.x + node1.width < node2.x || node2.x + node2.width < node1.x);
    // 檢查垂直方向是否重疊
    const verticalOverlap = !(node1.y + node1.height < node2.y || node2.y + node2.height < node1.y);
    
    return horizontalOverlap && verticalOverlap;
  };

  // 計算重疊的距離
  const getOverlapDistance = (node1, node2) => {
    if (!checkOverlap(node1, node2)) return 0;
    
    // 計算垂直方向的重疊距離
    const top1 = node1.y;
    const bottom1 = node1.y + node1.height;
    const top2 = node2.y;
    const bottom2 = node2.y + node2.height;
    
    const overlapTop = Math.max(top1, top2);
    const overlapBottom = Math.min(bottom1, bottom2);
    const overlapDistance = overlapBottom - overlapTop;
    
    return overlapDistance;
  };

  // 自動分離節點：間距 < minSpacing 就彈開到 minSpacing（含拖曳中）
  const separateOverlappingNodes = (nodesToUpdate) => {
    const minSpacing = 7; // 節點之間的最小間距（px）
    let updatedNodes = [...nodesToUpdate];
    let hasChanges = true;
    let iterations = 0;
    const maxIterations = 50; // 防止無限循環

    while (hasChanges && iterations < maxIterations) {
      hasChanges = false;
      iterations++;

      const sortedNodes = [...updatedNodes].sort((a, b) => a.y - b.y);

      for (let i = 0; i < sortedNodes.length; i++) {
        for (let j = i + 1; j < sortedNodes.length; j++) {
          const node1 = sortedNodes[i];
          const node2 = sortedNodes[j];
          const horizontalOverlap = !(node1.x + node1.width < node2.x || node2.x + node2.width < node1.x);
          if (!horizontalOverlap) continue;

          // 垂直間距 = node2 頂 - node1 底；小於 minSpacing 就彈開
          const gap = node2.y - (node1.y + node1.height);
          if (gap < minSpacing) {
            const moveDistance = minSpacing - gap;

            // 移動下方的節點（node2）向下
            const node2Index = updatedNodes.findIndex(n => n.id === node2.id);
            if (node2Index !== -1) {
              const newY = updatedNodes[node2Index].y + moveDistance;
              
              // 限制在邊界內
              const constrained = constrainNodePosition(updatedNodes[node2Index], updatedNodes[node2Index].x, newY);
              
              // 如果節點有子節點，也要一起移動
              const descendantIds = getAllDescendants(node2.id);
              const deltaY = constrained.y - updatedNodes[node2Index].y;
              
              // 更新節點位置
              updatedNodes = updatedNodes.map(node => {
                if (node.id === node2.id) {
                  return { ...node, y: constrained.y };
                } else if (descendantIds.includes(node.id)) {
                  // 子節點跟隨移動
                  return { ...node, y: node.y + deltaY };
                }
                return node;
              });
              
              hasChanges = true;
            }
          }
        }
      }
    }

    return updatedNodes;
  };

  // 獲取同層級的所有節點（同一父節點的子節點）
  const getSiblingNodes = (nodeId) => {
    // 找到這個節點的父節點
    const connection = connections.find(conn => conn.to === nodeId);
    if (!connection) return []; // 沒有父節點，返回空陣列

    // 獲取同一父節點的所有子節點
    return getChildNodes(connection.from);
  };

  // 對齊同層級的所有節點
  const alignSiblingNodes = (nodeId, nodesToUpdate) => {
    const siblings = getSiblingNodes(nodeId);
    if (siblings.length === 0) return nodesToUpdate;

    // 找到第一個同層級節點的 x 座標（作為對齊基準）
    const firstSibling = siblings[0];
    const alignX = firstSibling.x;

    // 更新所有同層級節點的 x 座標
    return nodesToUpdate.map(node => {
      const isSibling = siblings.some(s => s.id === node.id);
      if (isSibling) {
        return { ...node, x: alignX };
      }
      return node;
    });
  };

  // 計算新節點的最佳位置（所有子節點都在右側，垂直排列，同層級對齊）
  const calculateNewNodePosition = (parentNode, childNodes) => {
    const spacing = 56;
    const verticalSpacing = 20;
    const nodeWidth = 120;
    const nodeHeight = 28;

    // 所有子節點都在父節點的右側
    const direction = 'right';
    
    let newX, newY;

    if (childNodes.length === 0) {
      // 第一個子節點：右側，與父節點對齊
      newX = parentNode.x + parentNode.width + spacing;
      newY = parentNode.y;
    } else {
      // 找出所有右側的子節點，按 y 座標排序
      const rightSideNodes = childNodes
        .filter(child => {
          // 確保子節點確實在右側
          const childCenterX = child.x + child.width / 2;
          const parentRightX = parentNode.x + parentNode.width;
          return childCenterX > parentRightX;
        })
        .sort((a, b) => a.y - b.y); // 按 y 座標從上到下排序

      if (rightSideNodes.length === 0) {
        // 如果沒有右側節點，放在第一個位置
        newX = parentNode.x + parentNode.width + spacing;
        newY = parentNode.y;
      } else {
        // 使用第一個子節點的 x 座標作為對齊基準
        const firstNode = rightSideNodes[0];
        newX = firstNode.x; // 對齊到第一個節點
        // 放在最後一個子節點的下方
        const lastNode = rightSideNodes[rightSideNodes.length - 1];
        newY = lastNode.y + lastNode.height + verticalSpacing;
      }
    }

    // 限制在邊界內
    const tempNode = { width: nodeWidth, height: nodeHeight };
    const constrainedPos = constrainNodePosition(tempNode, newX, newY);

    return { x: constrainedPos.x, y: constrainedPos.y, direction: direction };
  };

  // 新增子節點
  const handleAddChildNode = (parentNode) => {
    const childNodes = getChildNodes(parentNode.id);
    const { x, y, direction } = calculateNewNodePosition(parentNode, childNodes);

    const newNode = {
      id: uuidv4(),
      text: '新節點',
      x,
      y,
      width: calculateNodeWidth('新節點'),
      height: 28,
    };

    const newConnection = {
      id: uuidv4(),
      from: parentNode.id,
      to: newNode.id,
      direction, // 儲存連接方向
    };

    const updatedNodes = [...nodes, newNode];
    const updatedConnections = [...connections, newConnection];
    
    setNodes(updatedNodes);
    setConnections(updatedConnections);
    saveToFirebase(updatedNodes, updatedConnections, textBoxes, arrows);
    setEditingNode(newNode.id);
  };

  // 開始拖動背景
  const handleCanvasMouseDown = (e) => {
    const { clientX, clientY } = getClientCoords(e);
    
    // 如果點擊的是搜尋框區域，不處理
    if (e.target.closest(`.${styles.editorSearchContainer}`)) {
      return;
    }
    // 如果點擊的是懸浮按鈕，不處理
    if (e.target.closest(`.${styles.floatingActions}`) || 
        e.target.closest(`.${styles.floatingButton}`)) {
      return;
    }
    
    // 如果點擊的是節點、加號按鈕、刪除按鈕、文字方塊，不處理背景點擊
    if (e.target.closest(`.${styles.node}`) || 
        e.target.closest(`.${styles.nodeAddButton}`) || 
        e.target.closest(`.${styles.nodeDeleteButton}`) ||
        e.target.closest(`.${styles.nodeLeftAction}`) ||
        e.target.closest(`.${styles.textBox}`) ||
        e.target.closest(`.${styles.textBoxDeleteButton}`)) {
      return;
    }
    
    // 箭頭繪製模式
    if (isDrawingArrow) {
      // 檢測是否點擊箭頭（線條或圓點）- 在繪製模式下不應該拖動現有箭頭
      if (e.target.tagName === 'path' || e.target.tagName === 'circle') {
        const arrowGroup = e.target.closest('g[data-arrow-id]');
        if (arrowGroup) {
          // 在繪製模式下點擊現有箭頭，不處理
          return;
        }
      }
      
      // 檢查是否點擊了 canvas 外部的背景（點擊了容器外部）
      const canvasElement = e.currentTarget;
      const isClickOutsideCanvas = !canvasElement.contains(e.target) && 
                                   e.target !== canvasElement &&
                                   !e.target.closest(`.${styles.mindMapCanvas}`);
      
      if (isClickOutsideCanvas) {
        // 點擊 canvas 外部：取消箭頭繪製模式
        setIsDrawingArrow(false);
        setArrowStart(null);
        setArrowPreviewEnd(null);
        setSelectedArrow(null); // 清除箭頭選中狀態
        return;
      }
      
      // 點擊 canvas 內部：繼續繪製箭頭
      // 允許點擊 nodesContainer、SVG、連接線等空白區域來繪製箭頭
      e.preventDefault();
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const canvasX = (clientX - rect.left - panOffset.x) / zoom;
      const canvasY = (clientY - rect.top - panOffset.y) / zoom;
      
      if (!arrowStart) {
        // 第一次點擊：記錄起始點
        setArrowStart({ x: canvasX, y: canvasY });
      } else {
        // 第二次點擊：創建箭頭（應用磁鐵效果）
        const snapped = snapToAxis(arrowStart.x, arrowStart.y, canvasX, canvasY);
        const newArrow = {
          id: uuidv4(),
          startX: arrowStart.x,
          startY: arrowStart.y,
          endX: snapped.x,
          endY: snapped.y,
        };
        const updatedArrows = [...arrows, newArrow];
        setArrows(updatedArrows);
        saveToFirebase(nodes, connections, textBoxes, updatedArrows);
        setArrowStart(null);
        setArrowPreviewEnd(null);
        setIsDrawingArrow(false);
      }
      return;
    }
    
    // 檢測是否點擊箭頭（線條或圓點）- 只在非箭頭繪製模式下處理
    if (!isDrawingArrow && (e.target.tagName === 'path' || e.target.tagName === 'circle')) {
      // 檢查是否是箭頭元素（通過檢查父元素是否有 data-arrow-id）
      const arrowGroup = e.target.closest('g[data-arrow-id]');
      if (arrowGroup) {
        e.preventDefault();
        e.stopPropagation();
        
        const arrowId = arrowGroup.getAttribute('data-arrow-id');
        const arrow = arrows.find(a => a.id === arrowId);
        if (arrow) {
          // 右鍵：顯示刪除選單
          if (e.button === 2 || (e.type === 'contextmenu')) {
            e.preventDefault();
            setArrowContextMenu({
              x: clientX,
              y: clientY,
              arrowId: arrow.id,
            });
            return;
          }
          
          // 左鍵：檢測點擊的是頭部圓點、尾部圓點還是線條
          const rect = e.currentTarget.getBoundingClientRect();
          const clickCanvasX = (clientX - rect.left - panOffset.x) / zoom;
          const clickCanvasY = (clientY - rect.top - panOffset.y) / zoom;
          
          if (e.target.tagName === 'circle') {
            // 點擊圓點：拖動對應的端點
            const cx = parseFloat(e.target.getAttribute('cx'));
            const cy = parseFloat(e.target.getAttribute('cy'));
            const isStart = Math.abs(cx - arrow.startX) < 1 && Math.abs(cy - arrow.startY) < 1;
            
            if (isStart) {
              setDraggingArrow(arrow.id);
              setDraggingArrowEnd('start');
              setSelectedArrow(arrow.id); // 選中箭頭
              setDragOffset({
                x: clickCanvasX - arrow.startX,
                y: clickCanvasY - arrow.startY,
              });
            } else {
              setDraggingArrow(arrow.id);
              setDraggingArrowEnd('end');
              setSelectedArrow(arrow.id); // 選中箭頭
              setDragOffset({
                x: clickCanvasX - arrow.endX,
                y: clickCanvasY - arrow.endY,
              });
            }
          } else {
            // 點擊線條：拖動整個箭頭
            const arrowCenterX = (arrow.startX + arrow.endX) / 2;
            const arrowCenterY = (arrow.startY + arrow.endY) / 2;
            setDraggingArrow(arrow.id);
            setDraggingArrowEnd(null);
            setSelectedArrow(arrow.id); // 選中箭頭
            setDragOffset({
              x: clickCanvasX - arrowCenterX,
              y: clickCanvasY - arrowCenterY,
            });
          }
          return;
        }
      }
      
      // 如果是其他 path（連接線），不處理背景點擊
      if (e.target.tagName === 'path') {
        return;
      }
    }
    
    // 如果點擊的是其他 SVG 元素，不處理背景點擊（只在非箭頭繪製模式下）
    if (!isDrawingArrow && (e.target.tagName === 'svg' || e.target.tagName === 'g')) {
      return;
    }

    // 點擊背景：清除箭頭選中狀態
    setSelectedArrow(null);
    
    // 記錄點擊位置，用於判斷是點擊還是拖動
    const rect = e.currentTarget.getBoundingClientRect();
    setClickStartPos({
      x: clientX,
      y: clientY,
      canvasX: (clientX - rect.left - panOffset.x) / zoom,
      canvasY: (clientY - rect.top - panOffset.y) / zoom,
    });

    e.preventDefault();
    editorSearchInputRef.current?.blur();
    setIsPanning(true);
    setPanStart({
      x: clientX - panOffset.x,
      y: clientY - panOffset.y,
    });
  };

  // 開始拖動文字方塊
  const handleTextBoxMouseDown = (e, textBox) => {
    if (e.target.closest(`.${styles.textBoxInput}`) || 
        e.target.closest(`.${styles.textBoxDeleteButton}`) ||
        e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA') {
      return;
    }
    
    e.stopPropagation();
    e.preventDefault();
    
    const { clientX, clientY } = getClientCoords(e);
    const canvasElement = e.currentTarget.closest(`.${styles.mindMapCanvas}`);
    const canvasRect = canvasElement.getBoundingClientRect();
    
    setDraggingTextBox(textBox.id);
    setDragOffset({
      x: clientX - canvasRect.left - textBox.x * zoom - panOffset.x,
      y: clientY - canvasRect.top - textBox.y * zoom - panOffset.y,
    });
  };

  // 開始拖動節點
  const handleNodeMouseDown = (e, node) => {
    // 如果點擊的是加號按鈕、刪除按鈕、插入按鈕或輸入框，不拖動
    if (e.target.closest(`.${styles.nodeAddButton}`) || 
        e.target.closest(`.${styles.nodeDeleteButton}`) || 
        e.target.closest(`.${styles.nodeLeftAction}`) ||
        e.target.closest(`.${styles.nodeInput}`) ||
        e.target.tagName === 'INPUT') {
      return;
    }
    
    e.stopPropagation();
    e.preventDefault();
    
    const { clientX, clientY } = getClientCoords(e);
    const canvasElement = e.currentTarget.closest(`.${styles.mindMapCanvas}`);
    const canvasRect = canvasElement.getBoundingClientRect();
    
    setDraggingNode(node.id);
    setDragOffset({
      x: clientX - canvasRect.left - node.x * zoom - panOffset.x,
      y: clientY - canvasRect.top - node.y * zoom - panOffset.y,
    });
  };

  // 獲取節點的父節點
  const getParentNode = (nodeId) => {
    const connection = connections.find(conn => conn.to === nodeId);
    if (connection) {
      return nodes.find(n => n.id === connection.from);
    }
    return null;
  };

  // 檢查節點是否只有一個子節點
  const hasOnlyOneChild = (nodeId) => {
    const childConnections = connections.filter(conn => conn.from === nodeId);
    return childConnections.length === 1;
  };

  // 磁鐵效果：當箭頭接近水平或垂直時自動對齊
  const snapToAxis = (fixedX, fixedY, movingX, movingY) => {
    const dx = movingX - fixedX;
    const dy = movingY - fixedY;
    const angle = Math.abs(Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI);
    
    // 磁鐵閾值：接近水平或垂直時（±5度內）
    const snapThreshold = 5;
    
    // 檢查是否接近水平（0度或180度）
    if (angle < snapThreshold || angle > 180 - snapThreshold) {
      // 水平對齊：保持 movingY 與 fixedY 相同
      return { x: movingX, y: fixedY };
    }
    
    // 檢查是否接近垂直（90度）
    if (Math.abs(angle - 90) < snapThreshold) {
      // 垂直對齊：保持 movingX 與 fixedX 相同
      return { x: fixedX, y: movingY };
    }
    
    return { x: movingX, y: movingY };
  };

  // 拖動處理（節點或背景）
  const handleMouseMove = (e) => {
    const { clientX, clientY } = getClientCoords(e);
    
    // 箭頭預覽：如果已選擇起始點，更新預覽終點（應用磁鐵效果）
    if (isDrawingArrow && arrowStart) {
      const canvasElement = e.currentTarget;
      const canvasRect = canvasElement.getBoundingClientRect();
      const canvasX = (clientX - canvasRect.left - panOffset.x) / zoom;
      const canvasY = (clientY - canvasRect.top - panOffset.y) / zoom;
      const snapped = snapToAxis(arrowStart.x, arrowStart.y, canvasX, canvasY);
      setArrowPreviewEnd({ x: snapped.x, y: snapped.y });
      return;
    }
    
    if (isPanning) {
      // 拖動背景
      const newPanOffset = {
        x: clientX - panStart.x,
        y: clientY - panStart.y,
      };
      setPanOffset(newPanOffset);
    } else if (draggingNode) {
      // 拖動節點（包括所有子節點）
      const canvasElement = e.currentTarget;
      const canvasRect = canvasElement.getBoundingClientRect();
      const rawX = (clientX - canvasRect.left - dragOffset.x - panOffset.x) / zoom;
      const rawY = (clientY - canvasRect.top - dragOffset.y - panOffset.y) / zoom;

      // 使用函數式更新確保使用最新的狀態
      setNodes(prevNodes => {
        const draggingNodeData = prevNodes.find(n => n.id === draggingNode);
        if (!draggingNodeData) return prevNodes;

        let finalX = rawX;
        let finalY = rawY;

        const snapThreshold = 10;

        // 磁鐵：拖動右邊方塊 → 對齊到左邊（父）的 Y
        const parentNode = getParentNode(draggingNode);
        if (parentNode && hasOnlyOneChild(parentNode.id)) {
          const parentCenterY = parentNode.y + parentNode.height / 2;
          const currentCenterY = rawY + draggingNodeData.height / 2;
          const verticalDistance = Math.abs(currentCenterY - parentCenterY);
          if (verticalDistance < snapThreshold) {
            finalY = parentCenterY - draggingNodeData.height / 2;
          }
        }

        // 磁鐵：拖動左邊方塊 → 對齊到右邊（唯一子節點）的 Y
        if (hasOnlyOneChild(draggingNode)) {
          const childNodes = getChildNodes(draggingNode);
          const onlyChild = childNodes[0];
          if (onlyChild) {
            const childCenterY = onlyChild.y + onlyChild.height / 2;
            const currentCenterY = rawY + draggingNodeData.height / 2;
            const verticalDistance = Math.abs(currentCenterY - childCenterY);
            if (verticalDistance < snapThreshold) {
              finalY = childCenterY - draggingNodeData.height / 2;
            }
          }
        }

        // 計算移動距離（基於原始位置和目標位置）
        const deltaX = finalX - draggingNodeData.x;
        const deltaY = finalY - draggingNodeData.y;

        // 獲取所有子節點 ID（遞迴）- 在函數式更新中直接查找，確保使用最新的 connections
        const findDescendants = (parentId) => {
          const descendants = new Set();
          const findChildren = (pid) => {
            const children = connections
              .filter(conn => conn.from === pid)
              .map(conn => conn.to);
            children.forEach(childId => {
              if (!descendants.has(childId)) {
                descendants.add(childId);
                findChildren(childId);
              }
            });
          };
          findChildren(parentId);
          return Array.from(descendants);
        };
        const descendantIds = findDescendants(draggingNode);
        const allMovingNodeIds = new Set([draggingNode, ...descendantIds]);

        // 先計算所有節點的新位置（包括父節點和所有子節點）
        let updatedNodes = prevNodes.map(node => {
          if (allMovingNodeIds.has(node.id)) {
            const newX = node.x + deltaX;
            const newY = node.y + deltaY;
            return { ...node, x: newX, y: newY };
          }
          return node;
        });

        // 對父節點進行邊界限制（子節點保持相對位置，不單獨限制）
        const updatedDraggingNode = updatedNodes.find(n => n.id === draggingNode);
        if (updatedDraggingNode) {
          const constrainedPos = constrainNodePosition(updatedDraggingNode, updatedDraggingNode.x, updatedDraggingNode.y);
          const constrainedDeltaX = constrainedPos.x - updatedDraggingNode.x;
          const constrainedDeltaY = constrainedPos.y - updatedDraggingNode.y;
          
          // 如果父節點被邊界限制，所有子節點也要應用相同的調整
          if (constrainedDeltaX !== 0 || constrainedDeltaY !== 0) {
            updatedNodes = updatedNodes.map(node => {
              if (allMovingNodeIds.has(node.id)) {
                return { ...node, x: node.x + constrainedDeltaX, y: node.y + constrainedDeltaY };
              }
              return node;
            });
          }
        }

        return updatedNodes;
      });
    } else if (draggingTextBox) {
      // 拖動文字方塊
      const canvasElement = e.currentTarget;
      const canvasRect = canvasElement.getBoundingClientRect();
      const rawX = (clientX - canvasRect.left - dragOffset.x - panOffset.x) / zoom;
      const rawY = (clientY - canvasRect.top - dragOffset.y - panOffset.y) / zoom;

      setTextBoxes(prevTextBoxes => {
        return prevTextBoxes.map(textBox => {
          if (textBox.id === draggingTextBox) {
            const constrainedPos = constrainNodePosition(textBox, rawX, rawY);
            return { ...textBox, x: constrainedPos.x, y: constrainedPos.y };
          }
          return textBox;
        });
      });
    } else if (draggingArrow) {
      // 拖動箭頭
      const canvasElement = e.currentTarget;
      const canvasRect = canvasElement.getBoundingClientRect();
      const currentCanvasX = (clientX - canvasRect.left - panOffset.x) / zoom;
      const currentCanvasY = (clientY - canvasRect.top - panOffset.y) / zoom;

      setArrows(prevArrows => {
        return prevArrows.map(arrow => {
          if (arrow.id === draggingArrow) {
            if (draggingArrowEnd === 'start') {
              // 只移動起始點（應用磁鐵效果，以終點為固定點）
              const rawX = currentCanvasX - dragOffset.x;
              const rawY = currentCanvasY - dragOffset.y;
              const snapped = snapToAxis(arrow.endX, arrow.endY, rawX, rawY);
              return {
                ...arrow,
                startX: snapped.x,
                startY: snapped.y,
              };
            } else if (draggingArrowEnd === 'end') {
              // 只移動終點（應用磁鐵效果，以起始點為固定點）
              const rawX = currentCanvasX - dragOffset.x;
              const rawY = currentCanvasY - dragOffset.y;
              const snapped = snapToAxis(arrow.startX, arrow.startY, rawX, rawY);
              return {
                ...arrow,
                endX: snapped.x,
                endY: snapped.y,
              };
            } else {
              // 移動整個箭頭（不需要磁鐵效果）
              const newCenterX = currentCanvasX - dragOffset.x;
              const newCenterY = currentCanvasY - dragOffset.y;
              const oldCenterX = (arrow.startX + arrow.endX) / 2;
              const oldCenterY = (arrow.startY + arrow.endY) / 2;
              const deltaX = newCenterX - oldCenterX;
              const deltaY = newCenterY - oldCenterY;
              
              return {
                ...arrow,
                startX: arrow.startX + deltaX,
                startY: arrow.startY + deltaY,
                endX: arrow.endX + deltaX,
                endY: arrow.endY + deltaY,
              };
            }
          }
          return arrow;
        });
      });
    }
  };

  // 結束拖動
  const handleMouseUp = (e) => {
    const coords = e ? getClientCoords(e) : null;
    
    // 箭頭模式下不處理拖動結束
    if (isDrawingArrow) {
      return;
    }
    
    if (draggingNode) {
      // 對齊同層級的節點
      let updatedNodes = [...nodes];
      updatedNodes = alignSiblingNodes(draggingNode, updatedNodes);
      
      // 自動分離重疊的節點
      updatedNodes = separateOverlappingNodes(updatedNodes);
      
      setNodes(updatedNodes);
      saveToFirebase(updatedNodes, connections, textBoxes, arrows);
      setDraggingNode(null);
    }
    
    if (draggingTextBox) {
      saveToFirebase(nodes, connections, textBoxes, arrows);
      setDraggingTextBox(null);
    }
    
    if (draggingArrow) {
      saveToFirebase(nodes, connections, textBoxes, arrows);
      setDraggingArrow(null);
      setDraggingArrowEnd(null);
    }
    
    if (isPanning && clickStartPos && coords) {
      // 判斷是點擊還是拖動（移動距離小於 5px 視為點擊）
      const moveDistance = Math.sqrt(
        Math.pow(coords.clientX - clickStartPos.x, 2) + 
        Math.pow(coords.clientY - clickStartPos.y, 2)
      );
      
      if (moveDistance < 5) {
        // 這是點擊
        if (editingNode) {
          // 如果正在編輯節點，結束編輯
          handleNodeTextBlur();
        }
        if (editingTextBox) {
          // 如果正在編輯文字方塊，結束編輯
          handleTextBoxTextBlur();
        }
        // 移除點擊背景創建新節點的功能
      }
      
      setClickStartPos(null);
      setIsPanning(false);
    } else if (isPanning) {
      setIsPanning(false);
      setClickStartPos(null);
    }
  };

  // 編輯文字方塊
  const handleTextBoxDoubleClick = (textBox) => {
    setEditingTextBox(textBox.id);
  };

  // 計算文字方塊寬度（根據文字內容）
  const calculateTextBoxWidth = (text) => {
    const charWidth = 16; // 字體大小 16px，每個字符約 16px 寬
    const padding = 16;
    const maxCharsPerLine = 15;
    
    // 固定寬度為15個字的寬度（允許自動換行）
    return maxCharsPerLine * charWidth + padding;
  };

  // 保存文字方塊編輯
  const handleTextBoxTextChange = (textBoxId, text) => {
    const updatedTextBoxes = textBoxes.map(tb => {
      if (tb.id === textBoxId) {
        const newWidth = calculateTextBoxWidth(text);
        return { ...tb, text, width: newWidth };
      }
      return tb;
    });
    setTextBoxes(updatedTextBoxes);
    saveToFirebase(nodes, connections, updatedTextBoxes, arrows);
  };

  // 完成文字方塊編輯
  const handleTextBoxTextBlur = () => {
    if (!editingTextBox) return;
    const currentTextBox = textBoxes.find(tb => tb.id === editingTextBox);
    if (currentTextBox && (!currentTextBox.text || currentTextBox.text.trim() === '')) {
      handleDeleteTextBox(editingTextBox);
      setEditingTextBox(null);
      return;
    }
    // 確保寬度是最新的
    if (currentTextBox) {
      const newWidth = calculateTextBoxWidth(currentTextBox.text);
      if (newWidth !== currentTextBox.width) {
        const updatedTextBoxes = textBoxes.map(tb =>
          tb.id === editingTextBox ? { ...tb, width: newWidth } : tb
        );
        setTextBoxes(updatedTextBoxes);
        saveToFirebase(nodes, connections, updatedTextBoxes, arrows);
      }
    }
    setEditingTextBox(null);
  };

  // 刪除箭頭
  const handleDeleteArrow = (arrowId) => {
    const updatedArrows = arrows.filter(a => a.id !== arrowId);
    setArrows(updatedArrows);
    saveToFirebase(nodes, connections, textBoxes, updatedArrows);
    setArrowContextMenu(null);
  };

  // 刪除文字方塊
  const handleDeleteTextBox = (textBoxId) => {
    const updatedTextBoxes = textBoxes.filter(tb => tb.id !== textBoxId);
    setTextBoxes(updatedTextBoxes);
    saveToFirebase(nodes, connections, updatedTextBoxes, arrows);
    if (editingTextBox === textBoxId) {
      setEditingTextBox(null);
    }
  };

  // 編輯節點文字
  const handleNodeDoubleClick = (node) => {
    setEditingNode(node.id);
  };

  // 保存節點編輯
  const handleNodeTextChange = (nodeId, text) => {
    const updatedNodes = nodes.map(node =>
      node.id === nodeId ? { ...node, text } : node
    );
    setNodes(updatedNodes);
    saveToFirebase(updatedNodes, connections, textBoxes, arrows);
  };

  // 完成編輯
  const handleNodeTextBlur = () => {
    if (editingNode) {
      // 確保最終寬度正確
      const editingNodeData = nodes.find(n => n.id === editingNode);
      if (editingNodeData) {
        const finalWidth = calculateNodeWidth(editingNodeData.text);
        const updatedNodes = nodes.map(node =>
          node.id === editingNode ? { ...node, width: finalWidth } : node
        );
        setNodes(updatedNodes);
        saveToFirebase(updatedNodes, connections, textBoxes, arrows);
      }
    }
    setEditingNode(null);
  };

  // 刪除節點（只刪此格，子節點改連到上一層父節點，保留不刪）
  const handleDeleteNode = (nodeId) => {
    const parentConn = connections.find(conn => conn.to === nodeId);
    const parentId = parentConn ? parentConn.from : null;
    const directChildConns = connections.filter(conn => conn.from === nodeId);

    // 只刪除這個節點
    const updatedNodes = nodes.filter(node => node.id !== nodeId);

    // 移除「進出此節點」的連接
    let updatedConnections = connections.filter(
      conn => conn.from !== nodeId && conn.to !== nodeId
    );

    // 子節點改連到父節點（若無父節點則子節點變成獨立根，不補連接）
    directChildConns.forEach(conn => {
      if (parentId !== null) {
        updatedConnections.push({
          id: uuidv4(),
          from: parentId,
          to: conn.to,
          direction: conn.direction || 'right',
        });
      }
    });

    setNodes(updatedNodes);
    setConnections(updatedConnections);
    saveToFirebase(updatedNodes, updatedConnections, textBoxes, arrows);

    if (editingNode === nodeId) {
      setEditingNode(null);
    }
  };

  // 在節點前插入新節點（有父節點：在父→此節點之間插入；無父節點：在左側創建獨立節點）
  const handleInsertBeforeNode = (targetNode) => {
    const parentNode = getParentNode(targetNode.id);
    const spacing = 56;
    const newWidth = calculateNodeWidth('新節點');

    if (parentNode) {
      // 有父節點：在「父節點 → 此子節點」之間插入新節點
      const newX = parentNode.x + parentNode.width + spacing;
      const newY = targetNode.y;

      const newNode = {
        id: uuidv4(),
        text: '新節點',
        x: newX,
        y: newY,
        width: newWidth,
        height: 28,
      };

      const descendantIds = getAllDescendants(targetNode.id);
      const moveIds = new Set([targetNode.id, ...descendantIds]);
      const shift = spacing + newWidth;

      const updatedNodes = nodes.map(node =>
        moveIds.has(node.id) ? { ...node, x: node.x + shift } : node
      );
      updatedNodes.push(newNode);

      const connToChild = connections.find(conn => conn.from === parentNode.id && conn.to === targetNode.id);
      const updatedConnections = connections.filter(
        conn => !(conn.from === parentNode.id && conn.to === targetNode.id)
      );
      updatedConnections.push(
        { id: uuidv4(), from: parentNode.id, to: newNode.id, direction: 'right' },
        { id: uuidv4(), from: newNode.id, to: targetNode.id, direction: connToChild?.direction || 'right' }
      );

      setNodes(updatedNodes);
      setConnections(updatedConnections);
      saveToFirebase(updatedNodes, updatedConnections, textBoxes, arrows);
      setEditingNode(newNode.id);
    } else {
      // 無父節點：在該節點左側創建新節點，並與右側節點相連
      const newX = targetNode.x - spacing - newWidth;
      const newY = targetNode.y;

      const newNode = {
        id: uuidv4(),
        text: '新節點',
        x: newX,
        y: newY,
        width: newWidth,
        height: 28,
      };

      const newConnection = {
        id: uuidv4(),
        from: newNode.id,
        to: targetNode.id,
        direction: 'right',
      };

      const updatedNodes = [...nodes, newNode];
      const updatedConnections = [...connections, newConnection];
      setNodes(updatedNodes);
      setConnections(updatedConnections);
      saveToFirebase(updatedNodes, updatedConnections, textBoxes, arrows);
      setEditingNode(newNode.id);
    }
  };

  // 啟動箭頭繪製模式
  const handleStartArrowDrawing = () => {
    setIsDrawingArrow(true);
    setArrowStart(null);
    setArrowPreviewEnd(null);
  };

  // 取消箭頭繪製模式
  const handleCancelArrowDrawing = () => {
    setIsDrawingArrow(false);
    setArrowStart(null);
    setArrowPreviewEnd(null);
  };

  // 在螢幕正中央新增文字方塊
  const handleAddTextBox = () => {
    const canvasElement = document.querySelector(`.${styles.mindMapCanvas}`);
    if (!canvasElement) return;

    const rect = canvasElement.getBoundingClientRect();
    const screenCenterX = window.innerWidth / 2;
    const screenCenterY = window.innerHeight / 2;
    
    const canvasX = (screenCenterX - rect.left - panOffset.x) / zoom;
    const canvasY = (screenCenterY - rect.top - panOffset.y) / zoom;
    
    // 計算寬度：15個字 × 16px + padding 16px = 256px
    const charWidth = 16;
    const padding = 16;
    const textBoxWidth = 15 * charWidth + padding;
    
    const newTextBox = {
      id: uuidv4(),
      text: '',
      x: canvasX - textBoxWidth / 2,
      y: canvasY - 14,
      width: textBoxWidth,
      height: 28,
    };

    const updatedTextBoxes = [...textBoxes, newTextBox];
    setTextBoxes(updatedTextBoxes);
    saveToFirebase(nodes, connections, updatedTextBoxes, arrows);
    setEditingTextBox(newTextBox.id);
  };

  // 在螢幕正中央新增節點
  const handleAddNodeAtCenter = () => {
    const canvasElement = document.querySelector(`.${styles.mindMapCanvas}`);
    if (!canvasElement) return;

    const nodeWidth = 120;
    const nodeHeight = 28;

    // 計算畫布在視窗中的位置
    const rect = canvasElement.getBoundingClientRect();
    
    // 螢幕正中央的位置（視窗座標）
    const screenCenterX = window.innerWidth / 2;
    const screenCenterY = window.innerHeight / 2;
    
    // 轉換為畫布座標系（考慮 zoom 和 panOffset）
    const canvasX = (screenCenterX - rect.left - panOffset.x) / zoom;
    const canvasY = (screenCenterY - rect.top - panOffset.y) / zoom;
    
    // 節點中心對齊到螢幕中心
    const newX = canvasX - nodeWidth / 2;
    const newY = canvasY - nodeHeight / 2;

    // 限制在邊界內
    const tempNode = { width: nodeWidth, height: nodeHeight };
    const constrainedPos = constrainNodePosition(tempNode, newX, newY);

    const newNode = {
      id: uuidv4(),
      text: '新節點',
      x: constrainedPos.x,
      y: constrainedPos.y,
      width: calculateNodeWidth('新節點'),
      height: nodeHeight,
    };

    const updatedNodes = [...nodes, newNode];
    setNodes(updatedNodes);
    saveToFirebase(updatedNodes, connections, textBoxes, arrows);
    setEditingNode(newNode.id);
  };


  // 處理滑鼠滾輪縮放
  const handleWheel = (e) => {
    e.preventDefault();
    
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newZoom = Math.max(0.5, Math.min(3, zoom + delta));
    
    // 以滑鼠位置為縮放中心點
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // 計算縮放中心相對於畫布的座標
    const scalePointX = (mouseX - panOffset.x) / zoom;
    const scalePointY = (mouseY - panOffset.y) / zoom;
    
    // 調整 pan offset 以保持滑鼠位置不變
    const newPanX = mouseX - scalePointX * newZoom;
    const newPanY = mouseY - scalePointY * newZoom;
    
    setZoom(newZoom);
    setPanOffset({ x: newPanX, y: newPanY });
  };

  // 觸控：開始（雙指縮放）
  const handleTouchStart = (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const distance = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const centerClientX = (t0.clientX + t1.clientX) / 2;
      const centerClientY = (t0.clientY + t1.clientY) / 2;
      const { zoom: z, panX: px, panY: py } = zoomPanRef.current;
      pinchStartRef.current = {
        distance,
        centerX: centerClientX - rect.left,
        centerY: centerClientY - rect.top,
        zoom: z,
        panX: px,
        panY: py,
      };
      return;
    }
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const syn = {
        ...e,
        clientX: t.clientX,
        clientY: t.clientY,
        target: e.target,
        currentTarget: e.currentTarget,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
      };
      const nodeEl = e.target.closest(`.${styles.node}`);
      if (nodeEl && !e.target.closest(`.${styles.nodeAddButton}`) && !e.target.closest(`.${styles.nodeDeleteButton}`) && !e.target.closest(`.${styles.nodeLeftAction}`)) {
        const nodeId = nodeEl.getAttribute('data-node-id');
        const node = nodes.find(n => n.id === nodeId);
        if (node) {
          e.preventDefault();
          handleNodeMouseDown(syn, node);
        }
      } else {
        handleCanvasMouseDown(syn);
      }
    }
  };

  // 觸控：移動（雙指縮放僅在 document 的 touchmove 更新，避免重複 setState 造成跳動）
  const handleTouchMove = (e) => {
    if (e.touches.length === 2 && pinchStartRef.current) {
      e.preventDefault();
      return;
    }
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const syn = {
        ...e,
        clientX: t.clientX,
        clientY: t.clientY,
        currentTarget: e.currentTarget,
      };
      handleMouseMove(syn);
    }
  };

  // 觸控：結束
  const handleTouchEnd = (e) => {
    if (e.touches.length === 0) {
      pinchStartRef.current = null;
      if (e.changedTouches && e.changedTouches[0]) {
        handleMouseUp({
          clientX: e.changedTouches[0].clientX,
          clientY: e.changedTouches[0].clientY,
        });
      } else {
        handleMouseUp(null);
      }
    } else if (e.touches.length === 1) {
      pinchStartRef.current = null;
    }
  };

  // 全域觸控移動/結束（手指移出畫布時仍要收到事件）
  useEffect(() => {
    const onTouchMove = (e) => {
      const canvas = canvasRef.current;
      if (e.touches.length === 1 && (isPanning || draggingNode) && canvas) {
        e.preventDefault();
        const t = e.touches[0];
        handleMouseMove({ ...e, currentTarget: canvas, touches: [t], clientX: t.clientX, clientY: t.clientY });
      } else if (e.touches.length === 2 && pinchStartRef.current && canvas) {
          e.preventDefault();
          const start = pinchStartRef.current;
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          const newDistance = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
          const scale = newDistance / start.distance;
          const newZoom = Math.max(0.5, Math.min(3, start.zoom * scale));
          const contentX = (start.centerX - start.panX) / start.zoom;
          const contentY = (start.centerY - start.panY) / start.zoom;
          const newPanX = start.centerX - contentX * newZoom;
          const newPanY = start.centerY - contentY * newZoom;
          setZoom(newZoom);
          setPanOffset({ x: newPanX, y: newPanY });
      }
    };
    const onTouchEnd = (e) => {
      if (e.touches.length === 0) {
        handleTouchEnd(e);
      }
    };
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [isPanning, draggingNode]);

  // 關閉箭頭右鍵選單
  useEffect(() => {
    const handleClick = () => {
      setArrowContextMenu(null);
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('contextmenu', handleClick);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('contextmenu', handleClick);
    };
  }, []);

  return (
    <div className={styles.mindMapContainer}>
      <div className={styles.editorSearchContainer}>
        <input
          ref={editorSearchInputRef}
          type="text"
          placeholder="搜尋節點..."
          value={nodeSearchQuery}
          onChange={(e) => setNodeSearchQuery(e.target.value)}
          className={styles.editorSearchInput}
        />
      </div>
      <div
        className={styles.mindMapCanvas}
        ref={(el) => {
          canvasRef.current = el;
          if (el && canvasSize.width === 0) {
            setTimeout(() => {
              if (el) setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
            }, 0);
          }
        }}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          cursor: isDrawingArrow ? 'crosshair' : (isPanning ? 'grabbing' : 'default'),
        }}
      >
        {/* 節點和連接線容器（應用 pan 和 zoom transform） */}
        <div
          className={styles.nodesContainer}
          style={{
            transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
          }}
        >
          {/* SVG 用於繪製連接線 */}
          <svg className={styles.connectionsLayer} style={{ pointerEvents: 'none' }}>
            {(() => {
              // 按父節點分組連接
              const connectionsByParent = {};
              connections.forEach(conn => {
                if (!connectionsByParent[conn.from]) {
                  connectionsByParent[conn.from] = [];
                }
                connectionsByParent[conn.from].push(conn);
              });

              const paths = [];

              // 為每個父節點繪製連接線
              Object.keys(connectionsByParent).forEach(parentId => {
                const parentNode = nodes.find(n => n.id === parentId);
                if (!parentNode) return;

                const childConnections = connectionsByParent[parentId];
                if (childConnections.length === 0) return;

                // 獲取所有子節點
                const childNodes = childConnections
                  .map(conn => {
                    const node = nodes.find(n => n.id === conn.to);
                    return node ? { ...node, connectionId: conn.id } : null;
                  })
                  .filter(Boolean)
                  .sort((a, b) => a.y - b.y); // 按 y 座標排序

                if (childNodes.length === 0) return;

                // 計算主線的起點和終點
                const mainLineStartX = parentNode.x + parentNode.width;
                const mainLineStartY = parentNode.y + parentNode.height / 2;
                
                // 主線延伸到最左側子節點的 x 位置（稍微往左一點）
                const minChildX = Math.min(...childNodes.map(n => n.x));
                const mainLineEndX = minChildX - 20; // 主線延伸到子節點左側 20px
                
                // 計算主線的 y 範圍（涵蓋所有子節點）
                const minY = Math.min(...childNodes.map(n => n.y + n.height / 2));
                const maxY = Math.max(...childNodes.map(n => n.y + n.height / 2));
                const mainLineY = (minY + maxY) / 2; // 主線在子節點中間

                // 繪製主線（從父節點到主線位置，使用直線）
                paths.push(
                  <path
                    key={`main-${parentId}`}
                    d={`M ${mainLineStartX} ${mainLineStartY} L ${mainLineEndX} ${mainLineStartY} L ${mainLineEndX} ${mainLineY}`}
                    className={styles.connectionLine}
                    strokeWidth="2"
                    fill="none"
                  />
                );

                // 為每個子節點繪製分支線（使用直線）
                childNodes.forEach(childNode => {
                  const branchStartX = mainLineEndX;
                  const branchStartY = mainLineY;
                  const branchEndX = childNode.x;
                  const branchEndY = childNode.y + childNode.height / 2;

                  paths.push(
                    <path
                      key={`branch-${childNode.connectionId}`}
                      d={`M ${branchStartX} ${branchStartY} L ${branchStartX} ${branchEndY} L ${branchEndX} ${branchEndY}`}
                      className={styles.connectionLine}
                      strokeWidth="2"
                      fill="none"
                    />
                  );
                });
              });

              return paths;
            })()}
          </svg>
          {nodes.map(node => {
              const matchesSearch = nodeSearchQuery.trim() && node.text.toLowerCase().includes(nodeSearchQuery.trim().toLowerCase());
              return (
            <div
              key={node.id}
              className={`${styles.node} ${matchesSearch ? styles.nodeSearchHighlight : ''}`}
              data-node-id={node.id}
              style={{
                left: `${node.x}px`,
                top: `${node.y}px`,
                width: `${node.width}px`,
              }}
              onMouseDown={(e) => handleNodeMouseDown(e, node)}
              onDoubleClick={() => handleNodeDoubleClick(node)}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
            >
            {hoveredNode === node.id && (
              <>
                <div className={styles.nodeLeftAction}>
                  <button
                    type="button"
                    className={styles.nodeInsertBeforeButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleInsertBeforeNode(node);
                    }}
                    title={getParentNode(node.id) ? "在此節點前插入" : "在左側新增節點"}
                  >
                    ◀
                  </button>
                </div>
                <div className={styles.nodeActions}>
                  <button
                    className={styles.nodeAddButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddChildNode(node);
                    }}
                    title="新增子節點"
                  >
                    +
                  </button>
                  <button
                    className={styles.nodeDeleteButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteNode(node.id);
                    }}
                    title="刪除節點"
                  >
                    ✕
                  </button>
                </div>
              </>
            )}
            {editingNode === node.id ? (
              <input
                type="text"
                value={node.text}
                onChange={(e) => handleNodeTextChange(node.id, e.target.value)}
                onBlur={handleNodeTextBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                  }
                  e.stopPropagation();
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                }}
                onSelect={(e) => {
                  e.stopPropagation();
                }}
                className={styles.nodeInput}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div
                className={`${styles.nodeText} ${node.text.length < 15 ? styles.nodeTextNoWrap : ''}`}
              >
                {node.text.length > 15 
                  ? (() => {
                      const lines = [];
                      for (let i = 0; i < node.text.length; i += 15) {
                        lines.push(node.text.substring(i, i + 15));
                      }
                      return lines.join('\n');
                    })()
                  : node.text}
              </div>
            )}
            </div>
          );
          })}
          {/* 渲染文字方塊 */}
          {textBoxes.map(textBox => (
            <div
              key={textBox.id}
              className={styles.textBox}
              style={{
                left: `${textBox.x}px`,
                top: `${textBox.y}px`,
                width: `${textBox.width}px`,
              }}
              onMouseDown={(e) => handleTextBoxMouseDown(e, textBox)}
              onDoubleClick={() => handleTextBoxDoubleClick(textBox)}
              onMouseEnter={() => setHoveredTextBox(textBox.id)}
              onMouseLeave={() => setHoveredTextBox(null)}
            >
              {hoveredTextBox === textBox.id && !editingTextBox && (
                <button
                  className={styles.textBoxDeleteButton}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteTextBox(textBox.id);
                  }}
                  title="刪除文字方塊"
                >
                  ✕
                </button>
              )}
              {editingTextBox === textBox.id ? (
                <textarea
                  value={textBox.text}
                  onChange={(e) => handleTextBoxTextChange(textBox.id, e.target.value)}
                  onBlur={handleTextBoxTextBlur}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      handleTextBoxTextBlur();
                    }
                    e.stopPropagation();
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                  }}
                  className={styles.textBoxInput}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div className={styles.textBoxText}>
                  {textBox.text ? (() => {
                    const lines = textBox.text.split('\n');
                    const result = [];
                    lines.forEach((line) => {
                      if (line.length > 15) {
                        for (let i = 0; i < line.length; i += 15) {
                          result.push(line.substring(i, i + 15));
                        }
                      } else {
                        result.push(line);
                      }
                    });
                    return result.map((line, i) => (
                      <div key={i}>{line || '\u00A0'}</div>
                    ));
                  })() : '\u00A0'}
                </div>
              )}
            </div>
          ))}
          {/* 繪製箭頭 - 移到最後渲染，確保顯示在文字方塊之上 */}
          <svg className={styles.connectionsLayer} style={{ pointerEvents: 'none' }}>
            {arrows.map(arrow => {
              const dx = arrow.endX - arrow.startX;
              const dy = arrow.endY - arrow.startY;
              const angle = Math.atan2(dy, dx);
              const arrowLength = 10;
              const arrowWidth = 6;
              
              // 箭頭終點位置（稍微往內縮一點，避免重疊）
              const endX = arrow.endX - Math.cos(angle) * 5;
              const endY = arrow.endY - Math.sin(angle) * 5;
              
              // 箭頭兩個邊的終點
              const arrowPoint1X = endX - arrowLength * Math.cos(angle - Math.PI / 6);
              const arrowPoint1Y = endY - arrowLength * Math.sin(angle - Math.PI / 6);
              const arrowPoint2X = endX - arrowLength * Math.cos(angle + Math.PI / 6);
              const arrowPoint2Y = endY - arrowLength * Math.sin(angle + Math.PI / 6);
              
              return (
                <g 
                  key={arrow.id}
                  data-arrow-id={arrow.id}
                  style={{ cursor: 'move', pointerEvents: 'all' }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setArrowContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      arrowId: arrow.id,
                    });
                  }}
                >
                  <path
                    d={`M ${arrow.startX} ${arrow.startY} L ${endX} ${endY}`}
                    className={styles.arrowLine}
                    strokeWidth="2"
                    fill="none"
                    style={{ cursor: 'move', pointerEvents: 'stroke' }}
                  />
                  <path
                    d={`M ${endX} ${endY} L ${arrowPoint1X} ${arrowPoint1Y} L ${arrowPoint2X} ${arrowPoint2Y} Z`}
                    className={styles.arrowHead}
                    strokeWidth="2"
                  />
                  {/* 不可見的更大點擊區域 - 用於更容易點擊線條（放在最上層） */}
                  <path
                    d={`M ${arrow.startX} ${arrow.startY} L ${endX} ${endY}`}
                    stroke="transparent"
                    strokeWidth="12"
                    fill="none"
                    style={{ cursor: 'move', pointerEvents: 'stroke' }}
                  />
                  {/* 起始點圓點 - 只在選中時顯示 */}
                  {selectedArrow === arrow.id && (
                    <>
                      {/* 不可見的更大點擊區域 */}
                      <circle
                        cx={arrow.startX}
                        cy={arrow.startY}
                        r="12"
                        fill="transparent"
                        stroke="transparent"
                        style={{ cursor: 'grab', pointerEvents: 'all' }}
                      />
                      {/* 可見的圓點 */}
                      <circle
                        cx={arrow.startX}
                        cy={arrow.startY}
                        r="6"
                        className={styles.arrowHandle}
                        style={{ cursor: 'grab' }}
                      />
                    </>
                  )}
                  {/* 終點圓點 - 只在選中時顯示 */}
                  {selectedArrow === arrow.id && (
                    <>
                      {/* 不可見的更大點擊區域 */}
                      <circle
                        cx={arrow.endX}
                        cy={arrow.endY}
                        r="12"
                        fill="transparent"
                        stroke="transparent"
                        style={{ cursor: 'grab', pointerEvents: 'all' }}
                      />
                      {/* 可見的圓點 */}
                      <circle
                        cx={arrow.endX}
                        cy={arrow.endY}
                        r="6"
                        className={styles.arrowHandle}
                        style={{ cursor: 'grab' }}
                      />
                    </>
                  )}
                </g>
              );
            })}
            {/* 繪製預覽箭頭（選擇起始點後） */}
            {isDrawingArrow && arrowStart && arrowPreviewEnd && (
              <g>
                <path
                  d={`M ${arrowStart.x} ${arrowStart.y} L ${arrowPreviewEnd.x} ${arrowPreviewEnd.y}`}
                  className={styles.arrowPreviewLine}
                  strokeWidth="2"
                  fill="none"
                  strokeDasharray="5,5"
                />
                {(() => {
                  const dx = arrowPreviewEnd.x - arrowStart.x;
                  const dy = arrowPreviewEnd.y - arrowStart.y;
                  const angle = Math.atan2(dy, dx);
                  const arrowLength = 10;
                  const endX = arrowPreviewEnd.x;
                  const endY = arrowPreviewEnd.y;
                  const arrowPoint1X = endX - arrowLength * Math.cos(angle - Math.PI / 6);
                  const arrowPoint1Y = endY - arrowLength * Math.sin(angle - Math.PI / 6);
                  const arrowPoint2X = endX - arrowLength * Math.cos(angle + Math.PI / 6);
                  const arrowPoint2Y = endY - arrowLength * Math.sin(angle + Math.PI / 6);
                  return (
                    <path
                      d={`M ${endX} ${endY} L ${arrowPoint1X} ${arrowPoint1Y} L ${arrowPoint2X} ${arrowPoint2Y} Z`}
                      className={styles.arrowPreviewHead}
                      strokeWidth="2"
                    />
                  );
                })()}
              </g>
            )}
          </svg>
        </div>
      </div>

      {/* 箭頭右鍵選單 */}
      {arrowContextMenu && (
        <div
          className={styles.contextMenu}
          style={{
            position: 'fixed',
            left: `${arrowContextMenu.x}px`,
            top: `${arrowContextMenu.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className={styles.contextMenuItem}
            onClick={() => handleDeleteArrow(arrowContextMenu.arrowId)}
          >
            刪除箭頭
          </button>
        </div>
      )}

      {/* 懸浮按鈕組 */}
      <div className={styles.floatingActions}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (isDrawingArrow) {
              handleCancelArrowDrawing();
            } else {
              handleStartArrowDrawing();
            }
          }}
          className={`${styles.floatingButton} ${isDrawingArrow ? styles.activeFloatingButton : ''}`}
          title={isDrawingArrow ? "取消箭頭模式" : "繪製箭頭"}
        >
          ↗
        </button>
        <button
          onClick={handleAddTextBox}
          className={styles.floatingButton}
          title="新增文字方塊"
        >
          T
        </button>
        <button
          onClick={handleAddNodeAtCenter}
          className={styles.floatingButton}
          title="新增區塊"
        >
          +
        </button>
        <button
          onClick={onBack}
          className={`${styles.floatingButton} ${styles.backFloatingButton}`}
          title="返回"
        >
          ←
        </button>
      </div>
    </div>
  );
}

// 檔案列表組件
export function MindMapList() {
  const [mindMaps, setMindMaps] = useState([]);
  const [selectedMindMap, setSelectedMindMap] = useState(null);
  const [newMindMapName, setNewMindMapName] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // 從 Firebase 載入檔案列表
  useEffect(() => {
    const unsubscribe = onSnapshot(MINDMAP_DOC_REF, (docSnapshot) => {
      if (docSnapshot.exists()) {
        const data = docSnapshot.data();
        setMindMaps(data.mindMaps || []);
      } else {
        setMindMaps([]);
      }
    }, (error) => {
      console.error('Firestore 監聽失敗:', error);
    });

    return () => unsubscribe();
  }, []);

  // 新增心智圖檔案
  const handleCreateMindMap = async () => {
    if (!newMindMapName.trim()) {
      alert('請輸入檔案名稱！');
      return;
    }

    const newMindMap = {
      id: uuidv4(),
      name: newMindMapName.trim(),
      createdAt: Date.now(),
    };

    const updatedMindMaps = [...mindMaps, newMindMap];
    await setDoc(MINDMAP_DOC_REF, { mindMaps: updatedMindMaps });
    
    setNewMindMapName('');
    setShowNewForm(false);
  };

  // 刪除心智圖檔案
  const handleDeleteMindMap = async (id) => {
    if (window.confirm('確定要刪除此檔案嗎？')) {
      const updatedMindMaps = mindMaps.filter(map => map.id !== id);
      await setDoc(MINDMAP_DOC_REF, { mindMaps: updatedMindMaps });
    }
    setContextMenu(null);
  };

  // 處理右鍵選單
  const handleContextMenu = (e, mindMapId) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      mindMapId,
    });
  };

  // 關閉右鍵選單
  useEffect(() => {
    const handleClick = () => {
      setContextMenu(null);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  if (selectedMindMap) {
    return (
      <MindMapComponent
        mindMapId={selectedMindMap.id}
        onBack={() => setSelectedMindMap(null)}
        onDelete={() => {
          handleDeleteMindMap(selectedMindMap.id);
          setSelectedMindMap(null);
        }}
      />
    );
  }

  // 過濾檔案列表
  const filteredMindMaps = mindMaps.filter(mindMap =>
    mindMap.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className={styles.mindMapListContainer}>
      <h2 className={styles.listTitle}>心智圖檔案</h2>
      
      <div className={styles.searchContainer}>
        <input
          type="text"
          placeholder="搜尋檔案..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className={styles.searchInput}
        />
      </div>
      
      <div className={styles.mindMapList}>
        {filteredMindMaps.length === 0 ? (
          <div className={styles.emptyState}>
            {searchQuery ? '找不到符合的檔案' : '尚無檔案'}
          </div>
        ) : (
          filteredMindMaps.map(mindMap => (
            <div
              key={mindMap.id}
              className={styles.mindMapItem}
              onContextMenu={(e) => handleContextMenu(e, mindMap.id)}
            >
              <a
                href="#"
                className={styles.mindMapLink}
                onClick={(e) => {
                  e.preventDefault();
                  setSelectedMindMap(mindMap);
                }}
              >
                {mindMap.name}
              </a>
            </div>
          ))
        )}
      </div>

      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{
            position: 'fixed',
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className={styles.contextMenuItem}
            onClick={() => handleDeleteMindMap(contextMenu.mindMapId)}
          >
            刪除
          </button>
        </div>
      )}

      {showNewForm ? (
        <div className={styles.newMindMapForm}>
          <input
            type="text"
            placeholder="輸入檔案名稱..."
            value={newMindMapName}
            onChange={(e) => setNewMindMapName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setShowNewForm(false);
                setNewMindMapName('');
              }
            }}
            className={styles.newMindMapInput}
            autoFocus
          />
          <div className={styles.newMindMapActions}>
            <button onClick={handleCreateMindMap} className={styles.createButton}>
              建立
            </button>
            <button
              onClick={() => {
                setShowNewForm(false);
                setNewMindMapName('');
              }}
              className={styles.cancelButton}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowNewForm(true)}
          className={styles.addButton}
          title="新增檔案"
        >
          +
        </button>
      )}
    </div>
  );
}

export default MindMapList;
