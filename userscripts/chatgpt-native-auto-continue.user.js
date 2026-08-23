// ==UserScript==
// @name         DevilTea ChatGPT Native Auto Continue
// @namespace    https://github.com/DevilTea/agent-vm-mcp
// @version      0.3.4
// @description  Conservative per-chat auto-click for ChatGPT's explicit Continue generating control.
// @updateURL    https://raw.githubusercontent.com/DevilTea/agent-vm-mcp/main/userscripts/chatgpt-native-auto-continue.user.js
// @downloadURL  https://raw.githubusercontent.com/DevilTea/agent-vm-mcp/main/userscripts/chatgpt-native-auto-continue.user.js
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

;(function () {
  'use strict';

  const CONTROLLER_KEY = '__devilteaChatGPTNativeAutoContinue';
  const STORAGE_PREFIX = 'deviltea.chatgpt-native-auto-continue.v1:';
  const RUNTIME_PREFIX = 'deviltea.chatgpt-native-auto-continue.runtime.v1:';
  const STORAGE_PROBE_KEY = 'deviltea.chatgpt-native-auto-continue.probe';
  const PERSISTENCE_FAILURE_KEY = '__devilteaChatGPTNativeAutoContinuePersistenceFailed';
  const TOGGLE_ID = 'deviltea-chatgpt-native-auto-continue-toggle';
  const CLICKED_ATTRIBUTE = 'data-deviltea-native-auto-continue-clicked';
  const MAX_CHAIN_CONTINUATIONS = 8;
  const CLICK_SETTLE_MS = 800;
  const RECONCILE_DELAY_MS = 80;
  const SUBMISSION_INTENT_TTL_MS = 15_000;
  const CONTINUE_LABELS = new Set([
    'continue generating',
    '繼續生成',
    '繼續產生',
  ]);
  const STOP_LABELS = new Set([
    'stop',
    'stop generating',
    'stop streaming',
    '停止生成',
    '停止產生',
    '停止回應',
  ]);
  const SEND_SELECTOR = '[data-testid="send-button"], #composer-submit-button';
  const STOP_SELECTOR = '[data-testid="stop-button"]';
  const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
  const ATTACHMENT_SELECTOR = [
    '[data-testid*="attachment" i]',
    '[data-testid*="file-thumbnail" i]',
    'button[aria-label^="Remove file" i]',
    'button[aria-label^="Remove attachment" i]',
  ].join(',');

  window[CONTROLLER_KEY]?.destroy?.();

  let destroyed = false;
  let currentConversationId = getConversationId();
  const inheritedPersistenceFailure = window[PERSISTENCE_FAILURE_KEY] === true;
  let persistenceHealthy = !inheritedPersistenceFailure && probeRequiredStorage();
  if (!persistenceHealthy) window[PERSISTENCE_FAILURE_KEY] = true;
  let persistenceFailureReason = inheritedPersistenceFailure
    ? 'a prior persistence failure occurred on this page'
    : persistenceHealthy
      ? null
      : 'required browser storage probe failed';
  let enabled = false;
  let chainCount = 0;
  let manualStopSuppressed = false;
  let submissionIntent = null;
  let reconcileTimer = null;
  let pendingClickTimer = null;
  let pendingControl = null;
  let autoClickInProgress = false;
  let lastSuppressionReason = null;

  if (currentConversationId && persistenceHealthy) loadConversationState(currentConversationId);

  const observer = new MutationObserver(() => scheduleReconcile());

  function log(message, details) {
    if (details === undefined) {
      console.info(`[native auto-continue] ${message}`);
      return;
    }
    console.info(`[native auto-continue] ${message}`, details);
  }

  function logSuppression(reason, details) {
    if (lastSuppressionReason === reason) return;
    lastSuppressionReason = reason;
    log(`suppressed: ${reason}`, details);
  }

  function clearSuppressionLog() {
    lastSuppressionReason = null;
  }

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function getConversationId(pathname = window.location.pathname) {
    const segments = String(pathname)
      .split('/')
      .map(segment => segment.trim())
      .filter(Boolean);
    const conversationSegment = segments.lastIndexOf('c');

    if (conversationSegment < 0 || conversationSegment === segments.length - 1) return null;

    try {
      return decodeURIComponent(segments[conversationSegment + 1]);
    } catch (error) {
      console.warn('[native auto-continue] malformed conversation path; failing closed', error);
      return null;
    }
  }

  function storageKey(conversationId) {
    return `${STORAGE_PREFIX}${conversationId}`;
  }

  function runtimeKey(conversationId) {
    return `${RUNTIME_PREFIX}${conversationId}`;
  }

  function probeOneStorage(name) {
    try {
      const storage = window[name];
      storage.setItem(STORAGE_PROBE_KEY, '1');
      if (storage.getItem(STORAGE_PROBE_KEY) !== '1') return false;
      storage.removeItem(STORAGE_PROBE_KEY);
      return true;
    } catch (error) {
      console.warn(`[native auto-continue] ${name} unavailable; failing closed`, error);
      return false;
    }
  }

  function probeRequiredStorage() {
    return probeOneStorage('localStorage') && probeOneStorage('sessionStorage');
  }

  function failPersistenceClosed(context, error) {
    if (!persistenceHealthy) return;
    persistenceHealthy = false;
    window[PERSISTENCE_FAILURE_KEY] = true;
    persistenceFailureReason = context;
    enabled = false;
    submissionIntent = null;
    cancelPendingClick();
    console.warn(`[native auto-continue] ${context}; persistence is required, failing closed`, error);
    logSuppression('required browser storage is unavailable');
    updateToggle();
  }

  function readStoredEnabled(conversationId) {
    try {
      return window.localStorage.getItem(storageKey(conversationId)) === '1';
    } catch (error) {
      failPersistenceClosed('localStorage read failed', error);
      return false;
    }
  }

  function writeStoredEnabled(conversationId, nextEnabled) {
    try {
      if (nextEnabled) window.localStorage.setItem(storageKey(conversationId), '1');
      else window.localStorage.removeItem(storageKey(conversationId));
      return true;
    } catch (error) {
      failPersistenceClosed('localStorage write failed', error);
      return false;
    }
  }

  function readRuntimeState(conversationId) {
    try {
      const raw = window.sessionStorage.getItem(runtimeKey(conversationId));
      if (!raw) return { chainCount: 0, manualStopSuppressed: false };
      const parsed = JSON.parse(raw);
      if (
        !Number.isSafeInteger(parsed.chainCount) ||
        parsed.chainCount < 0 ||
        parsed.chainCount > MAX_CHAIN_CONTINUATIONS ||
        typeof parsed.manualStopSuppressed !== 'boolean'
      ) {
        throw new Error('invalid runtime state');
      }
      return {
        chainCount: parsed.chainCount,
        manualStopSuppressed: parsed.manualStopSuppressed,
      };
    } catch (error) {
      failPersistenceClosed('sessionStorage runtime read failed', error);
      return null;
    }
  }

  function persistRuntimeState(nextChainCount, nextManualStopSuppressed) {
    if (!currentConversationId || !persistenceHealthy) return false;
    try {
      window.sessionStorage.setItem(
        runtimeKey(currentConversationId),
        JSON.stringify({
          chainCount: nextChainCount,
          manualStopSuppressed: nextManualStopSuppressed,
        }),
      );
      return true;
    } catch (error) {
      failPersistenceClosed('sessionStorage runtime write failed', error);
      return false;
    }
  }

  function loadConversationState(conversationId) {
    if (!conversationId || !persistenceHealthy) {
      enabled = false;
      chainCount = 0;
      manualStopSuppressed = false;
      return;
    }

    enabled = readStoredEnabled(conversationId);
    if (!persistenceHealthy) return;
    const runtime = readRuntimeState(conversationId);
    if (!runtime || !persistenceHealthy) return;
    chainCount = runtime.chainCount;
    manualStopSuppressed = runtime.manualStopSuppressed;
  }

  function resetChain(reason) {
    if (!currentConversationId || !persistenceHealthy) return false;
    if (!persistRuntimeState(0, false)) return false;
    chainCount = 0;
    manualStopSuppressed = false;
    submissionIntent = null;
    cancelPendingClick();
    clearSuppressionLog();
    log(`continuation chain reset: ${reason}`);
    updateToggle();
    return true;
  }

  function syncConversation() {
    const nextConversationId = getConversationId();
    if (nextConversationId === currentConversationId) return false;

    const previousConversationId = currentConversationId;
    cancelPendingClick();
    consumeExistingContinueControls('conversation change');
    submissionIntent = null;
    currentConversationId = nextConversationId;
    clearSuppressionLog();

    if (nextConversationId === null) {
      enabled = false;
      chainCount = 0;
      manualStopSuppressed = false;
    } else {
      loadConversationState(nextConversationId);
    }

    log('conversation changed', {
      from: previousConversationId,
      to: nextConversationId,
      enabled,
      chainCount,
      persistenceHealthy,
    });
    updateToggle();
    return true;
  }

  function setEnabled(nextEnabled) {
    if (!currentConversationId || !persistenceHealthy) {
      enabled = false;
      cancelPendingClick();
      logSuppression(
        !currentConversationId
          ? 'open an existing conversation before enabling'
          : 'required browser storage is unavailable',
      );
      updateToggle();
      return;
    }

    const normalized = Boolean(nextEnabled);
    if (!writeStoredEnabled(currentConversationId, normalized)) return;
    enabled = normalized;
    if (!enabled) cancelPendingClick();
    clearSuppressionLog();
    log(enabled ? 'enabled' : 'disabled', {
      conversationId: currentConversationId,
      chainCount,
    });
    updateToggle();
    scheduleReconcile();
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.closest('[inert], [aria-hidden="true"]')) return false;

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      style.pointerEvents === 'none'
    ) {
      return false;
    }

    if (typeof element.checkVisibility === 'function') {
      try {
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch {
        // Older Chromium may reject options; the bounding box check still fails closed for zero-size nodes.
      }
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isUsableComposer(element) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) return false;
    if (element.getAttribute('aria-disabled') === 'true') return false;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return !element.disabled && !element.readOnly;
    }
    return element.isContentEditable || element.getAttribute('contenteditable') === 'true';
  }

  function getComposerState() {
    const candidates = [...document.querySelectorAll('#prompt-textarea')];
    if (candidates.length !== 1 || !isUsableComposer(candidates[0])) {
      return {
        known: false,
        empty: false,
        text: '',
        attachments: false,
        candidateCount: candidates.length,
      };
    }

    const composer = candidates[0];
    const rawText = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
      ? composer.value
      : composer.innerText || composer.textContent || '';
    const text = normalizeText(rawText);
    const scope = composer.closest('form') || composer.parentElement;
    let attachments = false;

    if (scope) {
      attachments = Boolean(scope.querySelector(ATTACHMENT_SELECTOR));
      if (!attachments) {
        attachments = [...scope.querySelectorAll('input[type="file"]')]
          .some(input => input instanceof HTMLInputElement && input.files?.length > 0);
      }
    }

    return {
      known: true,
      empty: text === '' && !attachments,
      text,
      attachments,
      candidateCount: 1,
    };
  }

  function isEnabledButton(button) {
    return (
      button instanceof HTMLButtonElement &&
      !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' &&
      isVisible(button)
    );
  }

  function getExactButtonSemantics(button) {
    if (!(button instanceof HTMLButtonElement)) {
      return { continueSemantic: false, stopSemantic: false, conflicting: false };
    }
    const text = normalizeText(button.textContent);
    const ariaLabel = normalizeText(button.getAttribute('aria-label'));
    const continueSemantic = CONTINUE_LABELS.has(text) || CONTINUE_LABELS.has(ariaLabel);
    const stopSemantic = STOP_LABELS.has(text) || STOP_LABELS.has(ariaLabel);
    return {
      continueSemantic,
      stopSemantic,
      conflicting: continueSemantic && stopSemantic,
    };
  }

  function hasContinueSemantic(button) {
    const semantics = getExactButtonSemantics(button);
    return semantics.continueSemantic && !semantics.conflicting;
  }

  function isNativeContinueButton(button) {
    if (!isEnabledButton(button)) return false;
    if (button.matches(STOP_SELECTOR)) return false;
    if (button.getAttribute(CLICKED_ATTRIBUTE) === '1') return false;
    return hasContinueSemantic(button);
  }

  function isKnownStopButton(button) {
    if (!isEnabledButton(button)) return false;
    const semantics = getExactButtonSemantics(button);
    if (semantics.conflicting || semantics.continueSemantic) return false;
    if (button.matches(STOP_SELECTOR)) return true;
    return semantics.stopSemantic;
  }

  function findNativeContinueButton() {
    const matches = [...document.querySelectorAll('button')].filter(isNativeContinueButton);
    if (matches.length === 0) return { kind: 'none', button: null };
    if (matches.length > 1) return { kind: 'ambiguous', button: null };
    return { kind: 'one', button: matches[0] };
  }

  function consumeExistingContinueControls(reason) {
    let consumed = 0;
    for (const button of document.querySelectorAll('button')) {
      if (!(button instanceof HTMLButtonElement) || !hasContinueSemantic(button)) continue;
      button.setAttribute(CLICKED_ATTRIBUTE, '1');
      consumed += 1;
    }
    if (consumed > 0) log(`marked existing continuation controls consumed: ${reason}`, { consumed });
  }

  function getStableUserMessageIdentity(element) {
    if (!(element instanceof Element)) return null;
    const messageIdOwner = element.matches('[data-message-id]')
      ? element
      : element.closest('[data-message-id]');
    const messageId = messageIdOwner?.getAttribute('data-message-id');
    if (messageId) return `message:${messageId}`;

    const turnOwner = element.matches('[data-testid^="conversation-turn-"]')
      ? element
      : element.closest('[data-testid^="conversation-turn-"]');
    const turnId = turnOwner?.getAttribute('data-testid');
    if (turnId && /^conversation-turn-[A-Za-z0-9_-]+$/.test(turnId)) return `turn:${turnId}`;

    return null;
  }

  function getLatestUserMessageIdentity() {
    const messages = [...document.querySelectorAll(USER_MESSAGE_SELECTOR)]
      .filter(element => element instanceof HTMLElement && isVisible(element));
    if (messages.length === 0) return null;
    return getStableUserMessageIdentity(messages[messages.length - 1]);
  }

  function markOwnerSubmissionIntent() {
    if (!currentConversationId || !persistenceHealthy) return;
    const composer = getComposerState();
    if (!composer.known || composer.empty) return;
    const baselineUserMessageIdentity = getLatestUserMessageIdentity();
    if (!baselineUserMessageIdentity) {
      logSuppression('cannot identify the latest user message; submission reset not armed');
      return;
    }

    if (
      submissionIntent &&
      submissionIntent.conversationId === currentConversationId &&
      submissionIntent.baselineUserMessageIdentity === baselineUserMessageIdentity &&
      Date.now() <= submissionIntent.expiresAt
    ) {
      return;
    }

    cancelPendingClick();
    consumeExistingContinueControls('Owner submission intent');
    submissionIntent = {
      conversationId: currentConversationId,
      baselineUserMessageIdentity,
      expiresAt: Date.now() + SUBMISSION_INTENT_TTL_MS,
    };
    log('Owner submission intent armed', {
      conversationId: currentConversationId,
      baselineUserMessageIdentity,
    });
    scheduleReconcile();
  }

  function maybeConfirmOwnerSubmission() {
    if (!submissionIntent) return false;
    if (Date.now() > submissionIntent.expiresAt) {
      submissionIntent = null;
      log('Owner submission intent expired without user-message evidence');
      return false;
    }
    if (submissionIntent.conversationId !== currentConversationId) {
      submissionIntent = null;
      log('Owner submission intent cancelled after conversation change');
      return false;
    }

    const latestUserMessageIdentity = getLatestUserMessageIdentity();
    if (!latestUserMessageIdentity) return false;
    if (latestUserMessageIdentity === submissionIntent.baselineUserMessageIdentity) return false;

    consumeExistingContinueControls('confirmed Owner submission');
    const confirmedIdentity = latestUserMessageIdentity;
    const reset = resetChain('confirmed same-conversation user message');
    if (reset) log('Owner submission confirmed', { userMessageIdentity: confirmedIdentity });
    return reset;
  }

  function cancelPendingClick() {
    if (pendingClickTimer !== null) {
      window.clearTimeout(pendingClickTimer);
      pendingClickTimer = null;
    }
    pendingControl = null;
  }

  function scheduleNativeContinueClick(button) {
    if (pendingControl || button.getAttribute(CLICKED_ATTRIBUTE) === '1') return;

    pendingControl = button;
    clearSuppressionLog();
    log('native continuation detected; settling before click');

    pendingClickTimer = window.setTimeout(() => {
      pendingClickTimer = null;
      const candidate = pendingControl;
      pendingControl = null;

      if (syncConversation()) {
        scheduleReconcile();
        return;
      }
      if (maybeConfirmOwnerSubmission()) {
        scheduleReconcile();
        return;
      }

      if (destroyed || !enabled || !candidate || !persistenceHealthy) return;
      if (submissionIntent) {
        logSuppression('Owner submission is awaiting same-conversation user-message evidence');
        return;
      }
      if (manualStopSuppressed) {
        logSuppression('Owner manually stopped generation');
        return;
      }
      if (chainCount >= MAX_CHAIN_CONTINUATIONS) {
        logSuppression('continuation chain limit reached', { limit: MAX_CHAIN_CONTINUATIONS });
        updateToggle();
        return;
      }

      const composer = getComposerState();
      if (!composer.known) {
        logSuppression('composer state is unknown or ambiguous', {
          candidateCount: composer.candidateCount,
        });
        return;
      }
      if (!composer.empty) {
        logSuppression(
          composer.attachments ? 'composer contains a recognized attachment' : 'composer contains Owner text',
        );
        return;
      }

      const currentMatch = findNativeContinueButton();
      if (currentMatch.kind !== 'one' || currentMatch.button !== candidate) {
        logSuppression(
          currentMatch.kind === 'ambiguous'
            ? 'native continuation control became ambiguous during settle'
            : 'native continuation control changed during settle',
        );
        scheduleReconcile();
        return;
      }

      const nextChainCount = chainCount + 1;
      if (!persistRuntimeState(nextChainCount, manualStopSuppressed)) return;
      chainCount = nextChainCount;
      candidate.setAttribute(CLICKED_ATTRIBUTE, '1');
      clearSuppressionLog();
      updateToggle();
      log('clicking native Continue generating control', {
        chainCount,
        limit: MAX_CHAIN_CONTINUATIONS,
      });

      autoClickInProgress = true;
      try {
        candidate.click();
      } finally {
        autoClickInProgress = false;
      }
    }, CLICK_SETTLE_MS);
  }

  function reconcile() {
    if (destroyed) return;
    if (syncConversation()) {
      scheduleReconcile();
      return;
    }
    if (maybeConfirmOwnerSubmission()) {
      scheduleReconcile();
      return;
    }

    if (!currentConversationId || !persistenceHealthy || !enabled) return;
    if (submissionIntent) {
      cancelPendingClick();
      logSuppression('Owner submission is awaiting same-conversation user-message evidence');
      return;
    }
    if (manualStopSuppressed) {
      logSuppression('Owner manually stopped generation');
      return;
    }
    if (chainCount >= MAX_CHAIN_CONTINUATIONS) {
      logSuppression('continuation chain limit reached', { limit: MAX_CHAIN_CONTINUATIONS });
      updateToggle();
      return;
    }

    const composer = getComposerState();
    if (!composer.known) {
      logSuppression('composer state is unknown or ambiguous', {
        candidateCount: composer.candidateCount,
      });
      return;
    }
    if (!composer.empty) {
      logSuppression(
        composer.attachments ? 'composer contains a recognized attachment' : 'composer contains Owner text',
      );
      return;
    }

    const match = findNativeContinueButton();
    if (match.kind === 'ambiguous') {
      logSuppression('multiple unused native continuation controls are visible');
      return;
    }
    if (match.kind === 'none') {
      clearSuppressionLog();
      return;
    }

    scheduleNativeContinueClick(match.button);
  }

  function scheduleReconcile(delay = RECONCILE_DELAY_MS) {
    if (destroyed || reconcileTimer !== null) return;
    reconcileTimer = window.setTimeout(() => {
      reconcileTimer = null;
      reconcile();
    }, delay);
  }

  function isSendButton(element) {
    return element instanceof Element && Boolean(element.closest(SEND_SELECTOR));
  }

  function isComposerElement(element) {
    return element instanceof Element && Boolean(element.closest('#prompt-textarea'));
  }

  function onClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest('button');
    if (button instanceof HTMLButtonElement && isKnownStopButton(button)) {
      if (persistRuntimeState(chainCount, true)) {
        manualStopSuppressed = true;
        submissionIntent = null;
        cancelPendingClick();
        logSuppression('Owner manually stopped generation');
        updateToggle();
      }
      return;
    }

    if (button instanceof HTMLButtonElement && isNativeContinueButton(button)) {
      button.setAttribute(CLICKED_ATTRIBUTE, '1');
      cancelPendingClick();
      if (!autoClickInProgress && persistRuntimeState(chainCount, false)) {
        manualStopSuppressed = false;
        clearSuppressionLog();
        log('Owner manually continued generation; automatic chain count preserved');
        updateToggle();
        scheduleReconcile();
      }
      return;
    }

    if (isSendButton(target)) markOwnerSubmissionIntent();
  }

  function onKeyDown(event) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.isComposing &&
      isComposerElement(event.target)
    ) {
      markOwnerSubmissionIntent();
    }
  }

  function onSubmit(event) {
    if (
      event.target instanceof HTMLFormElement &&
      event.target.querySelector('#prompt-textarea')
    ) {
      markOwnerSubmissionIntent();
    }
  }

  function onComposerInput(event) {
    if (isComposerElement(event.target)) scheduleReconcile();
  }

  function ensureToggle() {
    let toggle = document.getElementById(TOGGLE_ID);
    if (toggle instanceof HTMLButtonElement) return toggle;

    toggle = document.createElement('button');
    toggle.id = TOGGLE_ID;
    toggle.type = 'button';
    toggle.addEventListener('click', () => setEnabled(!enabled));
    Object.assign(toggle.style, {
      position: 'fixed',
      right: '16px',
      bottom: '88px',
      zIndex: '2147483647',
      border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
      borderRadius: '999px',
      padding: '6px 10px',
      background: 'color-mix(in srgb, Canvas 92%, transparent)',
      color: 'CanvasText',
      font: '12px/1.2 system-ui, sans-serif',
      boxShadow: '0 2px 8px rgb(0 0 0 / 18%)',
      cursor: 'pointer',
      opacity: '0.88',
    });
    document.documentElement.append(toggle);
    return toggle;
  }

  function updateToggle() {
    if (destroyed) return;
    const toggle = ensureToggle();
    const unavailable = !persistenceHealthy;
    const noConversation = !currentConversationId;
    const countSuffix = chainCount > 0 ? ` ${chainCount}/${MAX_CHAIN_CONTINUATIONS}` : '';
    const stoppedSuffix = manualStopSuppressed ? ' Paused' : '';

    if (unavailable) toggle.textContent = 'Auto Continue: Unavailable';
    else if (noConversation) toggle.textContent = 'Auto Continue: Open a chat';
    else toggle.textContent = `Auto Continue: ${enabled ? 'On' : 'Off'}${countSuffix}${stoppedSuffix}`;

    toggle.disabled = unavailable || noConversation;
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.title = unavailable
      ? `Disabled because required browser storage failed${persistenceFailureReason ? `: ${persistenceFailureReason}` : ''}. Reload after fixing browser storage access.`
      : noConversation
        ? 'Open an existing ChatGPT conversation before enabling Auto Continue.'
        : enabled
          ? 'Native cut-off continuation enabled for this conversation.'
          : 'Native cut-off continuation disabled for this conversation.';
  }

  function installHistoryHooks() {
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    function wrapHistoryMethod(original) {
      return function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event('deviltea:locationchange'));
        return result;
      };
    }

    const wrappedPushState = wrapHistoryMethod(originalPushState);
    const wrappedReplaceState = wrapHistoryMethod(originalReplaceState);
    window.history.pushState = wrappedPushState;
    window.history.replaceState = wrappedReplaceState;

    return () => {
      if (window.history.pushState === wrappedPushState) window.history.pushState = originalPushState;
      if (window.history.replaceState === wrappedReplaceState) window.history.replaceState = originalReplaceState;
    };
  }

  const restoreHistoryHooks = installHistoryHooks();

  function onLocationChange() {
    syncConversation();
    scheduleReconcile();
  }

  window.addEventListener('popstate', onLocationChange);
  window.addEventListener('hashchange', onLocationChange);
  window.addEventListener('deviltea:locationchange', onLocationChange);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('input', onComposerInput, true);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'disabled',
      'aria-disabled',
      'aria-hidden',
      'aria-label',
      'hidden',
      'class',
      'style',
      'data-message-id',
      'data-message-author-role',
      'data-testid',
    ],
    characterData: true,
  });

  updateToggle();
  scheduleReconcile(0);

  window[CONTROLLER_KEY] = {
    enable() {
      setEnabled(true);
    },
    disable() {
      setEnabled(false);
    },
    reconcile,
    get status() {
      return {
        conversationId: currentConversationId,
        enabled,
        chainCount,
        chainLimit: MAX_CHAIN_CONTINUATIONS,
        manualStopSuppressed,
        persistenceHealthy,
        persistenceFailureReason,
        submissionIntent: submissionIntent
          ? {
              conversationId: submissionIntent.conversationId,
              baselineUserMessageIdentity: submissionIntent.baselineUserMessageIdentity,
              expiresAt: submissionIntent.expiresAt,
            }
          : null,
        pending: pendingControl !== null,
        composer: getComposerState(),
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      enabled = false;
      submissionIntent = null;
      cancelPendingClick();
      if (reconcileTimer !== null) {
        window.clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
      observer.disconnect();
      restoreHistoryHooks();
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('hashchange', onLocationChange);
      window.removeEventListener('deviltea:locationchange', onLocationChange);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('input', onComposerInput, true);
      document.getElementById(TOGGLE_ID)?.remove();
      log('destroyed');
    },
  };

  log('loaded', {
    conversationId: currentConversationId,
    enabled,
    chainCount,
    persistenceHealthy,
  });
})();
