// content.js

console.log(
  "[Vivid Chat][content] Content script loaded",
  window.location.href
);

// 선택 텍스트 모드 활성화 플래그 (v0.1에서는 false로 설정)
const ENABLE_SELECTION_MODE = false;

// 자동 업데이트용 상태 변수
let lastAutoTurnText = null; // 마지막으로 auto-update로 보낸 턴 텍스트 캐시
let autoUpdateObserver = null;
let locationCheckInterval = null; // location.href 감시 interval
let lastCheckedPath = null; // 마지막으로 확인한 pathname
let lastAutoUpdateRequestTime = 0; // 마지막 자동 업데이트 요청 시간 (debounce용)
let __vividLastAutoAnalyzeKey = null; // 마지막으로 분석한 턴의 키 (중복 방지용)

// ============================================================================
// Extension Context 안전성 체크 및 안전한 메시지 전송
// ============================================================================

/**
 * Extension context가 살아있는지 확인
 * @returns {boolean}
 */
function isExtensionContextAlive() {
  try {
    return !!(chrome?.runtime?.id);
  } catch (e) {
    return false;
  }
}

/**
 * Extension context invalidated 에러인지 확인
 * @param {Error|any} err 
 * @returns {boolean}
 */
function isContextInvalidatedError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("Extension context invalidated")
      || msg.includes("The message port closed")
      || msg.includes("message port closed");
}

/**
 * 안전한 메시지 전송 래퍼 (Extension context invalidated 방어)
 * @param {Object} message 
 * @returns {Promise<{ok: boolean, reason?: string, error?: string, resp?: any}>}
 */
function safeSendMessage(message) {
  return new Promise((resolve) => {
    // ✅ Extension context 체크
    if (!isExtensionContextAlive()) {
      return resolve({ ok: false, reason: "runtime_missing" });
    }

    try {
      chrome.runtime.sendMessage(message, (resp) => {
        try {
          // MV3에서 실패하면 lastError가 잡힘
          const err = chrome.runtime?.lastError;
          if (err) {
            const errorMsg = err?.message || String(err);
            // Extension context invalidated 에러 감지
            if (isContextInvalidatedError({ message: errorMsg })) {
              return resolve({ ok: false, reason: "context_invalidated", error: errorMsg });
            }
            return resolve({ ok: false, reason: "lastError", error: errorMsg });
          }
          resolve({ ok: true, resp });
        } catch (callbackErr) {
          // 콜백 내부에서 발생한 에러도 처리
          const errorMsg = String(callbackErr?.message || callbackErr);
          if (isContextInvalidatedError(callbackErr)) {
            return resolve({ ok: false, reason: "context_invalidated", error: errorMsg });
          }
          resolve({ ok: false, reason: "callback_exception", error: errorMsg });
        }
      });
    } catch (e) {
      // sendMessage 호출 자체에서 발생한 에러
      const errorMsg = String(e?.message || e);
      if (isContextInvalidatedError(e)) {
        return resolve({ ok: false, reason: "context_invalidated", error: errorMsg });
      }
      resolve({ ok: false, reason: "exception", error: errorMsg });
    }
  });
}

/**
 * autoUpdateObserver를 안전하게 중지
 * @param {string} reason 
 */
function stopAutoUpdateObserver(reason) {
  try {
    if (autoUpdateObserver) {
      autoUpdateObserver.disconnect();
      autoUpdateObserver = null;
    }
    // timer 정리
    if (typeof lastAutoUpdateRequestTime !== 'undefined') {
      lastAutoUpdateRequestTime = 0;
    }
    // 캐시 초기화
    lastAutoTurnText = null;
    __vividLastAutoAnalyzeKey = null;
  } catch (_) {
    // 무시
  }
  console.log("[Vivid Chat][content] autoUpdateObserver stopped:", reason);
}

// 선택된 텍스트 가져오기
function getSelectedText() {
  const selection = window.getSelection();
  if (!selection) return "";
  const text = selection.toString().trim();
  return text;
}

// 선택된 텍스트를 background로 보내기
function sendSelectedText(text) {
  if (!ENABLE_SELECTION_MODE) return;
  
  if (!text) return;

  // 1단계: chrome.runtime 자체가 있는지 확인
  if (!chrome || !chrome.runtime) {
    console.warn(
      "[Vivid Chat][content] chrome.runtime is not available",
      chrome && chrome.runtime
    );
    return;
  }

  // 2단계: sendMessage 함수 존재 확인
  if (typeof chrome.runtime.sendMessage !== "function") {
    console.warn(
      "[Vivid Chat][content] chrome.runtime.sendMessage is not a function",
      chrome.runtime
    );
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "TEXT_SELECTED",
      text,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[Vivid Chat][content] sendMessage error:",
          chrome.runtime.lastError.message
        );
        return;
      }

      console.log(
        "[Vivid Chat][content] TEXT_SELECTED sent to background:",
        text.slice(0, 80),
        "response:",
        response
      );
    }
  );
}

// mouseup 시점에 선택된 텍스트 검사
document.addEventListener("mouseup", () => {
  if (!ENABLE_SELECTION_MODE) return;
  
  const text = getSelectedText();
  if (!text) return;

  console.log(
    "[Vivid Chat][content] Text selected:",
    text.slice(0, 80)
  );

  sendSelectedText(text);
});

// rofan.ai 채팅 페이지 여부 확인 함수
// /chat/... 또는 /en/chat/... 경로 모두 지원
function isRofanChatPage() {
  const url = new URL(window.location.href);
  if (url.host !== 'rofan.ai') {
    return false;
  }
  
  const path = url.pathname;
  // /chat/... 또는 /en/chat/... 경로 체크
  return path.startsWith('/chat/') || path.startsWith('/en/chat/');
}

