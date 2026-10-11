// ==UserScript==
// @name         ChatGPT Table of Contents
// @name:zh-CN   ChatGPT 对话目录
// @namespace    https://github.com/Jujuanel/chatgpt-table-of-contents
// @version      2.1.0
// @description  Show a native-style Table of contents on the right of ChatGPT conversations, starting from the first prompt and covering the whole conversation.
// @description:zh-CN 在 ChatGPT 网页版右侧显示对话目录，从第一条提问开始，覆盖整个对话。参考网页版原生样式实现。
// @author       Jujuanel
// @license      MIT
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const ROOT_ID = "chatgpt-table-of-contents";
  const STYLE_ID = `${ROOT_ID}-style`;
  const SCROLLER_SELECTOR = ".thread-scroll-container";
  const TURN_SELECTOR = "[data-turn-key]";
  const BUBBLE_SELECTOR = "[data-user-message-bubble]";
  const HEADER_SELECTOR = "header[data-app-shell-titlebar]";
  const CONVERSATION_ATTRIBUTE = "data-chatgpt-selection-conversation-id";
  const CONVERSATION_PATH_PATTERN = /\/c\/([0-9a-f-]{36})(?:[/?#]|$)/i;
  const VISIBLE_CONTENT_TYPES = new Set(["text", "multimodal_text"]);
  const LABEL_LIMIT = 60;
  const CLOSE_DELAY = 250;
  const SCROLL_OFFSET = 16;
  const EDGE_OFFSET = 16;
  const SEEK_TIMEOUT = 8000;
  const REFETCH_DELAY = 800;
  const HIGHLIGHT_HOLD = 1200;
  const HIGHLIGHT_FADE = 400;
  const desktop = window.matchMedia("(min-width: 1024px)");

  const STYLE = `
    #${ROOT_ID} {
      position: fixed;
      z-index: 20;
      transform: translateY(-50%);
    }
    #${ROOT_ID} .ctoc-shell {
      position: relative;
      display: flex;
      align-items: flex-start;
    }
    #${ROOT_ID} .ctoc-rail {
      width: 36px;
      overflow: hidden;
    }
    #${ROOT_ID} .ctoc-markers {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
    }
    #${ROOT_ID} .ctoc-marker {
      flex-shrink: 0;
      width: 18px;
      height: 2px;
      padding: 0;
      border: 0;
      border-radius: 9999px;
      background-color: color-mix(
        in srgb,
        var(--color-token-text-tertiary) 60%,
        transparent
      );
      cursor: pointer;
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    #${ROOT_ID} .ctoc-marker:hover {
      background-color: var(--color-token-text-secondary);
    }
    #${ROOT_ID} .ctoc-marker[data-active] {
      background-color: var(--color-token-text-primary);
    }
    #${ROOT_ID} .ctoc-panel {
      position: absolute;
      top: 50%;
      inset-inline-end: 0;
      z-index: 10;
      min-width: 240px;
      max-width: 340px;
      padding: 6px 0;
      border-radius: 16px;
      background-color: var(--color-token-main-surface-primary);
      box-shadow:
        0 8px 16px 0 rgba(0, 0, 0, 0.08),
        0 0 1px 0 rgba(0, 0, 0, 0.62);
      transform: translateY(-50%);
      user-select: none;
    }
    :root[data-theme="dark"] #${ROOT_ID} .ctoc-panel {
      background-color: #353535;
    }
    #${ROOT_ID} .ctoc-menu {
      display: flex;
      flex-direction: column;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }
    #${ROOT_ID} .ctoc-item {
      display: flex;
      align-items: center;
      width: calc(100% - 12px);
      min-height: 40px;
      margin: 0 6px;
      padding: 8px 10px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: var(--color-token-text-primary);
      font: inherit;
      font-size: 16px;
      line-height: 24px;
      text-align: start;
      cursor: pointer;
      outline: none;
    }
    #${ROOT_ID} .ctoc-item:hover,
    #${ROOT_ID} .ctoc-item:focus-visible,
    #${ROOT_ID} .ctoc-item[data-active] {
      background-color: var(--color-background-primary-ghost-hover);
    }
    ${BUBBLE_SELECTOR}[data-ctoc-highlight] {
      transition: background-color ${HIGHLIGHT_FADE}ms ease;
    }
    ${BUBBLE_SELECTOR}[data-ctoc-highlight="on"] {
      background-color: color-mix(
        in srgb,
        var(--color-background-user-message),
        var(--color-background-accent-action) 30%
      );
    }
    #${ROOT_ID} .ctoc-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  let root = null;
  let items = [];
  let activeItemId = null;
  let lockedItemId = null;
  let hovered = false;
  let focusTarget = null;
  let closeTimer = 0;
  let updateFrame = 0;
  let activeFrame = 0;
  let jumpFrame = 0;
  let jumpRequest = 0;
  let renderedSignature = "";
  let observedScroller = null;
  let accessToken = null;
  let highlightedBubble = null;
  let highlightTimer = 0;
  let conversation = createConversationState(null);

  const resizeObserver = new ResizeObserver(() => positionRoot());
  const mediaPointerPattern =
    /\[media pointer=(?:"[^"\n]*"|'[^'\n]*'|[^\]\n]+)\]?/gi;
  const filePointerPattern = /\b(?:sediment|file):\/\/[^\s\]]+/gi;
  const numericEntityPattern = /&#(?:x([0-9a-f]+)|(\d+));/gi;

  function createConversationState(id) {
    return {
      id,
      mapping: null,
      currentNode: null,
      loading: false,
      reloadQueued: false,
      refetchTimer: 0,
      requestedKeys: new Set(),
      domLabels: new Map(),
    };
  }

  function getConversationId() {
    return location.pathname.match(CONVERSATION_PATH_PATTERN)?.[1] || null;
  }

  function truncateLabel(text) {
    const label = text.trim();
    return label.length > LABEL_LIMIT
      ? `${label.slice(0, LABEL_LIMIT - 3)}...`
      : label;
  }

  function getTextLabel(raw) {
    const clean = raw
      .replace(numericEntityPattern, (_, hex, decimal) =>
        String.fromCodePoint(Number.parseInt(hex ?? decimal, hex ? 16 : 10)),
      )
      .replace(mediaPointerPattern, " ")
      .replace(filePointerPattern, " ");

    const heading = clean.match(/^#{1,3}\s+(.+)$/m)?.[1];
    const firstContentLine =
      heading ||
      clean
        .split(/\n+/)
        .find((line) => line.trim().length > 0)
        ?.replace(/^\s*>+\s*/, "")
        .replace(/^\s*[-*+]\s+/, "") ||
      "";

    return truncateLabel(firstContentLine);
  }

  function getBubbleLabel(bubble) {
    if (!bubble) return "";

    const label = getTextLabel(bubble.innerText || bubble.textContent || "");
    if (label) return label;
    if (bubble.querySelector("img")) return "Image upload";
    return "";
  }

  function getApiMessageLabel(message) {
    const parts = Array.isArray(message.content?.parts)
      ? message.content.parts
      : [];
    const label = getTextLabel(
      parts.filter((part) => typeof part === "string").join("\n"),
    );
    if (label) return label;
    if (
      parts.some(
        (part) => part?.content_type === "image_asset_pointer",
      )
    ) {
      return "Image upload";
    }
    if (message.metadata?.attachments?.length) return "File upload";
    return "";
  }

  function isVisibleUserMessage(message) {
    return (
      message?.author?.role === "user" &&
      VISIBLE_CONTENT_TYPES.has(message.content?.content_type) &&
      !message.metadata?.is_visually_hidden_from_conversation
    );
  }

  function enableOverflowTitle(label) {
    let measureFrame = 0;

    const cancelMeasurement = () => {
      if (!measureFrame) return;
      cancelAnimationFrame(measureFrame);
      measureFrame = 0;
    };

    label.addEventListener("mouseenter", () => {
      cancelMeasurement();
      measureFrame = requestAnimationFrame(() => {
        measureFrame = 0;
        if (!label.isConnected) return;

        const text = label.textContent;
        if (text && label.scrollWidth > label.clientWidth) {
          label.title = text;
        } else {
          label.removeAttribute("title");
        }
      });
    });
    label.addEventListener("mouseleave", cancelMeasurement);
    label.addEventListener("pointerdown", cancelMeasurement);
  }

  async function getAccessToken(refresh) {
    if (accessToken && !refresh) return accessToken;

    const response = await fetch("/api/auth/session", {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`Session request failed: HTTP ${response.status}`);
    }
    const session = await response.json();
    if (!session?.accessToken) {
      throw new Error("Session response has no access token");
    }
    accessToken = session.accessToken;
    return accessToken;
  }

  async function requestConversation(id) {
    const send = async (refresh) =>
      fetch(`/backend-api/conversation/${id}`, {
        credentials: "include",
        headers: {
          Authorization: `Bearer ${await getAccessToken(refresh)}`,
        },
      });

    let response = await send(false);
    if (response.status === 401) response = await send(true);
    if (!response.ok) {
      throw new Error(
        `Conversation request failed: HTTP ${response.status}`,
      );
    }
    return response.json();
  }

  async function loadConversation() {
    const state = conversation;
    if (!state.id) return;
    if (state.loading) {
      state.reloadQueued = true;
      return;
    }

    state.loading = true;
    try {
      const data = await requestConversation(state.id);
      if (state !== conversation) return;
      state.mapping = data.mapping;
      state.currentNode = data.current_node;
      scheduleUpdate();
    } catch (error) {
      console.error("[ChatGPT Table of Contents]", error);
    } finally {
      state.loading = false;
      if (state === conversation && state.reloadQueued) {
        state.reloadQueued = false;
        loadConversation();
      }
    }
  }

  function scheduleRefetch() {
    const state = conversation;
    if (!state.id || state.refetchTimer) return;

    state.refetchTimer = window.setTimeout(() => {
      state.refetchTimer = 0;
      if (state === conversation) loadConversation();
    }, REFETCH_DELAY);
  }

  function getBranchPath(anchorId) {
    const { mapping, currentNode } = conversation;
    const currentPath = new Set();
    for (let id = currentNode; id; id = mapping[id]?.parent) {
      currentPath.add(id);
    }

    const start = anchorId && mapping[anchorId] ? anchorId : currentNode;
    const path = [];
    for (let id = start; id; id = mapping[id]?.parent) path.unshift(id);
    for (let id = start; ; ) {
      const children = mapping[id]?.children || [];
      if (children.length === 0) break;
      id =
        children.find((child) => currentPath.has(child)) ??
        children[children.length - 1];
      path.push(id);
    }
    return path;
  }

  function getScroller() {
    return Array.from(document.querySelectorAll(SCROLLER_SELECTOR)).find(
      (scroller) => scroller.checkVisibility(),
    );
  }

  function belongsToConversation(turn) {
    const owner = turn
      .querySelector(`[${CONVERSATION_ATTRIBUTE}]`)
      ?.getAttribute(CONVERSATION_ATTRIBUTE);
    return !owner || owner === conversation.id;
  }

  function getRenderedTurns(scroller) {
    return scroller
      ? Array.from(scroller.querySelectorAll(TURN_SELECTOR)).filter(
          (turn) =>
            turn.getAttribute("data-turn-key") &&
            belongsToConversation(turn),
        )
      : [];
  }

  function getTurnKey(turn) {
    return turn.getAttribute("data-turn-key");
  }

  function findTurn(scroller, id) {
    return scroller.querySelector(
      `${TURN_SELECTOR}[data-turn-key="${CSS.escape(id)}"]`,
    );
  }

  function buildItems(turns) {
    const { mapping, domLabels } = conversation;
    const renderedKeys = turns.map(getTurnKey);
    const nextItems = [];

    if (mapping) {
      const anchorId = renderedKeys.findLast((key) => mapping[key]);
      for (const id of getBranchPath(anchorId)) {
        const message = mapping[id]?.message;
        if (!isVisibleUserMessage(message)) continue;
        nextItems.push({
          id,
          label: getApiMessageLabel(message) || domLabels.get(id) || "",
        });
      }
    }

    const indexOf = (key) => nextItems.findIndex((item) => item.id === key);
    renderedKeys.forEach((key, position) => {
      if (indexOf(key) >= 0) return;

      const item = { id: key, label: domLabels.get(key) || "" };
      const previousKey = renderedKeys
        .slice(0, position)
        .findLast((candidate) => indexOf(candidate) >= 0);
      const nextKey = renderedKeys
        .slice(position + 1)
        .find((candidate) => indexOf(candidate) >= 0);
      if (previousKey) nextItems.splice(indexOf(previousKey) + 1, 0, item);
      else if (nextKey) nextItems.splice(indexOf(nextKey), 0, item);
      else nextItems.push(item);
    });

    nextItems.forEach((item, index) => {
      if (!item.label) item.label = `Prompt ${index + 1}`;
    });
    return nextItems;
  }

  function collectRenderedTurns(turns) {
    const { mapping, domLabels, requestedKeys } = conversation;
    let hasUnknownTurn = false;

    for (const turn of turns) {
      const key = getTurnKey(turn);
      const label = getBubbleLabel(turn.querySelector(BUBBLE_SELECTOR));
      if (label) domLabels.set(key, label);
      if (mapping && !mapping[key] && !requestedKeys.has(key)) {
        requestedKeys.add(key);
        hasUnknownTurn = true;
      }
    }

    if (hasUnknownTurn) scheduleRefetch();
  }

  function isPanelOpen() {
    return (
      items.length > 0 &&
      (hovered ||
        (focusTarget instanceof HTMLElement && focusTarget.isConnected))
    );
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.append(style);
  }

  function removeRoot() {
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    root?.remove();
    root = null;
    hovered = false;
    focusTarget = null;
    renderedSignature = "";
    items = [];
    cancelJump();
  }

  function ensureRoot() {
    if (root?.isConnected) return root;

    ensureStyle();
    root = document.createElement("div");
    root.id = ROOT_ID;

    root.addEventListener("mouseenter", () => {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
      if (hovered) return;
      hovered = true;
      renderView();
    });

    root.addEventListener("mouseleave", () => {
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => {
        hovered = false;
        renderView();
      }, CLOSE_DELAY);
    });

    root.addEventListener("focusin", (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches(":focus-visible")
      ) {
        focusTarget = event.target;
        renderView();
      }
    });

    root.addEventListener("focusout", (event) => {
      if (
        event.relatedTarget instanceof Node &&
        root?.contains(event.relatedTarget)
      ) {
        return;
      }
      focusTarget = null;
      renderView();
    });

    document.body.append(root);
    return root;
  }

  function positionRoot() {
    const scroller = getScroller();
    if (!root || !scroller) return;

    const rect = scroller.getBoundingClientRect();
    root.style.top = `${rect.top + rect.height / 2}px`;
    root.style.right = `${
      document.documentElement.clientWidth - rect.right + EDGE_OFFSET
    }px`;
  }

  function getMaxHeight() {
    const height = getScroller()?.getBoundingClientRect().height;
    return Number.isFinite(height) && height > 0
      ? `${height / 2}px`
      : "50lvh";
  }

  function revealWithin(container, element) {
    if (!container || !element) return;

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (elementRect.top < containerRect.top) {
      container.scrollTop += elementRect.top - containerRect.top;
    } else if (elementRect.bottom > containerRect.bottom) {
      container.scrollTop += elementRect.bottom - containerRect.bottom;
    }
  }

  function setActiveItem(id) {
    if (!id || activeItemId === id) return;
    activeItemId = id;
    applyActiveState();
  }

  function applyActiveState() {
    if (!root) return;

    const markers = Array.from(root.querySelectorAll(".ctoc-marker"));
    const menuButtons = Array.from(root.querySelectorAll(".ctoc-item"));
    const activeIndex = items.findIndex((item) => item.id === activeItemId);

    markers.forEach((marker, index) => {
      marker.toggleAttribute("data-active", index === activeIndex);
    });
    menuButtons.forEach((button, index) => {
      button.toggleAttribute("data-active", index === activeIndex);
    });

    revealWithin(root.querySelector(".ctoc-rail"), markers[activeIndex]);
    revealWithin(root.querySelector(".ctoc-menu"), menuButtons[activeIndex]);
  }

  function cancelJump() {
    jumpRequest += 1;
    if (jumpFrame) cancelAnimationFrame(jumpFrame);
    jumpFrame = 0;
  }

  function moveToward(scroller, targetIndex) {
    const indexById = new Map(items.map((item, index) => [item.id, index]));
    const turns = getRenderedTurns(scroller).filter((turn) =>
      indexById.has(getTurnKey(turn)),
    );
    const rect = scroller.getBoundingClientRect();

    if (turns.length === 0) {
      scroller.scrollTop -= rect.height;
      return;
    }

    const first = turns[0];
    const last = turns[turns.length - 1];
    if (targetIndex < indexById.get(getTurnKey(first))) {
      scroller.scrollTop +=
        Math.min(first.getBoundingClientRect().top - rect.bottom, 0) - 1;
    } else {
      scroller.scrollTop +=
        Math.max(last.getBoundingClientRect().bottom - rect.top, 0) + 1;
    }
  }

  function clearHighlight() {
    window.clearTimeout(highlightTimer);
    highlightTimer = 0;
    highlightedBubble?.removeAttribute("data-ctoc-highlight");
    highlightedBubble = null;
  }

  function highlightBubble(bubble) {
    clearHighlight();
    highlightedBubble = bubble;
    bubble.setAttribute("data-ctoc-highlight", "on");
    highlightTimer = window.setTimeout(() => {
      bubble.setAttribute("data-ctoc-highlight", "off");
      highlightTimer = window.setTimeout(clearHighlight, HIGHLIGHT_FADE);
    }, HIGHLIGHT_HOLD);
  }

  function getContentTop(scroller) {
    const scrollerTop = scroller.getBoundingClientRect().top;
    const headerBottom =
      document.querySelector(HEADER_SELECTOR)?.getBoundingClientRect()
        .bottom ?? scrollerTop;
    return Math.max(scrollerTop, headerBottom);
  }

  function selectItem(item) {
    cancelJump();
    setActiveItem(item.id);
    lockedItemId = item.id;

    const request = jumpRequest;
    const startedAt = performance.now();
    let stableFrames = 0;

    const step = () => {
      jumpFrame = 0;
      if (request !== jumpRequest) return;

      const scroller = getScroller();
      const targetIndex = items.findIndex(
        (candidate) => candidate.id === item.id,
      );
      if (!scroller || targetIndex < 0) return;

      const turn = findTurn(scroller, item.id);
      if (turn) {
        const target = turn.querySelector(BUBBLE_SELECTOR) || turn;
        const delta =
          target.getBoundingClientRect().top -
          getContentTop(scroller) -
          SCROLL_OFFSET;
        const before = scroller.scrollTop;
        if (Math.abs(delta) > 2) scroller.scrollTop = before + delta;
        const settled =
          Math.abs(delta) <= 2 || Math.abs(scroller.scrollTop - before) < 1;
        stableFrames = settled ? stableFrames + 1 : 0;
        if (stableFrames >= 3) {
          if (target.matches(BUBBLE_SELECTOR)) highlightBubble(target);
          return;
        }
      } else {
        stableFrames = 0;
        moveToward(scroller, targetIndex);
      }

      if (performance.now() - startedAt < SEEK_TIMEOUT) {
        jumpFrame = requestAnimationFrame(step);
      }
    };

    step();
  }

  function renderView() {
    if (!root?.isConnected) return;

    const maxHeight = getMaxHeight();
    const shell = document.createElement("div");
    shell.className = "ctoc-shell";

    const rail = document.createElement("div");
    rail.className = "ctoc-rail";
    rail.style.maxHeight = maxHeight;

    const markerList = document.createElement("div");
    markerList.className = "ctoc-markers";

    items.forEach((item) => {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "ctoc-marker";
      marker.setAttribute("aria-label", item.label);
      marker.addEventListener("click", () => selectItem(item));
      markerList.append(marker);
    });

    rail.append(markerList);
    shell.append(rail);

    if (isPanelOpen()) {
      const panel = document.createElement("div");
      panel.className = "ctoc-panel";

      const menu = document.createElement("ul");
      menu.className = "ctoc-menu";
      menu.style.maxHeight = maxHeight;

      items.forEach((item) => {
        const listItem = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ctoc-item";
        button.addEventListener("click", () => selectItem(item));

        const label = document.createElement("div");
        label.className = "ctoc-label";
        label.textContent = item.label;
        enableOverflowTitle(label);

        button.append(label);
        listItem.append(button);
        menu.append(listItem);
      });

      panel.append(menu);
      shell.append(panel);
    }

    root.replaceChildren(shell);
    applyActiveState();
  }

  function updateActive() {
    activeFrame = 0;
    if (!root) return;
    if (lockedItemId && items.some((item) => item.id === lockedItemId)) {
      setActiveItem(lockedItemId);
      return;
    }

    const scroller = getScroller();
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const readingLine = rect.top + rect.height / 2;
    const itemIds = new Set(items.map((item) => item.id));
    const turns = getRenderedTurns(scroller).filter((turn) =>
      itemIds.has(getTurnKey(turn)),
    );

    const lastTurn = turns[turns.length - 1];
    const atEnd =
      lastTurn &&
      getTurnKey(lastTurn) === items[items.length - 1].id &&
      lastTurn.getBoundingClientRect().bottom <= rect.bottom + 2;

    let activeTurn = turns[0];
    for (const turn of turns) {
      if (turn.getBoundingClientRect().top > readingLine) break;
      activeTurn = turn;
    }
    if (atEnd) activeTurn = lastTurn;
    setActiveItem(activeTurn ? getTurnKey(activeTurn) : items[0]?.id);
  }

  function scheduleActiveUpdate() {
    if (activeFrame) return;
    activeFrame = requestAnimationFrame(updateActive);
  }

  function checkForNavigation() {
    const id = getConversationId();
    if (id === conversation.id) return false;

    window.clearTimeout(conversation.refetchTimer);
    conversation = createConversationState(id);
    activeItemId = null;
    lockedItemId = null;
    removeRoot();
    loadConversation();
    return true;
  }

  function update() {
    updateFrame = 0;
    checkForNavigation();

    const scroller = getScroller();
    if (scroller !== observedScroller) {
      if (observedScroller) resizeObserver.unobserve(observedScroller);
      if (scroller) resizeObserver.observe(scroller);
      observedScroller = scroller;
    }

    if (!desktop.matches || !scroller) {
      removeRoot();
      return;
    }

    const turns = getRenderedTurns(scroller);
    collectRenderedTurns(turns);
    const nextItems = buildItems(turns);
    if (nextItems.length === 0) {
      removeRoot();
      return;
    }

    items = nextItems;
    ensureRoot();
    positionRoot();
    const signature = items
      .map((item) => `${item.id}:${item.label}`)
      .join("|");
    if (signature !== renderedSignature) {
      renderedSignature = signature;
      renderView();
    }
    updateActive();
  }

  function scheduleUpdate() {
    if (updateFrame) return;
    updateFrame = requestAnimationFrame(update);
  }

  function isOwnMutation(mutation) {
    const target =
      mutation.target instanceof Element
        ? mutation.target
        : mutation.target.parentElement;
    return Boolean(target?.closest(`#${ROOT_ID}`));
  }

  function releaseJump(event) {
    if (!(event.target instanceof Node)) return;
    if (root?.contains(event.target)) return;
    if (!getScroller()?.contains(event.target)) return;
    cancelJump();
    if (lockedItemId) {
      lockedItemId = null;
      scheduleActiveUpdate();
    }
  }

  new MutationObserver((mutations) => {
    if (mutations.every(isOwnMutation)) return;
    scheduleUpdate();
  }).observe(document.body, {
    characterData: true,
    childList: true,
    subtree: true,
  });

  document.addEventListener(
    "scroll",
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.matches(SCROLLER_SELECTOR)
      ) {
        scheduleActiveUpdate();
      }
    },
    { capture: true, passive: true },
  );
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
    document.addEventListener(type, releaseJump, {
      capture: true,
      passive: true,
    });
  }
  desktop.addEventListener("change", scheduleUpdate);
  window.addEventListener("popstate", scheduleUpdate);
  window.addEventListener("pageshow", scheduleUpdate);
  window.addEventListener("resize", () => {
    positionRoot();
    if (root) renderView();
  });
  window.setInterval(() => {
    if (checkForNavigation()) scheduleUpdate();
  }, 500);

  scheduleUpdate();
})();
