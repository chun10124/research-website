import React, { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { setDoc, onSnapshot, doc } from 'firebase/firestore';
import { MINDMAP_DOC_REF, db } from '../utils/firebaseConfig';
import styles from './MindMap.module.css';

function MindMapComponent({ mindMapId, onBack, onDelete }) {
  const [nodes, setNodes] = useState([]);
  const [connections, setConnections] = useState([]);
  const [editingNode, setEditingNode] = useState(null);
  const [draggingNode, setDraggingNode] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [hoveredNode, setHoveredNode] = useState(null);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [clickStartPos, setClickStartPos] = useState(null);
  const [hasAutoCentered, setHasAutoCentered] = useState(false);

  // 邊界距離（px）
  const BOUNDARY_MARGIN = 20;

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
        setNodes(data.nodes || []);
        setConnections(data.connections || []);
      } else {
        // 初始化新心智圖（從最左邊開始）
        const initialNode = {
          id: uuidv4(),
          text: '中心主題',
          x: 100,
          y: 300,
          width: 120,
          height: 45,
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
  const saveToFirebase = async (nodesToSave, connectionsToSave) => {
    if (!mindMapId) return;
    try {
      const docRef = doc(db, `mindmaps`, mindMapId);
      await setDoc(docRef, {
        nodes: nodesToSave,
        connections: connectionsToSave,
        updatedAt: Date.now(),
      });
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

  // 計算節點寬度（根據文字內容）
  const calculateNodeWidth = (text) => {
    const minWidth = 120;
    const maxWidth = 400;
    const charWidth = 8; // 每個字符大約的寬度
    const padding = 24; // 左右 padding
    
    // 計算文字寬度
    const textWidth = text.length * charWidth;
    const calculatedWidth = Math.max(minWidth, Math.min(maxWidth, textWidth + padding));
    
    return calculatedWidth;
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

  // 自動分離重疊的節點
  const separateOverlappingNodes = (nodesToUpdate) => {
    const minSpacing = 4; // 節點之間的最小間距
    let updatedNodes = [...nodesToUpdate];
    let hasChanges = true;
    let iterations = 0;
    const maxIterations = 50; // 防止無限循環

    // 迭代調整直到沒有重疊
    while (hasChanges && iterations < maxIterations) {
      hasChanges = false;
      iterations++;

      // 按 y 座標排序節點
      const sortedNodes = [...updatedNodes].sort((a, b) => a.y - b.y);

      for (let i = 0; i < sortedNodes.length; i++) {
        for (let j = i + 1; j < sortedNodes.length; j++) {
          const node1 = sortedNodes[i];
          const node2 = sortedNodes[j];

          // 檢查是否重疊
          if (checkOverlap(node1, node2)) {
            // 計算需要移動的距離
            const overlapDist = getOverlapDistance(node1, node2);
            const moveDistance = overlapDist + minSpacing;

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
    const spacing = 80;
    const verticalSpacing = 40;
    const nodeWidth = 120;
    const nodeHeight = 45;

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
      width: 120,
      height: 45,
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
    saveToFirebase(updatedNodes, updatedConnections);
    setEditingNode(newNode.id);
  };

  // 開始拖動背景
  const handleCanvasMouseDown = (e) => {
    // 如果點擊的是節點、加號按鈕或刪除按鈕，不處理背景點擊
    if (e.target.closest(`.${styles.node}`) || 
        e.target.closest(`.${styles.nodeAddButton}`) || 
        e.target.closest(`.${styles.nodeDeleteButton}`)) {
      return;
    }
    
    // 如果點擊的是 SVG 連接線，不處理背景點擊
    if (e.target.tagName === 'path' || e.target.tagName === 'svg') {
      return;
    }

    // 記錄點擊位置，用於判斷是點擊還是拖動
    const rect = e.currentTarget.getBoundingClientRect();
    setClickStartPos({
      x: e.clientX,
      y: e.clientY,
      canvasX: (e.clientX - rect.left - panOffset.x) / zoom,
      canvasY: (e.clientY - rect.top - panOffset.y) / zoom,
    });

    e.preventDefault();
    setIsPanning(true);
    setPanStart({
      x: e.clientX - panOffset.x,
      y: e.clientY - panOffset.y,
    });
  };

  // 開始拖動節點
  const handleNodeMouseDown = (e, node) => {
    // 如果點擊的是加號按鈕或刪除按鈕，不拖動
    if (e.target.closest(`.${styles.nodeAddButton}`) || e.target.closest(`.${styles.nodeDeleteButton}`)) {
      return;
    }
    
    e.stopPropagation();
    e.preventDefault();
    
    const canvasElement = e.currentTarget.closest(`.${styles.mindMapCanvas}`);
    const canvasRect = canvasElement.getBoundingClientRect();
    
    setDraggingNode(node.id);
    setDragOffset({
      x: e.clientX - canvasRect.left - node.x * zoom - panOffset.x,
      y: e.clientY - canvasRect.top - node.y * zoom - panOffset.y,
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

  // 拖動處理（節點或背景）
  const handleMouseMove = (e) => {
    if (isPanning) {
      // 拖動背景
      const newPanOffset = {
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      };
      setPanOffset(newPanOffset);
    } else if (draggingNode) {
      // 拖動節點（包括所有子節點）
      const canvasElement = e.currentTarget;
      const canvasRect = canvasElement.getBoundingClientRect();
      const rawX = (e.clientX - canvasRect.left - dragOffset.x - panOffset.x) / zoom;
      const rawY = (e.clientY - canvasRect.top - dragOffset.y - panOffset.y) / zoom;

      const draggingNodeData = nodes.find(n => n.id === draggingNode);
      if (draggingNodeData) {
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

        // 計算父節點的新位置（限制在邊界內）
        const constrainedPos = constrainNodePosition(draggingNodeData, finalX, finalY);
        
        // 計算移動距離
        const deltaX = constrainedPos.x - draggingNodeData.x;
        const deltaY = constrainedPos.y - draggingNodeData.y;

        // 獲取所有子節點 ID（遞迴）
        const descendantIds = getAllDescendants(draggingNode.id);
        const allMovingNodeIds = new Set([draggingNode, ...descendantIds]);

        // 更新父節點和所有子節點的位置
        const updatedNodes = nodes.map(node => {
          if (allMovingNodeIds.has(node.id)) {
            const newX = node.x + deltaX;
            const newY = node.y + deltaY;
            
            // 對每個節點都進行邊界限制
            const constrained = constrainNodePosition(node, newX, newY);
            
            return { ...node, x: constrained.x, y: constrained.y };
          }
          return node;
        });

        setNodes(updatedNodes);
      }
    }
  };

  // 結束拖動
  const handleMouseUp = (e) => {
    if (draggingNode) {
      // 對齊同層級的節點
      let updatedNodes = [...nodes];
      updatedNodes = alignSiblingNodes(draggingNode, updatedNodes);
      
      // 自動分離重疊的節點
      updatedNodes = separateOverlappingNodes(updatedNodes);
      
      setNodes(updatedNodes);
      saveToFirebase(updatedNodes, connections);
      setDraggingNode(null);
    }
    
    if (isPanning && clickStartPos && e) {
      // 判斷是點擊還是拖動（移動距離小於 5px 視為點擊）
      const moveDistance = Math.sqrt(
        Math.pow(e.clientX - clickStartPos.x, 2) + 
        Math.pow(e.clientY - clickStartPos.y, 2)
      );
      
      if (moveDistance < 5) {
        // 這是點擊
        if (editingNode) {
          // 如果正在編輯節點，結束編輯
          handleNodeTextBlur();
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
    saveToFirebase(updatedNodes, connections);
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
        saveToFirebase(updatedNodes, connections);
      }
    }
    setEditingNode(null);
  };

  // 刪除節點
  const handleDeleteNode = (nodeId) => {
    // 找出所有需要刪除的節點（包括子節點）
    const nodesToDelete = new Set([nodeId]);
    const findChildren = (parentId) => {
      connections
        .filter(conn => conn.from === parentId)
        .forEach(conn => {
          nodesToDelete.add(conn.to);
          findChildren(conn.to); // 遞迴查找子節點的子節點
        });
    };
    findChildren(nodeId);

    // 刪除節點和相關連接
    const updatedNodes = nodes.filter(node => !nodesToDelete.has(node.id));
    const updatedConnections = connections.filter(
      conn => !nodesToDelete.has(conn.from) && !nodesToDelete.has(conn.to)
    );

    setNodes(updatedNodes);
    setConnections(updatedConnections);
    saveToFirebase(updatedNodes, updatedConnections);
    
    // 如果刪除的是正在編輯的節點，清除編輯狀態
    if (nodesToDelete.has(editingNode)) {
      setEditingNode(null);
    }
  };

  // 在畫布左側新增節點（作為新的起始節點）
  const handleAddNodeAtCenter = () => {
    const canvasElement = document.querySelector(`.${styles.mindMapCanvas}`);
    if (!canvasElement) return;

    const nodeWidth = 120;
    const nodeHeight = 45;

    // 找到最左邊的節點
    const leftmostNode = nodes.reduce((leftmost, node) => {
      return !leftmost || node.x < leftmost.x ? node : leftmost;
    }, null);

    let newX, newY;
    if (leftmostNode) {
      // 如果已有節點，新節點放在最左邊節點的左側
      newX = leftmostNode.x - 200; // 放在左側
      newY = leftmostNode.y;
    } else {
      // 如果沒有節點，放在畫布左側中心
      const rect = canvasElement.getBoundingClientRect();
      newX = (BOUNDARY_MARGIN - panOffset.x) / zoom;
      newY = (rect.height / 2 - panOffset.y) / zoom - nodeHeight / 2;
    }

    // 限制在邊界內
    const tempNode = { width: nodeWidth, height: nodeHeight };
    const constrainedPos = constrainNodePosition(tempNode, newX, newY);

    const newNode = {
      id: uuidv4(),
      text: '新節點',
      x: constrainedPos.x,
      y: constrainedPos.y,
      width: nodeWidth,
      height: nodeHeight,
    };

    const updatedNodes = [...nodes, newNode];
    setNodes(updatedNodes);
    saveToFirebase(updatedNodes, connections);
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


  return (
    <div className={styles.mindMapContainer}>
      <div
        className={styles.mindMapCanvas}
        ref={(el) => {
          if (el && canvasSize.width === 0) {
            // 確保畫布尺寸被正確獲取
            setTimeout(() => {
              setCanvasSize({
                width: el.clientWidth,
                height: el.clientHeight,
              });
            }, 0);
          }
        }}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{
          cursor: isPanning ? 'grabbing' : 'default',
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
          <svg className={styles.connectionsLayer}>
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
          {nodes.map(node => (
            <div
              key={node.id}
              className={styles.node}
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
            {editingNode === node.id ? (
              <input
                type="text"
                value={node.text}
                onChange={(e) => handleNodeTextChange(node.id, e.target.value)}
                onBlur={handleNodeTextBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleNodeTextBlur();
                  }
                }}
                className={styles.nodeInput}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <div className={styles.nodeText}>{node.text}</div>
                {hoveredNode === node.id && (
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
                )}
              </>
            )}
            </div>
          ))}
        </div>
      </div>

      {/* 懸浮按鈕組 */}
      <div className={styles.floatingActions}>
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