// scenarioKey 추출 유틸 함수
// /chat/... 또는 /en/chat/... 경로 모두 지원
function getScenarioKeyFromLocation(loc) {
  try {
    const url = new URL(loc.href);
    if (url.hostname === 'rofan.ai') {
      const path = url.pathname;
      // /chat/... 또는 /en/chat/... 경로 체크
      if (path.startsWith('/chat/') || path.startsWith('/en/chat/')) {
        return `${url.origin}${url.pathname}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * DOM에서 마지막 턴을 (User+AI) 세트로 추출
 * @returns {Object|null} { lastBlock, userText, aiText } 또는 null
 */
function extractLastTurnPairFromDom() {
  const blocks = Array.from(document.querySelectorAll("div.mt-5"));
  if (!blocks.length) return null;

  const lastBlock = blocks[blocks.length - 1];
  const ps = Array.from(lastBlock.querySelectorAll("p"));
  if (!ps.length) return null;

  const aiP = ps.find((p) => p.classList.contains("mt-1")) || null;
  const userP = ps.find((p) => !p.classList.contains("mt-1")) || null;

  const userText = userP?.innerText?.trim() || "";
  const aiText = aiP?.innerText?.trim() || "";

  return { lastBlock, userText, aiText };
}

/**
 * 분석 키 생성 (중복 판정용)
 * @param {string} chatId 
 * @param {string} userText 
 * @param {string} aiText 
 * @returns {string}
 */
function makeAnalyzeKey(chatId, userText, aiText) {
  const u = (userText || "").slice(0, 2000);
  const a = (aiText || "").slice(0, 4000);
  return `${chatId}::u:${u.length}:${u}::a:${a.length}:${a}`;
}

// rofan.ai에서 마지막 AI 메시지 추출 함수 (DOM 최우선) - User+AI 세트 반환
async function extractLastAiMessageFromRofanAi() {
  // chatId 추출
  const chatId = getChatIdFromLocation();
  console.log('[debug] chatId from loc', chatId);
  if (!chatId) {
    console.warn('[Vivid Chat][content] Cannot extract chatId from location');
    return {
      success: false,
      provider: 'rofan-ai',
    };
  }

  // ✅ Priority 1: DOM (div.mt-5 기반)에서 마지막 턴 (User+AI) 세트 추출
  const pair = extractLastTurnPairFromDom();
  
  if (pair && pair.aiText) {
    // User+AI 세트로 반환
    const { userText, aiText } = pair;
    
    // 디버깅 로그: source와 textPreview 출력
    const userPreview = userText ? userText.slice(0, 60) + ` (len: ${userText.length})` : '(empty)';
    const aiPreview = aiText.slice(0, 60) + ` (len: ${aiText.length})`;
    console.log(
      "[Vivid Chat][content] last turn extracted:",
      { source: 'dom', userPreview, aiPreview }
    );
    
    return {
      success: true,
      provider: 'rofan-ai',
      source: 'dom',
      text: aiText, // 하위 호환성: 기존 text 필드 유지
      userText: userText || '', // 새 필드 추가
      aiText: aiText, // 새 필드 추가
    };
  }

  // ✅ Priority 2: DOM이 비어있거나 실패할 때만 Storage 로그 fallback
  const logs = await getChatLogsFromStorage(chatId);
  const lastAssistantText = getLastAssistantTurnFromStore(logs);

  if (lastAssistantText) {
    // 디버깅 로그: source와 textPreview 출력
    const textPreview = lastAssistantText.slice(0, 80) + ` (len: ${lastAssistantText.length})`;
    console.log(
      "[Vivid Chat][content] lastAI extracted:",
      { source: 'store', textPreview }
    );
    return {
      success: true,
      provider: 'rofan-ai',
      source: 'store',
      text: lastAssistantText,
    };
  }

  // ✅ Priority 3: 여전히 없으면 first_message fallback (첫 시작 케이스)
  // 스토어에서 first_message 확인
  return new Promise((resolve) => {
    // ✅ Extension context 체크
    if (!isExtensionContextAlive()) {
      console.log('[Vivid Chat][content] Cannot get first_message: context invalidated');
      resolve({ success: false, provider: 'rofan-ai' });
      return;
    }
    
    try {
      chrome.storage.local.get([`first_message::${chatId}`], (result) => {
        try {
          // ✅ Extension context 체크 (콜백 내부)
          if (!isExtensionContextAlive()) {
            resolve({ success: false, provider: 'rofan-ai' });
            return;
          }
          
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
            if (isContextInvalidatedError({ message: errorMsg })) {
              console.log('[Vivid Chat][content] Storage context invalidated in first_message get');
              resolve({ success: false, provider: 'rofan-ai' });
              return;
            }
            console.warn('[Vivid Chat][content] Failed to get first_message:', chrome.runtime.lastError);
            // 에러가 나도 __NEXT_DATA__ fallback 시도
          } else {
            const firstMessage = result[`first_message::${chatId}`];
            if (firstMessage && typeof firstMessage === 'string' && firstMessage.trim()) {
              // 디버깅 로그: source와 textPreview 출력
              const textPreview = firstMessage.slice(0, 80) + ` (len: ${firstMessage.length})`;
              console.log(
                "[Vivid Chat][content] lastAI extracted:",
                { source: 'first_message_store', textPreview }
              );
              resolve({
                success: true,
                provider: 'rofan-ai',
                source: 'first_message',
                text: firstMessage.trim(),
              });
              return;
            }
          }

          // 4) 스토어에 first_message가 없으면 __NEXT_DATA__에서 직접 파싱 시도
          try {
            const el = document.querySelector('#__NEXT_DATA__');
            if (el && el.textContent) {
              const json = JSON.parse(el.textContent);
              const pp = json?.props?.pageProps || json?.pageProps;
              const botDetail = pp?.botDetail || pp?.oriBotDetail;
              const firstMessage = botDetail?.first_message;

              if (firstMessage && typeof firstMessage === 'string' && firstMessage.trim()) {
                const text = firstMessage.trim();
                
                // storage에 저장 (재사용 목적)
                try {
                  if (isExtensionContextAlive()) {
                    chrome.storage.local.set({
                      [`first_message::${chatId}`]: text,
                    }, () => {
                      if (chrome.runtime.lastError) {
                        const errorMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
                        if (isContextInvalidatedError({ message: errorMsg })) {
                          console.log('[Vivid Chat][content] Storage context invalidated in first_message set');
                          return;
                        }
                        console.warn('[Vivid Chat][content] Failed to save first_message to storage:', chrome.runtime.lastError);
                      }
                    });
                  }
                } catch (e) {
                  if (isContextInvalidatedError(e)) {
                    console.log('[Vivid Chat][content] Storage exception (context invalidated) in first_message set');
                  } else {
                    console.warn('[Vivid Chat][content] Storage exception in first_message set:', e);
                  }
                }

                // 디버깅 로그: source와 textPreview 출력
                const textPreview = text.slice(0, 80) + ` (len: ${text.length})`;
                console.log(
                  "[Vivid Chat][content] lastAI extracted:",
                  { source: 'first_message_store', textPreview }
                );
                resolve({
                  success: true,
                  provider: 'rofan-ai',
                  source: 'first_message',
                  text,
                });
                return;
              }
            }
          } catch (err) {
            if (isContextInvalidatedError(err)) {
              console.log('[Vivid Chat][content] Storage call context invalidated');
            } else {
              console.warn('[Vivid Chat][content] Failed to parse __NEXT_DATA__ for first_message:', err);
            }
          }
        } catch (callbackErr) {
          if (isContextInvalidatedError(callbackErr)) {
            console.log('[Vivid Chat][content] Storage callback context invalidated');
          } else {
            console.warn('[Vivid Chat][content] Storage callback error:', callbackErr);
          }
        }
      });
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        console.log('[Vivid Chat][content] Storage call context invalidated');
      } else {
        console.warn('[Vivid Chat][content] Storage call exception:', err);
      }
      resolve({ success: false, provider: 'rofan-ai' });
    }
  });

  // 5) DOM 2차 방어선: "첫 메시지" 전용 블록 추출
  // - mt-5가 없거나(대화 0턴) store/next_data가 실패한 상황에서만 의미 있음
  try {
    const chatRoot =
      document.querySelector('div.lg\\:pr-5.overflow-y-auto') ||
      document.querySelector('main') ||
      document.body;

    const candidates = Array.from(
      chatRoot.querySelectorAll('div[style*="font-size: 14px"][style*="line-height: 1.5rem"]')
    );

    if (candidates.length > 0) {
      const last = candidates[candidates.length - 1]; // 마지막 후보 선택
      const text = last?.innerText?.trim();

      if (text && text.length >= 2) {
        // 디버깅 로그: source와 textPreview 출력
        const textPreview = text.slice(0, 80) + ` (len: ${text.length})`;
        console.log(
          "[Vivid Chat][content] lastAI extracted:",
          { source: 'dom_first', textPreview }
        );
        return Promise.resolve({
          success: true,
          provider: 'rofan-ai',
          source: 'dom_first',
          text,
        });
      }
    }
  } catch (e) {
    console.warn('[Vivid Chat][content] DOM first_message fallback failed:', e);
  }

  // 6) 모두 실패 시 에러
  console.warn(
    '[Vivid Chat][content] lastAI not found (store empty, dom not matched, first_message missing)'
  );
  return Promise.resolve({
    success: false,
    provider: 'rofan-ai',
  });
}

/**
 * URL에서 chatId 추출
 */
function getChatIdFromLocation() {
  try {
    const url = new URL(window.location.href);
    const pathMatch = url.pathname.match(/\/(?:en\/)?chat\/([^\/]+)/);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * chatId 후보군 추출 (URL chatId + __NEXT_DATA__ chatId)
 */
function getChatIdKeyCandidatesFromNextData(pp) {
  const fromLoc = getChatIdFromLocation(); // URL uuid
  const fromNext = pp?.chatId ?? pp?.oriChatData?.chat_id ?? pp?.oriChatData?.id ?? null; // 내부 id
  return Array.from(new Set([fromLoc, fromNext].filter(Boolean).map(String)));
}

// ============================================================================
// Bot Context 저장 공통 함수
// ============================================================================

/**
 * Bot Context를 chrome.storage.local에 저장하는 공통 함수
 */
function storeBotContext(chatId, botId, botName, charPersona, worldview, userName, userPersona, updatedAt) {
  if (!chatId || !botId) {
    return false;
  }

  // session_map::{chatId} = botId
  const sessionMapKey = `session_map::${chatId}`;
  
  // bot_master::{botId} = { botName, charPersona, worldview, updatedAt }
  const botMasterKey = `bot_master::${botId}`;
  const botMasterData = {
    botName: botName,
    charPersona: charPersona,
    worldview: worldview,
    updatedAt: updatedAt || Date.now(),
  };

  // chat_user::{chatId} = { userName, userPersona, updatedAt } (선택)
  const storageData = {
    [sessionMapKey]: botId,
    [botMasterKey]: botMasterData,
  };

  if (userName || userPersona) {
    storageData[`chat_user::${chatId}`] = {
      userName: userName,
      userPersona: userPersona,
      updatedAt: updatedAt || Date.now(),
    };
  }

  // ✅ Extension context 체크
  if (!isExtensionContextAlive()) {
    console.log('[Vivid Chat][content] Cannot save bot context: context invalidated');
    return false;
  }
  
  try {
    chrome.storage.local.set(storageData, () => {
      try {
        // ✅ Extension context 체크 (콜백 내부)
        if (!isExtensionContextAlive()) {
          return;
        }
        
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
          if (isContextInvalidatedError({ message: errorMsg })) {
            console.log('[Vivid Chat][content] Storage context invalidated in bot context set');
            return;
          }
          console.error('[Vivid Chat][content] Failed to save to storage:', chrome.runtime.lastError);
          return;
        }

        console.log('[Vivid Chat][content][store] saved session_map/bot_master', {
          chatId: chatId,
          botId: botId,
          hasPersona: !!botMasterData.charPersona,
          hasWorldview: !!botMasterData.worldview,
        });
      } catch (callbackErr) {
        if (isContextInvalidatedError(callbackErr)) {
          console.log('[Vivid Chat][content] Storage callback context invalidated');
        }
      }
    });
  } catch (e) {
    if (isContextInvalidatedError(e)) {
      console.log('[Vivid Chat][content] Storage call context invalidated');
    } else {
      console.warn('[Vivid Chat][content] Storage call exception:', e);
    }
    return false;
  }

  return true;
}

// ============================================================================
// MAIN world로부터 ROFAN_NEXT_DATA 메시지 수신 및 저장
// ============================================================================

window.addEventListener('message', (event) => {
  // 보안: 같은 origin에서만 수신 (rofan.ai 페이지에서만)
  if (event.origin !== 'https://rofan.ai') {
    return;
  }

  if (!event.data || event.data.type !== 'ROFAN_NEXT_DATA') {
    return;
  }

  const payload = event.data.payload;
  if (!payload || !payload.chatId || !payload.botId) {
    console.warn('[Vivid Chat][content] Invalid ROFAN_NEXT_DATA payload:', payload);
    return;
  }

  // 공통 저장 함수 사용
  storeBotContext(
    payload.chatId,
    payload.botId,
    payload.botName,
    payload.charPersona,
    payload.worldview,
    payload.userName,
    payload.userPersona,
    payload.updatedAt
  );
});

// ============================================================================
// 초기 채팅 로그 세팅 (입장 시 1회성)
// ============================================================================

/**
 * __NEXT_DATA__에서 initialChatLogs를 추출하여 storage에 저장
 * 입장 시 1회만 실행, DOM을 신뢰하지 않음
 */
function hydrateInitialChatLogsFromNextData() {
  try {
    const el = document.querySelector('#__NEXT_DATA__');
    if (!el || !el.textContent) {
      return false;
    }

    const json = JSON.parse(el.textContent);
    const pp = json?.props?.pageProps || json?.pageProps;

    if (!pp) {
      return false;
    }

    // chatId 후보군 추출
    const chatIdCandidates = getChatIdKeyCandidatesFromNextData(pp);
    if (chatIdCandidates.length === 0) {
      return false;
    }

    const initialChatLogs = pp.initialChatLogs || pp.chatLogs || pp.logs;
    const botDetail = pp.botDetail || pp.oriBotDetail;
    const firstMessage = botDetail?.first_message;

    // initialChatLogs가 없어도 first_message는 저장 (첫 메시지 상황 대비)
    let hasData = false;
    const normalizedLogs = [];

    if (Array.isArray(initialChatLogs) && initialChatLogs.length > 0) {
      // 로그 정규화 (다양한 필드명 대응)
      initialChatLogs.forEach(log => {
        // user_chat, bot_chat 형식
        if (log.user_chat !== undefined || log.bot_chat !== undefined) {
          normalizedLogs.push({
            logId: log.log_id || log.id || null,
            userText: log.user_chat || null,
            assistantText: log.bot_chat || null,
            createdAt: log.created || log.created_at || null,
          });
        }
        // role/content 형식
        else if (log.role !== undefined) {
          normalizedLogs.push({
            logId: log.log_id || log.id || null,
            userText: log.role === 'user' ? (log.content || log.message || log.text || '') : null,
            assistantText: log.role === 'assistant' || log.role === 'ai' || log.role === 'bot' 
              ? (log.content || log.message || log.text || '') 
              : null,
            createdAt: log.created || log.created_at || null,
          });
        }
        // 기본 형식
        else {
          normalizedLogs.push({
            logId: log.log_id || log.id || null,
            userText: log.userText || log.user || null,
            assistantText: log.assistantText || log.assistant || log.ai || null,
            createdAt: log.created || log.created_at || log.createdAt || null,
          });
        }
      });
      hasData = true;
    }

    // first_message는 initialChatLogs가 없어도 저장 (첫 메시지 상황 대비)
    if (firstMessage && typeof firstMessage === 'string' && firstMessage.trim()) {
      hasData = true;
    }

    // 데이터가 하나라도 있으면 저장
    if (!hasData) {
      return false;
    }

    // chatId 후보군 모두에 저장
    const storageData = {};
    chatIdCandidates.forEach(id => {
      if (normalizedLogs.length > 0) {
        storageData[`chat_logs::${id}`] = normalizedLogs;
        storageData[`chat_logs_initialized::${id}`] = true;
      }
      if (firstMessage && typeof firstMessage === 'string' && firstMessage.trim()) {
        storageData[`first_message::${id}`] = firstMessage.trim();
        storageData[`chat_logs_initialized::${id}`] = true; // ✅ 중요: first_message만 있어도 initialized 처리
      }
    });

    // 디버그 로그
    console.log('[debug] hydrated keys', Object.keys(storageData), 'chatIdCandidates:', chatIdCandidates);

    // storage에 저장
    // ✅ Extension context 체크
    if (!isExtensionContextAlive()) {
      console.log('[Vivid Chat][content] Cannot save initialChatLogs: context invalidated');
      return false;
    }
    
    try {
      chrome.storage.local.set(storageData, () => {
        try {
          // ✅ Extension context 체크 (콜백 내부)
          if (!isExtensionContextAlive()) {
            return;
          }
          
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
            if (isContextInvalidatedError({ message: errorMsg })) {
              console.log('[Vivid Chat][content] Storage context invalidated in initialChatLogs set');
              return;
            }
            console.error('[Vivid Chat][content] Failed to save initialChatLogs:', chrome.runtime.lastError);
            return;
          }

          const assistantCount = normalizedLogs.filter(log => log.assistantText).length;
          console.log('[Vivid Chat][content] initialChatLogs hydrated', {
            chatIdCandidates: chatIdCandidates,
            totalLogs: normalizedLogs.length,
            assistantLogs: assistantCount,
            hasFirstMessage: !!firstMessage,
          });
        } catch (callbackErr) {
          if (isContextInvalidatedError(callbackErr)) {
            console.log('[Vivid Chat][content] Storage callback context invalidated');
          }
        }
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) {
        console.log('[Vivid Chat][content] Storage call context invalidated');
      } else {
        console.warn('[Vivid Chat][content] Storage call exception:', e);
      }
      return false;
    }

    return true;
  } catch (err) {
    console.warn('[Vivid Chat][content] Failed to hydrate initialChatLogs:', err);
    return false;
  }
}

/**
 * 스토어에서 채팅 로그 가져오기
 */
function getChatLogsFromStorage(chatId) {
  return new Promise((resolve) => {
    // ✅ Extension context 체크
    if (!isExtensionContextAlive()) {
      console.log('[Vivid Chat][content] Cannot get chat_logs: context invalidated');
      resolve([]);
      return;
    }
    
    try {
      chrome.storage.local.get([`chat_logs::${chatId}`], (result) => {
        try {
          // ✅ Extension context 체크 (콜백 내부)
          if (!isExtensionContextAlive()) {
            resolve([]);
            return;
          }
          
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
            if (isContextInvalidatedError({ message: errorMsg })) {
              console.log('[Vivid Chat][content] Storage context invalidated in chat_logs get');
              resolve([]);
              return;
            }
            console.warn('[Vivid Chat][content] Failed to get chat_logs:', chrome.runtime.lastError);
            resolve([]);
            return;
          }

          const logs = result[`chat_logs::${chatId}`];
          resolve(Array.isArray(logs) ? logs : []);
        } catch (callbackErr) {
          if (isContextInvalidatedError(callbackErr)) {
            console.log('[Vivid Chat][content] Storage callback context invalidated');
          }
          resolve([]);
        }
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) {
        console.log('[Vivid Chat][content] Storage call context invalidated');
      } else {
        console.warn('[Vivid Chat][content] Storage call exception:', e);
      }
      resolve([]);
    }
  });
}

/**
 * 스토어에서 마지막 assistant 메시지 가져오기
 */
function getLastAssistantTurnFromStore(logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return null;
  }

  // 역순으로 탐색하여 마지막 assistant 메시지 찾기
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].assistantText && logs[i].assistantText.trim()) {
      return logs[i].assistantText.trim();
    }
  }

  return null;
}

/**
 * 플레이 중 새 메시지를 스토어에 append
 * DOM에서 새 턴을 감지했을 때 호출
 */
async function appendNewTurnToStore(chatId, userText, assistantText) {
  if (!chatId) return false;

  return new Promise((resolve) => {
    // ✅ Extension context 체크
    if (!isExtensionContextAlive()) {
      console.log('[Vivid Chat][content] Cannot append turn: context invalidated');
      resolve(false);
      return;
    }
    
    try {
      chrome.storage.local.get([`chat_logs::${chatId}`], (result) => {
        try {
          // ✅ Extension context 체크 (콜백 내부)
          if (!isExtensionContextAlive()) {
            resolve(false);
            return;
          }
          
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
            if (isContextInvalidatedError({ message: errorMsg })) {
              console.log('[Vivid Chat][content] Storage context invalidated in append get');
              resolve(false);
              return;
            }
            console.warn('[Vivid Chat][content] Failed to get chat_logs for append:', chrome.runtime.lastError);
            resolve(false);
            return;
          }

          const existingLogs = Array.isArray(result[`chat_logs::${chatId}`]) 
            ? result[`chat_logs::${chatId}`] 
            : [];

          // 새 로그 추가
          const newLog = {
            logId: null, // 새 메시지는 logId가 없을 수 있음
            userText: userText || null,
            assistantText: assistantText || null,
            createdAt: Date.now(),
          };

          const updatedLogs = [...existingLogs, newLog];

          if (!isExtensionContextAlive()) {
            resolve(false);
            return;
          }

          chrome.storage.local.set({
            [`chat_logs::${chatId}`]: updatedLogs,
          }, () => {
            try {
              // ✅ Extension context 체크 (set 콜백 내부)
              if (!isExtensionContextAlive()) {
                resolve(false);
                return;
              }
              
              if (chrome.runtime.lastError) {
                const errorMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
                if (isContextInvalidatedError({ message: errorMsg })) {
                  console.log('[Vivid Chat][content] Storage context invalidated in append set');
                  resolve(false);
                  return;
                }
                console.warn('[Vivid Chat][content] Failed to append new turn to store:', chrome.runtime.lastError);
                resolve(false);
                return;
              }

              console.log('[Vivid Chat][content] New turn appended to store', {
                chatId: chatId,
                totalLogs: updatedLogs.length,
                hasUserText: !!userText,
                hasAssistantText: !!assistantText,
              });
              resolve(true);
            } catch (setCallbackErr) {
              if (isContextInvalidatedError(setCallbackErr)) {
                console.log('[Vivid Chat][content] Storage set callback context invalidated');
              }
              resolve(false);
            }
          });
        } catch (getCallbackErr) {
          if (isContextInvalidatedError(getCallbackErr)) {
            console.log('[Vivid Chat][content] Storage get callback context invalidated');
          }
          resolve(false);
        }
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) {
        console.log('[Vivid Chat][content] Storage call context invalidated');
      } else {
        console.warn('[Vivid Chat][content] Storage call exception:', e);
      }
      resolve(false);
    }
  });
}

// ============================================================================
// __NEXT_DATA__ 파싱 및 저장 (SSR fallback)
// ============================================================================

/**
 * #__NEXT_DATA__ 요소에서 bot context 파싱 및 저장
 * 새로고침 시 SSR HTML에 포함된 데이터를 읽어서 저장
 */
function tryParseNextDataAndStore() {
  try {
    const el = document.querySelector('#__NEXT_DATA__');
    if (!el || !el.textContent) {
      console.log('[Vivid Chat][content][next_data] no __NEXT_DATA__ or parse failed');
      return false;
    }

    const json = JSON.parse(el.textContent);
    const pp = json?.props?.pageProps || json?.pageProps;

    if (!pp) {
      console.log('[Vivid Chat][content][next_data] no __NEXT_DATA__ or parse failed');
      return false;
    }

    // 필드 추출
    const botDetail = pp.botDetail || pp.oriBotDetail;
    const oriChatData = pp.oriChatData;

    if (!botDetail) {
      console.log('[Vivid Chat][content][next_data] no __NEXT_DATA__ or parse failed');
      return false;
    }

    const botId = botDetail.bot_id;
    if (!botId) {
      console.log('[Vivid Chat][content][next_data] no __NEXT_DATA__ or parse failed');
      return false;
    }

    // chatId 후보군 추출
    const chatIdCandidates = getChatIdKeyCandidatesFromNextData(pp);
    if (chatIdCandidates.length === 0) {
      console.log('[Vivid Chat][content][next_data] no chatId candidates found');
      return false;
    }

    const botName = botDetail.char;
    const charPersona = botDetail.char_persona;
    const worldview = botDetail.worldview;
    const userName = oriChatData?.user;
    const userPersona = oriChatData?.user_persona;

    // 유효성 검사: botId, persona/worldview 중 하나라도 있어야 함
    if (!botId || (!charPersona && !worldview)) {
      console.log('[Vivid Chat][content][next_data] no __NEXT_DATA__ or parse failed');
      return false;
    }

    // chatId 후보군 모두에 저장
    let stored = false;
    chatIdCandidates.forEach(id => {
      const result = storeBotContext(
        String(id),
        String(botId),
        botName ? String(botName) : undefined,
        charPersona ? String(charPersona) : undefined,
        worldview ? String(worldview) : undefined,
        userName ? String(userName) : undefined,
        userPersona ? String(userPersona) : undefined,
        Date.now()
      );
      if (result) stored = true;
    });

    // first_message도 함께 저장 (assistant 메시지가 0개일 때 사용)
    const firstMessage = botDetail.first_message;
    if (firstMessage && typeof firstMessage === 'string' && firstMessage.trim()) {
      const firstMessageData = {};
      chatIdCandidates.forEach(id => {
        firstMessageData[`first_message::${id}`] = firstMessage.trim();
      });
      chrome.storage.local.set(firstMessageData, () => {
        if (chrome.runtime.lastError) {
          console.warn('[Vivid Chat][content] Failed to save first_message:', chrome.runtime.lastError);
        }
      });
    }

    if (stored) {
      console.log('[Vivid Chat][content][next_data] stored from __NEXT_DATA__', {
        chatIdCandidates: chatIdCandidates,
        botId: String(botId),
        hasPersona: !!charPersona,
        hasWorldview: !!worldview,
      });
    }

    return stored;
  } catch (err) {
    console.log('[Vivid Chat][content][next_data] no __NEXT_DATA__ or parse failed', err);
    return false;
  }
}

// ============================================================================
// Extension으로부터 메시지 수신
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'REQUEST_LAST_AI_MESSAGE') {
    console.log(
      "[Vivid Chat][content] REQUEST_LAST_AI_MESSAGE",
      "provider:",
      message.provider
    );

    if (message.provider === 'rofan-ai') {
      // rofan.ai 채팅 페이지인지 확인
      if (!isRofanChatPage()) {
        console.warn('[Vivid Chat][content] Not a rofan.ai chat page:', window.location.href);
        sendResponse({
          success: false,
          reason: 'not_rofan_chat_page',
          provider: message.provider,
        });
        return true;
      }

      // 마지막 AI 메시지 추출 (async 함수이므로 await 필요) - User+AI 세트 반환
      extractLastAiMessageFromRofanAi().then((result) => {
        // scenarioKey 계산하여 포함
        const scenarioKey = getScenarioKeyFromLocation(window.location);
        
        // User+AI 세트가 있으면 포함, 없으면 기존 방식 유지
        const response = {
          ...result,
          scenarioKey: scenarioKey,
        };
        
        // userText/aiText가 있으면 포함 (수동 분석에서도 사용)
        if (result.userText !== undefined) {
          response.userText = result.userText;
        }
        if (result.aiText !== undefined) {
          response.aiText = result.aiText;
        }
        
        sendResponse(response);
      }).catch((err) => {
        console.error('[Vivid Chat][content] Error in extractLastAiMessageFromRofanAi:', err);
        sendResponse({
          success: false,
          provider: 'rofan-ai',
          reason: 'extraction_error',
        });
      });
      return true; // 비동기 응답을 위해 true 반환
    }

    // 다른 provider는 나중을 위해 남겨두고, 일단 실패 처리
    sendResponse({
      success: false,
      reason: 'unsupported_provider',
      provider: message.provider,
    });
    return true;
  }

  // 기존 TEXT_SELECTED 등 다른 타입은 그대로 유지
  // (현재는 TEXT_SELECTED는 별도 이벤트 리스너로 처리되므로 여기서는 처리 안 함)
});

// rofan.ai 자동 업데이트 Observer 해제
function teardownRofanAutoUpdateObserver() {
  if (autoUpdateObserver) {
    autoUpdateObserver.disconnect();
    autoUpdateObserver = null;
    lastAutoTurnText = null; // 캐시도 초기화
    console.log('[Vivid Chat][content] Auto-update observer detached');
  }
}

// rofan.ai 자동 업데이트 Observer 설정 (초기화 완료 후에만 활성화)
async function setupRofanAutoUpdateObserver() {
  // 이미 설정돼 있으면 다시 만들지 않음
  if (autoUpdateObserver) return;

  const chatId = getChatIdFromLocation();
  if (!chatId) {
    console.warn('[Vivid Chat][content] Cannot setup observer: chatId not found');
    return;
  }

  return new Promise((resolve) => {
    // ✅ Extension context 체크
    if (!isExtensionContextAlive()) {
      console.log('[Vivid Chat][content] Cannot setup observer: context invalidated');
      resolve(false);
      return;
    }
    
    try {
      chrome.storage.local.get(
        [`chat_logs_initialized::${chatId}`, `first_message::${chatId}`],
        (result) => {
          try {
            // ✅ Extension context 체크 (콜백 내부)
            if (!isExtensionContextAlive()) {
              console.log('[Vivid Chat][content] Observer setup aborted: context invalidated in callback');
              resolve(false);
              return;
            }
            
            if (chrome.runtime.lastError) {
              const errorMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
              if (isContextInvalidatedError({ message: errorMsg })) {
                stopAutoUpdateObserver("storage_callback_context_invalidated");
                resolve(false);
                return;
              }
              console.warn('[Vivid Chat][content] Failed to check init state:', chrome.runtime.lastError);
              resolve(false);
              return;
            }

            const isInitialized = result[`chat_logs_initialized::${chatId}`] === true;
            const hasFirstMessage = !!(result[`first_message::${chatId}`] && String(result[`first_message::${chatId}`]).trim());

            // ✅ 둘 중 하나라도 있으면 Observer 가동
            if (!isInitialized && !hasFirstMessage) {
              console.log('[Vivid Chat][content] Observer setup deferred: waiting for init/first_message');
              resolve(false);
              return;
            }

            const chatRoot = document.querySelector('div.lg\\:pr-5.overflow-y-auto');
            if (!chatRoot) {
              console.warn('[Vivid Chat][content] chat root not found for auto update');
              resolve(false);
              return;
            }

            let timer = null;
            autoUpdateObserver = new MutationObserver(() => {
              try {
                // ✅ Extension context 체크: invalidated면 즉시 disconnect
                if (!isExtensionContextAlive()) {
                  stopAutoUpdateObserver("observer_callback_context_invalidated");
                  return;
                }
                
                if (timer) clearTimeout(timer);
                timer = setTimeout(handleAutoUpdateTurn, 500);
              } catch (e) {
                const m = String(e?.message || e);
                if (isContextInvalidatedError(e) || m.includes("Extension context invalidated")) {
                  stopAutoUpdateObserver("observer_callback_invalidated");
                } else {
                  console.warn("[Vivid Chat][content] MutationObserver callback error:", e);
                }
              }
            });

            autoUpdateObserver.observe(chatRoot, { childList: true, subtree: true });

            console.log('[Vivid Chat][content] Auto-update observer attached', {
              chatId,
              isInitialized,
              hasFirstMessage,
            });
            resolve(true);
          } catch (callbackErr) {
            const m = String(callbackErr?.message || callbackErr);
            if (isContextInvalidatedError(callbackErr) || m.includes("Extension context invalidated")) {
              stopAutoUpdateObserver("storage_callback_exception_invalidated");
            }
            resolve(false);
          }
        }
      );
    } catch (e) {
      const m = String(e?.message || e);
      if (isContextInvalidatedError(e) || m.includes("Extension context invalidated")) {
        stopAutoUpdateObserver("storage_call_exception_invalidated");
      }
      console.warn('[Vivid Chat][content] Failed to setup observer:', e);
      resolve(false);
    }
  });
}

// 새 턴이 감지되면 마지막 턴 텍스트 추출 → service-worker로 전달
async function handleAutoUpdateTurn() {
  try {
    const chatId = getChatIdFromLocation();
    if (!chatId) return;

    // ✅ DOM에서 User+AI 세트 추출
    const pair = extractLastTurnPairFromDom();
    if (!pair) return;

    const { lastBlock, userText, aiText } = pair;

    // ✅ 1) AI 응답이 아직 없으면(유저 Enter 직후) 분석 금지
    if (!aiText || !aiText.trim()) {
      return;
    }

    // ✅ 2) 분석 키 생성 및 중복 체크
    const key = makeAnalyzeKey(chatId, userText, aiText);

    // ✅ 3) 직전과 동일한 턴이면 중복 분석 금지
    if (__vividLastAutoAnalyzeKey === key) {
      return;
    }

    // ✅ 4) 블록 단위로도 중복 방지 (추가 안전장치)
    if (lastBlock?.dataset?.vividAnalyzedKey === key) {
      return;
    }

    // debounce: 500ms 이내에 추가 요청이 오면 무시
    const now = Date.now();
    if (now - lastAutoUpdateRequestTime < 500) {
      console.log('[Vivid Chat][content] Auto-update request throttled (debounce)');
      return;
    }

    // ✅ 5) Extension context 체크 (메시지 전송 전)
    if (!isExtensionContextAlive()) {
      stopAutoUpdateObserver("extension_context_invalidated(runtime_missing)");
      return;
    }

    // ✅ 6) 키 저장 및 마킹
    __vividLastAutoAnalyzeKey = key;
    if (lastBlock) {
      lastBlock.dataset.vividAnalyzedKey = key;
    }
    lastAutoUpdateRequestTime = now;

    // scenarioKey 계산
    const scenarioKey = getScenarioKeyFromLocation(window.location);
    const analyzeKey = key; // 이미 계산된 key 재사용
    
    // ✅ 디버깅 로그: 전송 전 정보
    console.log("[Vivid Chat][content] Sending NEW_LAST_AI_TURN:", {
      chatId,
      scenarioKey,
      userLen: userText ? userText.length : 0,
      aiLen: aiText.length,
      analyzeKey: analyzeKey.slice(0, 50) + '...',
      sendMode: 'await',
    });
    
    // ✅ 7) 안전한 메시지 전송 (userText + aiText 포함)
    const msg = {
      type: 'NEW_LAST_AI_TURN',
      provider: 'rofan-ai',
      chatId,
      userText: userText || '',
      aiText: aiText,
      text: aiText, // 하위 호환성: 기존 text 필드 유지
      scenarioKey: scenarioKey,
      source: 'dom_pair',
    };

    const sent = await safeSendMessage(msg);

    // ✅ 8) 실패 처리: "message port closed"는 치명적이지 않음
    if (!sent.ok) {
      const r = sent.reason + (sent.error ? `: ${sent.error}` : "");
      const errorMsg = sent.error || r;
      
      // ✅ 디버깅 로그: 실패 상세 정보
      console.warn("[Vivid Chat][content] sendMessage failed:", {
        reason: sent.reason,
        error: errorMsg,
        lastError: chrome.runtime?.lastError?.message,
      });
      
      // ✅ "message port closed"는 프로토콜/타이밍 이슈일 수 있으므로 조용히 skip
      const isPortClosed = errorMsg.includes("message port closed") || errorMsg.includes("port closed");
      if (isPortClosed) {
        console.log("[Vivid Chat][content] Message port closed (non-fatal), skipping this turn");
        return; // observer는 유지, 다음 턴에서 재시도
      }
      
      // ✅ 진짜 Extension context invalidated만 감지하여 observer 중지
      const errorObj = sent.error ? new Error(sent.error) : new Error(r);
      const isInvalidated = isContextInvalidatedError(errorObj) || 
                           sent.reason === "runtime_missing" || 
                           sent.reason === "context_invalidated";
      
      if (isInvalidated) {
        console.warn("[Vivid Chat][content] Extension context invalidated detected, stopping observer");
        // AUTO_UPDATE_ERROR 메시지 전송 시도
        try {
          await safeSendMessage({
            type: "AUTO_UPDATE_ERROR",
            provider: "rofan-ai",
            reason: "EXTENSION_CONTEXT_INVALIDATED",
            message: "자동 업데이트 연결이 끊어졌어요. 로판AI 탭을 새로고침한 뒤 다시 켜주세요.",
          });
        } catch (e) {
          // 실패해도 괜찮음 (콘솔만)
        }
        stopAutoUpdateObserver(`sendMessage_failed(${r})`);
        return;
      }
      
      // ✅ 기타 에러는 조용히 skip (observer 유지)
      console.log("[Vivid Chat][content] sendMessage failed (non-fatal), skipping this turn:", sent.reason);
      return;
    }
    
    // ✅ 성공 로그
    console.log("[Vivid Chat][content] NEW_LAST_AI_TURN sent successfully");
  } catch (e) {
    // ✅ 예외 처리: "message port closed"는 치명적이지 않음
    const errorMsg = String(e?.message || e);
    console.warn("[Vivid Chat][content] handleAutoUpdateTurn exception:", {
      error: errorMsg,
      type: e?.name,
    });
    
    // ✅ "message port closed"는 조용히 skip
    if (errorMsg.includes("message port closed") || errorMsg.includes("port closed")) {
      console.log("[Vivid Chat][content] Message port closed in catch (non-fatal), skipping");
      return; // observer 유지
    }
    
    // ✅ 진짜 Extension context invalidated만 감지하여 observer 중지
    if (isContextInvalidatedError(e)) {
      console.warn("[Vivid Chat][content] Extension context invalidated in catch, stopping observer");
      // AUTO_UPDATE_ERROR 메시지 전송 시도
      try {
        await safeSendMessage({
          type: "AUTO_UPDATE_ERROR",
          provider: "rofan-ai",
          reason: "EXTENSION_CONTEXT_INVALIDATED",
          message: "자동 업데이트 연결이 끊어졌어요. 로판AI 탭을 새로고침한 뒤 다시 켜주세요.",
        });
      } catch (sendErr) {
        // 실패해도 괜찮음 (콘솔만)
      }
      
      stopAutoUpdateObserver("caught_extension_context_invalidated");
      return;
    }
    
    // ✅ 기타 예외는 조용히 skip (observer 유지, 무한 에러 방지)
    console.log("[Vivid Chat][content] handleAutoUpdateTurn exception (non-fatal), skipping:", errorMsg);
  }
}

// location.href 감시 및 Observer 관리
function checkLocationAndSetupObserver() {
  const currentPath = window.location.pathname;
  const isChatPage = isRofanChatPage();

  // pathname이 변경되지 않았으면 스킵
  if (currentPath === lastCheckedPath) return;
  lastCheckedPath = currentPath;

  if (isChatPage) {
    // /chat/... 페이지로 진입
    console.log('[Vivid Chat][content] Entered chat page:', currentPath);
    
    // 1) 초기 로그 세팅 (입장 시 1회성, DOM 신뢰 안 함)
    hydrateInitialChatLogsFromNextData();
    
    // 2) bot context 파싱 및 저장
    tryParseNextDataAndStore();
    
    // 3) 초기화 완료 후 MutationObserver 활성화
    // DOM이 완전히 로드될 때까지 대기
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', async () => {
        // 초기화 완료 후 Observer 설정
        await setupRofanAutoUpdateObserver();
        // DOM 로드 후에도 한 번 더 시도 (타이밍 이슈 대비)
        hydrateInitialChatLogsFromNextData();
        tryParseNextDataAndStore();
      }, { once: true });
    } else {
      // DOM이 이미 로드된 경우
      setupRofanAutoUpdateObserver();
    }
  } else {
    // /chat/... 페이지에서 벗어남
    if (autoUpdateObserver) {
      console.log('[Vivid Chat][content] Left chat page:', currentPath);
      teardownRofanAutoUpdateObserver();
    }
  }
}

// 초기화: rofan.ai 도메인에서 location.href 감시 시작
if (window.location.host === 'rofan.ai') {
  // Content script loaded 직후 초기 로그 세팅 및 bot context 파싱 시도 (새로고침 대비)
  if (isRofanChatPage()) {
    // DOM이 로드될 때까지 대기 후 시도
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        // 입장 시 초기 로그 세팅 (1회성)
        hydrateInitialChatLogsFromNextData();
        // bot context 파싱
        tryParseNextDataAndStore();
      }, { once: true });
    } else {
      // DOM이 이미 로드된 경우 즉시 시도
      hydrateInitialChatLogsFromNextData();
      tryParseNextDataAndStore();
    }
  }

  // 초기 체크
  checkLocationAndSetupObserver();

  // 1초 간격으로 location.href 감시
  locationCheckInterval = setInterval(() => {
    try {
      // ✅ Extension context 체크: invalidated면 interval 중지
      if (!isExtensionContextAlive()) {
        if (locationCheckInterval) {
          clearInterval(locationCheckInterval);
          locationCheckInterval = null;
        }
        console.log('[Vivid Chat][content] locationCheckInterval stopped: context invalidated');
        return;
      }
      
      checkLocationAndSetupObserver();
    } catch (e) {
      const m = String(e?.message || e);
      if (isContextInvalidatedError(e) || m.includes("Extension context invalidated")) {
        if (locationCheckInterval) {
          clearInterval(locationCheckInterval);
          locationCheckInterval = null;
        }
        console.log('[Vivid Chat][content] locationCheckInterval stopped: exception');
      } else {
        console.warn("[Vivid Chat][content] locationCheckInterval callback error:", e);
      }
    }
  }, 1000);

  // 페이지 언로드 시 정리
  window.addEventListener('beforeunload', () => {
    if (locationCheckInterval) {
      clearInterval(locationCheckInterval);
      locationCheckInterval = null;
    }
    teardownRofanAutoUpdateObserver();
  });
}
