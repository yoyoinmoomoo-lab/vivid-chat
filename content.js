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

// rofan.ai에서 마지막 AI 메시지 추출 함수 (스토어 기반)
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

  // 1) 우선순위 1: 스토어에서 로그 가져오기
  const logs = await getChatLogsFromStorage(chatId);
  const lastAssistantText = getLastAssistantTurnFromStore(logs);

  if (lastAssistantText) {
    console.log(
      "[Vivid Chat][content] lastAI source = store",
      lastAssistantText.slice(0, 120)
    );
    return {
      success: true,
      provider: 'rofan-ai',
      source: 'store',
      text: lastAssistantText,
    };
  }

  // 2) 우선순위 2: 스토어에 로그가 없으면 DOM 기반 fallback (플레이 중 증분 감지용)
  const turnBlocks = Array.from(document.querySelectorAll('div.mt-5'));

  if (turnBlocks.length > 0) {
    // 마지막 턴 블록 선택
    const lastBlock = turnBlocks[turnBlocks.length - 1];
    const paragraphs = Array.from(lastBlock.querySelectorAll('p'));

    // class="mt-1"인 <p>를 우선 AI 메시지로 간주, 없으면 마지막 <p>를 fallback
    const aiParagraph =
      paragraphs.find(p => p.classList.contains('mt-1')) ||
      paragraphs[paragraphs.length - 1];

    const text = aiParagraph?.innerText?.trim();

    if (text) {
      console.log(
        "[Vivid Chat][content] lastAI source = dom",
        text.slice(0, 120)
      );
      return {
        success: true,
        provider: 'rofan-ai',
        source: 'dom',
        text,
      };
    }
  }

  // 3) 우선순위 3: assistant 메시지가 0개로 판정되면 first_message 사용
  // 스토어에서 first_message 확인
  return new Promise((resolve) => {
    chrome.storage.local.get([`first_message::${chatId}`], (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[Vivid Chat][content] Failed to get first_message:', chrome.runtime.lastError);
        // 에러가 나도 __NEXT_DATA__ fallback 시도
      } else {
        const firstMessage = result[`first_message::${chatId}`];
        if (firstMessage && typeof firstMessage === 'string' && firstMessage.trim()) {
          console.log(
            "[Vivid Chat][content] lastAI source = first_message (from store)",
            firstMessage.slice(0, 120)
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
            chrome.storage.local.set({
              [`first_message::${chatId}`]: text,
            }, () => {
              if (chrome.runtime.lastError) {
                console.warn('[Vivid Chat][content] Failed to save first_message to storage:', chrome.runtime.lastError);
              }
            });

            console.log(
              "[Vivid Chat][content] lastAI source = first_message (from __NEXT_DATA__)",
              text.slice(0, 120)
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
        console.warn('[Vivid Chat][content] Failed to parse __NEXT_DATA__ for first_message:', err);
      }

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
            console.log("[Vivid Chat][content] lastAI source = dom(first_message_div)", text.slice(0, 120));
            resolve({
              success: true,
              provider: 'rofan-ai',
              source: 'dom_first',
              text,
            });
            return;
          }
        }
      } catch (e) {
        console.warn('[Vivid Chat][content] DOM first_message fallback failed:', e);
      }

      // 6) 모두 실패 시 에러
      console.warn(
        '[Vivid Chat][content] lastAI not found (store empty, dom not matched, first_message missing)'
      );
      resolve({
        success: false,
        provider: 'rofan-ai',
      });
    });
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

  chrome.storage.local.set(storageData, () => {
    if (chrome.runtime.lastError) {
      console.error('[Vivid Chat][content] Failed to save to storage:', chrome.runtime.lastError);
      return;
    }

    console.log('[Vivid Chat][content][store] saved session_map/bot_master', {
      chatId: chatId,
      botId: botId,
      hasPersona: !!botMasterData.charPersona,
      hasWorldview: !!botMasterData.worldview,
    });
  });

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
    chrome.storage.local.set(storageData, () => {
      if (chrome.runtime.lastError) {
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
    });

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
    chrome.storage.local.get([`chat_logs::${chatId}`], (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[Vivid Chat][content] Failed to get chat_logs:', chrome.runtime.lastError);
        resolve([]);
        return;
      }

      const logs = result[`chat_logs::${chatId}`];
      resolve(Array.isArray(logs) ? logs : []);
    });
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
    chrome.storage.local.get([`chat_logs::${chatId}`], (result) => {
      if (chrome.runtime.lastError) {
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

      chrome.storage.local.set({
        [`chat_logs::${chatId}`]: updatedLogs,
      }, () => {
        if (chrome.runtime.lastError) {
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
      });
    });
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

      // 마지막 AI 메시지 추출 (async 함수이므로 await 필요)
      extractLastAiMessageFromRofanAi().then((result) => {
        // scenarioKey 계산하여 포함
        const scenarioKey = getScenarioKeyFromLocation(window.location);
        
        sendResponse({
          ...result,
          scenarioKey: scenarioKey,
        });
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
    chrome.storage.local.get(
      [`chat_logs_initialized::${chatId}`, `first_message::${chatId}`],
      (result) => {
        if (chrome.runtime.lastError) {
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
          if (timer) clearTimeout(timer);
          timer = setTimeout(handleAutoUpdateTurn, 500);
        });

        autoUpdateObserver.observe(chatRoot, { childList: true, subtree: true });

        console.log('[Vivid Chat][content] Auto-update observer attached', {
          chatId,
          isInitialized,
          hasFirstMessage,
        });
        resolve(true);
      }
    );
  });
}

// 새 턴이 감지되면 마지막 턴 텍스트 추출 → service-worker로 전달
async function handleAutoUpdateTurn() {
  const result = await extractLastAiMessageFromRofanAi();
  if (!result || !result.success || !result.text) return;

  const text = result.text;

  // 이전에 보낸 것과 동일하면 무시 (연속 Mutation 방지)
  if (text === lastAutoTurnText) return;

  // debounce: 500ms 이내에 추가 요청이 오면 무시
  const now = Date.now();
  if (now - lastAutoUpdateRequestTime < 500) {
    console.log('[Vivid Chat][content] Auto-update request throttled (debounce)');
    return;
  }

  lastAutoTurnText = text;
  lastAutoUpdateRequestTime = now;

  // chrome.runtime 확인
  if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    console.warn('[Vivid Chat][content] chrome.runtime.sendMessage not available');
    return;
  }

  // scenarioKey 계산
  const scenarioKey = getScenarioKeyFromLocation(window.location);
  
  // 단방향 메시지 전송 (콜백 없음 - 응답 불필요)
  chrome.runtime.sendMessage({
    type: 'NEW_LAST_AI_TURN',
    provider: 'rofan-ai',
    text,
    scenarioKey: scenarioKey,
  });
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
    checkLocationAndSetupObserver();
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
