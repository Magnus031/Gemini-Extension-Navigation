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
  let currentSearchQuery = '';

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
        <div class="gemini-nav-header-actions">
          <button class="gemini-nav-refresh" title="扫描全部对话">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="23 4 23 10 17 10"></polyline>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
          </button>
          <button class="gemini-nav-toggle" title="折叠/展开">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>
        </div>
      </div>
      <div class="gemini-nav-search">
        <svg class="gemini-nav-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="gemini-nav-search-input" placeholder="搜索对话...">
        <button class="gemini-nav-search-clear" title="清除" style="display:none">×</button>
      </div>
      <div class="gemini-nav-list-container">
        <ul class="gemini-nav-list"></ul>
      </div>
      <div class="gemini-nav-empty">
        <span>暂无对话记录</span>
      </div>
      <div class="gemini-nav-no-results" style="display:none">
        <span>无匹配结果</span>
      </div>
    `;

    document.body.appendChild(panel);

    // 绑定折叠按钮事件
    const toggleBtn = panel.querySelector('.gemini-nav-toggle');
    toggleBtn.addEventListener('click', togglePanel);

    // 绑定刷新按钮事件
    const refreshBtn = panel.querySelector('.gemini-nav-refresh');
    refreshBtn.addEventListener('click', () => initScanAll(true));

    // 绑定搜索框事件
    const searchInput = panel.querySelector('.gemini-nav-search-input');
    const searchClear = panel.querySelector('.gemini-nav-search-clear');

    searchInput.addEventListener('input', () => {
      const query = searchInput.value;
      searchClear.style.display = query ? 'flex' : 'none';
      filterNavItems(query);
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      filterNavItems('');
    });

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
   * 获取页面主滚动容器
   */
  function getScrollElement() {
    const selectors = [
      'infinite-scroller',
      'chat-history',
      'chat-window',
      '[class*="conversation-container"]',
      '[class*="chat-history"]',
      'main'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight + 10) return el;
      } catch (e) {}
    }

    // 找任意一条消息，向上遍历找到真正可滚动的祖先
    const anyMsg = document.querySelector(
      '[data-message-author-role], .user-message, [class*="message-row"], [class*="turn"]'
    );
    if (anyMsg) {
      let el = anyMsg.parentElement;
      while (el && el !== document.documentElement) {
        if (el.scrollHeight > el.clientHeight + 10) {
          const ov = window.getComputedStyle(el).overflowY;
          if (ov === 'scroll' || ov === 'auto' || ov === 'overlay') return el;
        }
        el = el.parentElement;
      }
    }

    // 兜底：始终返回 documentElement
    return document.documentElement;
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
   * 按关键字过滤导航条目
   */
  function filterNavItems(query) {
    currentSearchQuery = query.trim().toLowerCase();
    const panel = document.getElementById(CONFIG.NAV_PANEL_ID);
    if (!panel) return;

    const items = panel.querySelectorAll('.gemini-nav-item');
    const noResults = panel.querySelector('.gemini-nav-no-results');
    let visibleCount = 0;

    items.forEach(item => {
      const textEl = item.querySelector('.gemini-nav-item-text');
      const text = (textEl.textContent + ' ' + (textEl.title || '')).toLowerCase();
      const matches = !currentSearchQuery || text.includes(currentSearchQuery);
      item.style.display = matches ? '' : 'none';
      if (matches) visibleCount++;
    });

    if (noResults) {
      noResults.style.display = (currentSearchQuery && visibleCount === 0) ? 'flex' : 'none';
    }
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

    // 重新应用搜索过滤
    if (currentSearchQuery) {
      filterNavItems(currentSearchQuery);
    }

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
   * 滚动到顶部强制加载所有历史消息，再跳回原位
   * @param {boolean} manual - 是否为手动触发（显示加载状态）
   */
  async function initScanAll(manual = false) {
    const panel = document.getElementById(CONFIG.NAV_PANEL_ID);
    const refreshBtn = panel && panel.querySelector('.gemini-nav-refresh');

    if (refreshBtn) {
      refreshBtn.classList.add('spinning');
      refreshBtn.disabled = true;
    }

    try {
      const scrollEl = getScrollElement();
      const isDocEl = scrollEl === document.documentElement;
      const savedWinPos = window.scrollY;
      const savedElPos = isDocEl ? 0 : scrollEl.scrollTop;

      const EXTRA_SELECTORS = 'infinite-scroller, chat-history, chat-window, main, [class*="conversation-container"], [class*="chat-history"]';

      // 对所有容器执行同一个滚动位置，确保 infinite-scroller 等也被控制
      const scrollAllTo = (pos) => {
        window.scrollTo(0, pos);
        document.documentElement.scrollTop = pos;
        document.body.scrollTop = pos;
        if (!isDocEl) scrollEl.scrollTop = pos;
        document.querySelectorAll(EXTRA_SELECTORS)
          .forEach(el => { try { el.scrollTop = pos; } catch (e) {} });
      };

      // 取所有容器中最大的 scrollHeight，避免因 scrollEl 选错而漏检高度变化
      const getHeight = () => {
        let h = document.documentElement.scrollHeight;
        document.querySelectorAll(EXTRA_SELECTORS)
          .forEach(el => { if (el.scrollHeight > h) h = el.scrollHeight; });
        return h;
      };

      let prevHeight = getHeight();
      const MAX_ITER = 15;

      for (let i = 0; i < MAX_ITER; i++) {
        scrollAllTo(0);

        // 轮询等待新内容出现（每 200ms 检查一次，最多等 3s）
        const deadline = Date.now() + 3000;
        let newHeight = prevHeight;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 200));
          newHeight = getHeight();
          if (newHeight > prevHeight) break;
        }

        if (newHeight <= prevHeight) break; // 高度不再增加，已到真正顶端
        prevHeight = newHeight;

        // 等待 DOM 完全稳定，再向下滚动重置所有容器的哨兵可见状态
        await new Promise(resolve => setTimeout(resolve, 800));
        scrollAllTo(500);
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      updateNavList();

      // 跳回原位
      await new Promise(resolve => setTimeout(resolve, 50));
      window.scrollTo(0, savedWinPos);
      if (!isDocEl) scrollEl.scrollTop = savedElPos;

    } finally {
      // 无论是否出错，始终停止旋转
      if (refreshBtn) {
        refreshBtn.classList.remove('spinning');
        refreshBtn.disabled = false;
      }
    }
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

    // 同时监听自定义滚动容器（Gemini 可能使用非 window 滚动）
    const scrollEl = getScrollElement();
    if (scrollEl && scrollEl !== document.documentElement) {
      scrollEl.addEventListener('scroll', debouncedUpdate, { passive: true });
    }
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

    // 自动滚动加载全部历史消息
    setTimeout(() => initScanAll(), 1500);

    // 初始化观察器
    initObserver();

    // 初始化滚动监听
    initScrollListener();

    console.log('[Gemini Nav] 导航助手已启动');
  }

  // 启动
  init();

})();
