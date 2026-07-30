// ==UserScript==
// @name         ChatGPT Table of Contents
// @name:zh-CN   ChatGPT 对话目录
// @namespace    https://github.com/Jujuanel/chatgpt-table-of-contents
// @version      1.0.0
// @description  Show ChatGPT's native-style Table of contents for the first four prompts, then hand off completely to ChatGPT's native component.
// @description:zh-CN 从第一条提问开始显示 ChatGPT 网页版右侧的对话目录，不必等到第五条提问。参考网页版原生样式实现。
// @author       Jujuanel
// @license      MIT
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const ROOT_ID = "chatgpt-table-of-contents-fallback";
  const TURN_CONTAINER_SELECTOR =
    "[data-turn-id-container][data-is-intersecting]";
  const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
  const ASSISTANT_MESSAGE_SELECTOR =
    '[data-message-author-role="assistant"]';
  const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"]';
  const NATIVE_MARKER_SELECTOR = "button[data-toc-item-index]";
  const ACTIVE_RELEVANT_NODE_SELECTOR =
    `${TURN_CONTAINER_SELECTOR}, ${NATIVE_MARKER_SELECTOR}, ` +
    `${USER_MESSAGE_SELECTOR}, ${ASSISTANT_MESSAGE_SELECTOR}, #thread`;
  const HANDOFF_RELEVANT_NODE_SELECTOR =
    `${TURN_CONTAINER_SELECTOR}, ${USER_MESSAGE_SELECTOR}, ` +
    NATIVE_MARKER_SELECTOR;
  const HANDOFF_ATTRIBUTE_NAMES = new Set([
    "data-message-author-role",
    "data-message-id",
    "data-toc-item-index",
    "data-turn-id-container",
  ]);
  const NATIVE_THRESHOLD = 5;
  const LABEL_LIMIT = 60;
  const CLOSE_DELAY = 250;
  const SCROLL_OFFSET = 16;
  const desktop = window.matchMedia("(min-width: 1024px)");

  let root = null;
  let items = [];
  let activeItemId = null;
  let hovered = false;
  let focusTarget = null;
  let closeTimer = 0;
  let updateFrame = 0;
  let handoffFrame = 0;
  let jumpFrame = 0;
  let jumpRequest = 0;
  let renderedSignature = "";
  let observedTurnSignature = "";
  let observedTurns = [];
  let observedScrollRoot = null;
  let turnObserver = null;
  let activeObserver = null;
  let handoffObserver = null;
  let mode = "fallback";
  let intersectingTurnIds = new Set();
  let lastUrl = location.href;
  let labelCache = new Map();
  let transientTurnIds = new Set();

  const mediaPointerPattern =
    /\[media pointer=(?:"[^"\n]*"|'[^'\n]*'|[^\]\n]+)\]?/gi;
  const filePointerPattern = /\b(?:sediment|file):\/\/[^\s\]]+/gi;

  function truncateLabel(text) {
    const label = text.trim();
    return label.length > LABEL_LIMIT
      ? `${label.slice(0, LABEL_LIMIT - 3)}...`
      : label;
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

  function getTextLabel(raw) {
    const clean = raw
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

  function getMessageLabel(message) {
    if (!message) return "";

    const label = getTextLabel(
      message.innerText || message.textContent || "",
    );
    if (label) return label;
    if (message.querySelector("img")) return "Image upload";
    if (message.querySelector('[data-testid*="file"], a[download]')) {
      return "File upload";
    }
    return "";
  }

  function getVirtualizedUserMessage(turn) {
    const id = turn?.getAttribute("data-turn-id-container");
    const fiberKey = turn
      ? Object.getOwnPropertyNames(turn).find((key) =>
          key.startsWith("__reactFiber$"),
        )
      : null;
    const initialFiber = fiberKey ? turn[fiberKey] : null;
    if (!id || !initialFiber) return null;

    const roots = [initialFiber, initialFiber.alternate].filter(
      Boolean,
    );
    for (const rootFiber of roots) {
      for (
        let fiber = rootFiber;
        fiber;
        fiber = fiber.return
      ) {
        if (fiber.memoizedProps?.turnId !== id) continue;

        for (
          let hook = fiber.memoizedState;
          hook;
          hook = hook.next
        ) {
          if (!Array.isArray(hook.memoizedState)) continue;

          const turnModel = hook.memoizedState.find(
            (candidate) =>
              candidate?.id === id &&
              Array.isArray(candidate.messages),
          );
          const message = turnModel?.messages.find(
            (candidate) => candidate?.author?.role === "user",
          );
          if (!message) continue;

          const parts = Array.isArray(message.content?.parts)
            ? message.content.parts
            : [];
          const label = getTextLabel(
            parts
              .filter((part) => typeof part === "string")
              .join("\n"),
          );
          if (!label) return null;

          return {
            label,
            messageId:
              typeof message.id === "string" ? message.id : null,
          };
        }
      }
    }

    return null;
  }

  function getAssistantFirstLineLabel(message) {
    const firstBlock =
      message?.querySelector(".markdown")?.firstElementChild;
    if (firstBlock?.tagName !== "P") return "";

    const firstLine = (
      firstBlock.innerText ||
      firstBlock.textContent ||
      ""
    )
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);

    return truncateLabel(firstLine || "");
  }

  function getTurnRole(turn) {
    return (
      turn.querySelector("[data-turn]")?.getAttribute("data-turn") ||
      turn
        .querySelector("[data-message-author-role]")
        ?.getAttribute("data-message-author-role") ||
      null
    );
  }

  function getTurnContainers() {
    const thread = document.getElementById("thread");
    if (!thread) return [];

    return Array.from(
      thread.querySelectorAll(TURN_CONTAINER_SELECTOR),
    ).filter(
      (turn) =>
        turn.getAttribute("data-turn-id-container") &&
        turn.getAttribute("data-turn-id-container") !== "client-created-root",
    );
  }

  function inferUserParity(turns) {
    const votes = [0, 0];

    turns.forEach((turn, index) => {
      const role = getTurnRole(turn);
      if (role === "user") votes[index % 2] += 1;
      if (role === "assistant") votes[(index + 1) % 2] += 1;
    });

    return votes[1] > votes[0] ? 1 : 0;
  }

  function trackTransientTurn(turns, userParity) {
    const currentTurnIds = new Set(
      turns.map((turn) =>
        turn.getAttribute("data-turn-id-container"),
      ),
    );
    for (const id of transientTurnIds) {
      if (!currentTurnIds.has(id)) transientTurnIds.delete(id);
    }

    if (!globalThis.document?.querySelector(STOP_BUTTON_SELECTOR)) {
      return;
    }

    const turn = turns[turns.length - 1];
    const turnIndex = turns.length - 1;
    if (
      !turn ||
      turnIndex % 2 !== userParity ||
      turn.querySelector(USER_MESSAGE_SELECTOR)
    ) {
      return;
    }

    const id = turn.getAttribute("data-turn-id-container");
    if (id) transientTurnIds.add(id);
  }

  function buildItems(turns) {
    const userParity = inferUserParity(turns);
    trackTransientTurn(turns, userParity);
    const nextItems = [];

    turns.forEach((turn, turnIndex) => {
      if (turnIndex % 2 !== userParity) return;
      const id = turn.getAttribute("data-turn-id-container");
      if (transientTurnIds.has(id)) return;

      const message = turn.querySelector(USER_MESSAGE_SELECTOR);
      const cached = labelCache.get(id);
      const virtualizedMessage = message || cached?.label
        ? null
        : getVirtualizedUserMessage(turn);
      const directLabel =
        getMessageLabel(message) || virtualizedMessage?.label || "";
      const userLabel = directLabel || cached?.label || "";

      if (directLabel) {
        labelCache.set(id, {
          label: directLabel,
          messageId:
            message?.getAttribute("data-message-id") ||
            virtualizedMessage?.messageId ||
            id,
        });
      }

      const assistantTurn = turns[turnIndex + 1];
      const assistantLabel = userLabel
        ? ""
        : getAssistantFirstLineLabel(
            assistantTurn?.querySelector(
              ASSISTANT_MESSAGE_SELECTOR,
            ),
          );
      const promptNumber = nextItems.length + 1;
      const label =
        userLabel || assistantLabel || `Prompt ${promptNumber}`;
      const assistantTurnId = assistantTurn?.getAttribute(
        "data-turn-id-container",
      );
      const useAssistantTurn = Boolean(
        assistantLabel && assistantTurnId,
      );
      const messageId =
        userLabel
          ? message?.getAttribute("data-message-id") ||
            virtualizedMessage?.messageId ||
            cached?.messageId ||
            id
          : null;

      const activeTurnIds = [id];
      if (assistantTurnId) activeTurnIds.push(assistantTurnId);

      nextItems.push({
        activeTurnIds,
        fallbackTurnId: assistantTurnId || null,
        id,
        label,
        messageId,
        turnId: useAssistantTurn ? assistantTurnId : id,
      });
    });

    return nextItems;
  }

  function hasNativeToc() {
    for (const marker of document.querySelectorAll(
      NATIVE_MARKER_SELECTOR,
    )) {
      if (!root?.contains(marker)) return true;
    }
    return false;
  }

  function hasAtLeastNativeThreshold(turns) {
    const userParity = inferUserParity(turns);
    trackTransientTurn(turns, userParity);
    let promptCount = 0;

    for (
      let turnIndex = userParity;
      turnIndex < turns.length;
      turnIndex += 2
    ) {
      const id = turns[turnIndex].getAttribute(
        "data-turn-id-container",
      );
      if (transientTurnIds.has(id)) continue;

      promptCount += 1;
      if (promptCount >= NATIVE_THRESHOLD) return true;
    }

    return false;
  }

  function getScrollRoot(turns = getTurnContainers()) {
    return (
      turns[0]?.closest("[data-scroll-root]") ||
      document.querySelector("[data-scroll-root]")
    );
  }

  function getMaxHeight() {
    const scrollRoot = getScrollRoot();
    const height = scrollRoot?.getBoundingClientRect().height;
    return Number.isFinite(height) && height > 0
      ? `${height / 2}px`
      : "50lvh";
  }

  function isPanelOpen() {
    return (
      items.length > 0 &&
      (hovered || (focusTarget instanceof HTMLElement && focusTarget.isConnected))
    );
  }

  function removeFallback() {
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    root?.remove();
    root = null;
    hovered = false;
    focusTarget = null;
    renderedSignature = "";
    items = [];
    observedTurnSignature = "";
    observedTurns = [];
    observedScrollRoot = null;
    intersectingTurnIds.clear();
    turnObserver?.disconnect();
    turnObserver = null;
    if (jumpFrame) cancelAnimationFrame(jumpFrame);
    jumpFrame = 0;
  }

  function ensureRoot(container) {
    if (root?.isConnected) return root;

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.className =
      "fixed inset-e-4 top-1/2 z-20 -translate-y-1/2";

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

    container.prepend(root);
    return root;
  }

  function setActiveItem(id) {
    if (!id || activeItemId === id) return;
    activeItemId = id;
    applyActiveState();
  }

  function applyActiveState() {
    if (!root) return;

    const markers = Array.from(
      root.querySelectorAll(NATIVE_MARKER_SELECTOR),
    );
    const menuButtons = Array.from(
      root.querySelectorAll("button.__menu-item"),
    );

    items.forEach((item, index) => {
      const active = item.id === activeItemId;
      const marker = markers[index];
      const menuButton = menuButtons[index];

      if (marker) {
        marker.className = [
          "h-0.5 w-4.5 shrink-0 rounded-full transition-all",
          active
            ? "bg-token-text-primary"
            : "bg-token-text-tertiary/60 hover:bg-token-text-secondary",
        ].join(" ");
        marker.toggleAttribute("data-toc-active", active);
      }

      if (menuButton) {
        menuButton.toggleAttribute("data-active", active);
        menuButton.toggleAttribute("data-toc-active", active);
      }
    });
  }

  function selectItem(item) {
    setActiveItem(item.id);
    jumpRequest += 1;
    const request = jumpRequest;
    const startedAt = performance.now();
    let stableFrames = 0;

    if (jumpFrame) cancelAnimationFrame(jumpFrame);

    const align = () => {
      if (request !== jumpRequest) return;

      const scrollRoot = getScrollRoot();
      if (!scrollRoot) return;

      const message = item.messageId
        ? scrollRoot.querySelector(
            `[data-message-id="${CSS.escape(item.messageId)}"]`,
          )
        : null;
      const turnIds = [item.turnId, item.fallbackTurnId].filter(Boolean);
      const turn = turnIds
        .map((turnId) =>
          scrollRoot.querySelector(
            `[data-turn-id-container="${CSS.escape(turnId)}"]`,
          ),
        )
        .find(Boolean);
      const target = message || turn;
      if (!target) return;

      let delta = 0;
      if (message instanceof HTMLElement) {
        const previousMargin = message.style.scrollMarginTop;
        const scrollPadding =
          Number.parseFloat(getComputedStyle(scrollRoot).scrollPaddingTop) ||
          0;
        const offset = scrollPadding + SCROLL_OFFSET;
        message.style.scrollMarginTop = `${offset}px`;
        message.scrollIntoView({
          behavior: "instant",
          block: "start",
          inline: "nearest",
        });
        delta =
          message.getBoundingClientRect().top -
          scrollRoot.getBoundingClientRect().top -
          offset;
        if (Math.abs(delta) > 2) {
          scrollRoot.scrollTo({
            left: scrollRoot.scrollLeft,
            top: scrollRoot.scrollTop + delta,
            behavior: "instant",
          });
        }
        requestAnimationFrame(() => {
          if (message.isConnected) {
            message.style.scrollMarginTop = previousMargin;
          }
        });
      } else {
        target.scrollIntoView({
          behavior: "instant",
          block: "start",
          inline: "nearest",
        });
      }

      stableFrames =
        message instanceof HTMLElement && Math.abs(delta) <= 2
          ? stableFrames + 1
          : 0;
      if (
        performance.now() - startedAt < 1500 &&
        (performance.now() - startedAt < 350 || stableFrames < 3)
      ) {
        jumpFrame = requestAnimationFrame(align);
      } else {
        jumpFrame = 0;
      }
    };

    align();
  }

  function renderView() {
    if (!root?.isConnected) return;

    const panelOpen = isPanelOpen();
    const maxHeight = getMaxHeight();
    const shell = document.createElement("div");
    shell.className = "relative flex items-start";

    const viewport = document.createElement("div");
    viewport.className = "max-h-[50lvh] w-9 overflow-clip";
    viewport.style.maxHeight = maxHeight;

    const markerList = document.createElement("div");
    markerList.className = "flex flex-col items-center gap-2 py-1";

    items.forEach((item, index) => {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className =
        "h-0.5 w-4.5 shrink-0 rounded-full transition-all";
      marker.setAttribute("aria-label", item.label);
      marker.dataset.tocItemIndex = String(index);
      marker.addEventListener("click", () => selectItem(item));
      markerList.append(marker);
    });

    viewport.append(markerList);
    shell.append(viewport);

    if (panelOpen) {
      const panel = document.createElement("div");
      panel.className = [
        "z-50 max-w-xs rounded-2xl popover",
        "bg-token-main-surface-primary dark:bg-[#353535]",
        "shadow-long py-1.5 select-none absolute top-1/2",
        "z-10 max-w-85 min-w-60 -translate-y-1/2 inset-e-0",
      ].join(" ");

      const menu = document.createElement("ul");
      menu.className =
        "flex max-h-[50lvh] flex-col overflow-y-auto";
      menu.style.maxHeight = maxHeight;

      items.forEach((item) => {
        const listItem = document.createElement("li");
        const button = document.createElement("button");
        button.tabIndex = 0;
        button.setAttribute("data-fill", "");
        button.className =
          "group __menu-item hoverable w-full text-start";
        button.addEventListener("click", () => selectItem(item));

        const content = document.createElement("div");
        content.className =
          "flex min-w-0 grow items-center gap-2.5";
        const label = document.createElement("div");
        label.className = "truncate";
        label.textContent = item.label;
        enableOverflowTitle(label);

        content.append(label);
        button.append(content);
        listItem.append(button);
        menu.append(listItem);
      });

      panel.append(menu);
      shell.append(panel);
    }

    root.dataset.turnCount = String(items.length);
    root.replaceChildren(shell);
    applyActiveState();
  }

  function updateActiveFromIntersections(turns) {
    const activeTurn = turns.find((turn) =>
      intersectingTurnIds.has(
        turn.getAttribute("data-turn-id-container"),
      ),
    );
    const activeTurnId = activeTurn?.getAttribute(
      "data-turn-id-container",
    );
    const activeItem = items.find((item) =>
      item.activeTurnIds.includes(activeTurnId),
    );
    if (activeItem) setActiveItem(activeItem.id);
  }

  function updateActiveFromGeometry(turns, scrollRoot) {
    const rootRect = scrollRoot?.getBoundingClientRect();
    if (!rootRect) return;
    const readingLine = (rootRect.top + rootRect.bottom) / 2;
    const activeTurn = turns.find((turn) => {
      const rect = turn.getBoundingClientRect();
      return rect.top <= readingLine && rect.bottom >= readingLine;
    });
    const activeTurnId = activeTurn?.getAttribute(
      "data-turn-id-container",
    );
    const activeItem = items.find((item) =>
      item.activeTurnIds.includes(activeTurnId),
    );
    setActiveItem(activeItem?.id || items[0]?.id);
  }

  function syncTurnObserver(turns) {
    const scrollRoot = getScrollRoot(turns);
    const signature = turns
      .map((turn) => turn.getAttribute("data-turn-id-container"))
      .join("|");
    if (
      signature === observedTurnSignature &&
      turns.length === observedTurns.length &&
      turns.every((turn, index) => turn === observedTurns[index]) &&
      scrollRoot === observedScrollRoot
    ) {
      return;
    }

    turnObserver?.disconnect();
    turnObserver = null;
    intersectingTurnIds = new Set();
    observedTurnSignature = signature;
    observedTurns = turns;
    observedScrollRoot = scrollRoot;

    if (!scrollRoot || turns.length === 0) return;

    turnObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const id = entry.target.getAttribute(
            "data-turn-id-container",
          );
          if (!id) return;
          if (entry.isIntersecting) intersectingTurnIds.add(id);
          else intersectingTurnIds.delete(id);
        });
        updateActiveFromIntersections(turns);
      },
      {
        root: scrollRoot,
        rootMargin: "-49% 0px -49% 0px",
        threshold: 0,
      },
    );

    turns.forEach((turn) => turnObserver.observe(turn));
    updateActiveFromGeometry(turns, scrollRoot);
  }

  function update() {
    updateFrame = 0;

    if (mode !== "fallback" || checkForNavigation()) return;

    if (!desktop.matches || hasNativeToc()) {
      enterHandoff();
      return;
    }

    const turns = getTurnContainers();
    const nextItems = buildItems(turns);
    if (nextItems.length >= NATIVE_THRESHOLD) {
      enterHandoff();
      return;
    }
    if (nextItems.length === 0) {
      removeFallback();
      return;
    }

    const container =
      turns[0]?.parentElement || document.getElementById("thread");
    if (!container) {
      removeFallback();
      return;
    }

    items = nextItems;
    const signature = `${location.pathname}|${items
      .map((item) => `${item.id}:${item.label}`)
      .join("|")}`;
    ensureRoot(container);
    if (signature !== renderedSignature) {
      renderedSignature = signature;
      renderView();
    }
    syncTurnObserver(turns);
  }

  function scheduleUpdate() {
    if (mode !== "fallback" || updateFrame) return;
    updateFrame = requestAnimationFrame(update);
  }

  function containsRelevantNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.id === ROOT_ID || node.closest(`#${ROOT_ID}`)) return false;
    return (
      node.matches(ACTIVE_RELEVANT_NODE_SELECTOR) ||
      Boolean(node.querySelector(ACTIVE_RELEVANT_NODE_SELECTOR))
    );
  }

  function containsHandoffRelevantNode(node) {
    if (!(node instanceof Element)) return false;
    return (
      node.matches(HANDOFF_RELEVANT_NODE_SELECTOR) ||
      Boolean(node.querySelector(HANDOFF_RELEVANT_NODE_SELECTOR))
    );
  }

  function nodeListContainsRelevantNode(nodes, predicate) {
    for (const node of nodes) {
      if (predicate(node)) return true;
    }
    return false;
  }

  function hasRelevantNodeMutation(mutation, predicate) {
    return (
      nodeListContainsRelevantNode(mutation.addedNodes, predicate) ||
      nodeListContainsRelevantNode(mutation.removedNodes, predicate)
    );
  }

  function stopActiveObserver() {
    activeObserver?.disconnect();
    activeObserver = null;
  }

  function stopHandoffObserver() {
    handoffObserver?.disconnect();
    handoffObserver = null;
  }

  function startActiveObserver() {
    if (activeObserver) return;

    activeObserver = new MutationObserver((mutations) => {
      if (checkForNavigation()) return;

      for (const mutation of mutations) {
        const mutationElement =
          mutation.target instanceof Element
            ? mutation.target
            : mutation.target.parentElement;
        if (mutationElement?.closest(`#${ROOT_ID}`)) continue;
        if (
          mutationElement?.closest(
            `${USER_MESSAGE_SELECTOR}, ${ASSISTANT_MESSAGE_SELECTOR}`,
          )
        ) {
          scheduleUpdate();
          return;
        }
        if (hasRelevantNodeMutation(mutation, containsRelevantNode)) {
          scheduleUpdate();
          return;
        }
      }
    });

    activeObserver.observe(document.documentElement, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  function scheduleHandoffCheck() {
    if (mode !== "handoff" || handoffFrame) return;
    handoffFrame = requestAnimationFrame(checkHandoffState);
  }

  function startHandoffObserver() {
    if (handoffObserver) return;

    handoffObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          HANDOFF_ATTRIBUTE_NAMES.has(mutation.attributeName)
        ) {
          scheduleHandoffCheck();
          return;
        }
        if (
          mutation.type === "childList" &&
          hasRelevantNodeMutation(mutation, containsHandoffRelevantNode)
        ) {
          scheduleHandoffCheck();
          return;
        }
      }
    });

    handoffObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: Array.from(HANDOFF_ATTRIBUTE_NAMES),
      childList: true,
      subtree: true,
    });
  }

  function enterHandoff() {
    if (mode === "handoff") return;

    if (updateFrame) cancelAnimationFrame(updateFrame);
    updateFrame = 0;
    stopActiveObserver();
    removeFallback();
    mode = "handoff";
    startHandoffObserver();
  }

  function leaveHandoff() {
    if (mode !== "handoff") return;

    if (handoffFrame) cancelAnimationFrame(handoffFrame);
    handoffFrame = 0;
    stopHandoffObserver();
    mode = "fallback";
    startActiveObserver();
  }

  function checkForNavigation() {
    if (location.href === lastUrl) return false;

    lastUrl = location.href;
    labelCache = new Map();
    transientTurnIds = new Set();
    activeItemId = null;
    renderedSignature = "";
    removeFallback();
    leaveHandoff();
    scheduleUpdate();
    return true;
  }

  function checkHandoffState() {
    handoffFrame = 0;
    if (checkForNavigation() || !desktop.matches) return;

    const turns = getTurnContainers();
    if (hasNativeToc() || hasAtLeastNativeThreshold(turns)) return;

    leaveHandoff();
    scheduleUpdate();
  }

  function refreshState() {
    if (checkForNavigation()) return;
    if (mode === "handoff") scheduleHandoffCheck();
    else scheduleUpdate();
  }

  startActiveObserver();
  desktop.addEventListener("change", refreshState);
  window.addEventListener("popstate", refreshState);
  window.addEventListener("pageshow", refreshState);
  window.addEventListener("resize", () => {
    if (mode === "fallback" && root) renderView();
  });
  window.setInterval(checkForNavigation, 1000);

  scheduleUpdate();
})();
