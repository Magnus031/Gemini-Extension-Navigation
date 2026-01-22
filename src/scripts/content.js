/**
 * Gemini 对话导航助手 - Content Script
 * V1.0: 基本问题抓取与点击跳转
 */

(function() {
  'use strict';

  // 配置常量
  const CONFIG = {
    MAX_TEXT_LENGTH: 20,
    SCROLL_OFFSET: 100,
    DEBOUNCE_DELAY: 300,
    NAV_PANEL_ID: 'gemini-nav-panel',
    STORAGE_KEY: 'gemini_nav_index'
  };

  // 存储已识别的问题节点
  let questionNodes = [];
  let isCollapsed = false;
  let currentActiveIndex = -1;

  /**
   * 创建导航面板
   */
  function createNavPanel() {
    if (document.getElementById(CONFIG.NAV_PANEL_ID)) {
      return document.getElementById(CONFIG.NAV_PANEL_ID);
    }

    const panel = document.createElement('div');
    panel.id = CONFIG.NAV_PANEL_ID;
    panel.className = 'gemini-nav-panel';

    panel.innerHTML = `
      <div class="gemini-nav-header">
        <span class="gemini-nav-title">对话导航</span>
        <button class="gemini-nav-toggle" title="折叠/展开">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
      </div>
      <div class="gemini-nav-list-container">
        <ul class="gemini-nav-list"></ul>
      </div>
      <div class="gemini-nav-empty">
        <span>暂无对话记录</span>
      </div>
    `;

    document.body.appendChild(panel);

    // 绑定折叠按钮事件
    const toggleBtn = panel.querySelector('.gemini-nav-toggle');
    toggleBtn.addEventListener('click', togglePanel);

    return panel;
  }

  /**
   * 折叠/展开面板
   */
  function togglePanel() {
    const panel = document.getElementById(CONFIG.NAV_PANEL_ID);
    if (!panel) return;

    isCollapsed = !isCollapsed;
    panel.classList.toggle('collapsed', isCollapsed);

    const toggleBtn = panel.querySelector('.gemini-nav-toggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = isCollapsed
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>`;
    }
  }

  /**
   * 截断文本
   */
  function truncateText(text, maxLength = CONFIG.MAX_TEXT_LENGTH) {
    const cleanText = text.trim().replace(/\s+/g, ' ');
    if (cleanText.length <= maxLength) {
      return cleanText;
    }
    return cleanText.substring(0, maxLength) + '...';
  }

  /**
   * 扫描并提取用户问题
   */
  function scanQuestions() {
    // Gemini 页面中用户消息的可能选择器
    const selectors = [
      '[data-message-author-role="user"]',
      '.user-message',
      '[class*="user"][class*="message"]',
      'div[data-is-user-turn="true"]',
      '.conversation-turn-user',
      // 通用选择器 - 查找包含用户输入的元素
      '.query-content',
      '[class*="query"]'
    ];

    let userMessages = [];

    // 尝试多种选择器
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        userMessages = Array.from(elements);
        break;
      }
    }

    // 如果常规选择器没找到，尝试通过结构特征识别
    if (userMessages.length === 0) {
      // 查找可能包含对话的容器
      const possibleContainers = document.querySelectorAll('[class*="conversation"], [class*="chat"], main');
      possibleContainers.forEach(container => {
        // 查找可能的用户消息（通常交替出现）
        const turns = container.querySelectorAll('[class*="turn"], [class*="message-row"]');
        turns.forEach((turn, index) => {
          // 假设偶数位置是用户消息（从0开始）
          if (index % 2 === 0 && turn.textContent.trim()) {
            userMessages.push(turn);
          }
        });
      });
    }

    return userMessages;
  }

  /**
   * 更新导航列表
   */
  function updateNavList() {
    const panel = document.getElementById(CONFIG.NAV_PANEL_ID);
    if (!panel) return;

    const navList = panel.querySelector('.gemini-nav-list');
    const emptyState = panel.querySelector('.gemini-nav-empty');
    const listContainer = panel.querySelector('.gemini-nav-list-container');

    const questions = scanQuestions();

    // 更新存储的节点引用
    questionNodes = questions;

    if (questions.length === 0) {
      emptyState.style.display = 'flex';
      listContainer.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    listContainer.style.display = 'block';

    // 清空并重建列表
    navList.innerHTML = '';

    questions.forEach((node, index) => {
      const text = node.textContent || node.innerText || '';
      const displayText = truncateText(text);

      if (!displayText) return;

      const li = document.createElement('li');
      li.className = 'gemini-nav-item';
      li.dataset.index = index;

      li.innerHTML = `
        <span class="gemini-nav-item-number">${index + 1}</span>
        <span class="gemini-nav-item-text" title="${text.trim().substring(0, 100)}">${displayText}</span>
      `;

      li.addEventListener('click', () => scrollToQuestion(index));

      navList.appendChild(li);
    });

    // 更新当前高亮
    updateActiveItem();

    // 保存到 storage
    saveToStorage(questions.map(q => truncateText(q.textContent || '')));
  }

  /**
   * 滚动到指定问题
   */
  function scrollToQuestion(index) {
    const node = questionNodes[index];
    if (!node) return;

    node.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });

    // 添加临时高亮效果
    node.classList.add('gemini-nav-highlight');
    setTimeout(() => {
      node.classList.remove('gemini-nav-highlight');
    }, 2000);

    // 更新活动状态
    setActiveItem(index);
  }

  /**
   * 设置当前活动项
   */
  function setActiveItem(index) {
    currentActiveIndex = index;
    const panel = document.getElementById(CONFIG.NAV_PANEL_ID);
    if (!panel) return;

    const items = panel.querySelectorAll('.gemini-nav-item');
    items.forEach((item, i) => {
      item.classList.toggle('active', i === index);
    });
  }

  /**
   * 根据滚动位置更新活动项
   */
  function updateActiveItem() {
    if (questionNodes.length === 0) return;

    const viewportMiddle = window.innerHeight / 2;
    let closestIndex = 0;
    let closestDistance = Infinity;

    questionNodes.forEach((node, index) => {
      const rect = node.getBoundingClientRect();
      const nodeMiddle = rect.top + rect.height / 2;
      const distance = Math.abs(nodeMiddle - viewportMiddle);

      if (distance < closestDistance && rect.top < window.innerHeight) {
        closestDistance = distance;
        closestIndex = index;
      }
    });

    if (closestIndex !== currentActiveIndex) {
      setActiveItem(closestIndex);
    }
  }

  /**
   * 保存到 Chrome Storage
   */
  function saveToStorage(questions) {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({
        [CONFIG.STORAGE_KEY]: {
          url: window.location.href,
          questions: questions,
          timestamp: Date.now()
        }
      });
    }
  }

  /**
   * 防抖函数
   */
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  /**
   * 初始化 MutationObserver
   */
  function initObserver() {
    const debouncedUpdate = debounce(updateNavList, CONFIG.DEBOUNCE_DELAY);

    const observer = new MutationObserver((mutations) => {
      // 检查是否有相关变化
      const hasRelevantChanges = mutations.some(mutation => {
        return mutation.addedNodes.length > 0 ||
               mutation.removedNodes.length > 0 ||
               mutation.type === 'characterData';
      });

      if (hasRelevantChanges) {
        debouncedUpdate();
      }
    });

    // 监听整个 body
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    return observer;
  }

  /**
   * 初始化滚动监听
   */
  function initScrollListener() {
    const debouncedUpdate = debounce(updateActiveItem, 100);
    window.addEventListener('scroll', debouncedUpdate, { passive: true });
  }

  /**
   * 主初始化函数
   */
  function init() {
    // 等待页面加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
      return;
    }

    console.log('[Gemini Nav] 初始化导航助手...');

    // 创建导航面板
    createNavPanel();

    // 首次扫描
    setTimeout(updateNavList, 1000);

    // 初始化观察器
    initObserver();

    // 初始化滚动监听
    initScrollListener();

    console.log('[Gemini Nav] 导航助手已启动');
  }

  // 启动
  init();

})();
