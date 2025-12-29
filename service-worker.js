// Extension 아이콘 클릭 시 사이드 패널 열기
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// rofan.ai 채팅 URL인지 확인하는 헬퍼 함수
// /chat/... 또는 /en/chat/... 경로 모두 지원
function isRofanChatUrl(url) {
  if (!url) return false;
  return url.startsWith("https://rofan.ai/") && url.includes("/chat/");
}

// 활성 탭에서 rofan.ai/chat 여부 확인하는 헬퍼
// NOTE: Chrome Web Store 심사 - tabs 권한 필요 이유:
// 여러 탭 중에서 rofan.ai 채팅 페이지를 식별하고, 해당 탭의 content script와
// 메시지를 주고받기 위해 tabs 권한이 필요합니다.
// activeTab 권한만으로는 chrome.tabs.query를 사용할 수 없으며,
// 사용자가 다른 탭으로 전환한 후에도 사이드패널에서 정상 동작해야 하므로
// tabs 권한이 필수입니다.
async function getActiveRofanChatTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  if (!tabs || tabs.length === 0) return null;
  const [tab] = tabs;

  if (!tab.url) return null;

  // isRofanChatUrl 함수로 URL 체크 (/chat/ 또는 /en/chat/ 모두 지원)
  return isRofanChatUrl(tab.url) ? tab : null;
}

// 마지막 AI 메시지 요청 처리
async function handleRequestLastAiMessage(message, sendResponse) {
  console.log(
    "[Vivid Chat][service-worker] REQUEST_LAST_AI_MESSAGE from sidepanel, provider:",
    message.provider
  );

  try {
    const tab = await getActiveRofanChatTab();

    if (!tab || !tab.id) {
      console.warn(
        "[Vivid Chat][service-worker] No active rofan.ai chat tab"
      );
      sendResponse({
        success: false,
        reason: "no_active_rofan_chat_tab",
      });
      return;
    }

    console.log(
      "[Vivid Chat][service-worker] Sending REQUEST_LAST_AI_MESSAGE to tab:",
      {
        id: tab.id,
        url: tab.url
      }
    );

    // NOTE: rofan.ai 채팅 탭의 content script와 메시지 교환을 위해 tabs 권한 필요
    // content script가 로드되지 않았을 수 있으므로 먼저 메시지 전송 시도
    chrome.tabs.sendMessage(
      tab.id,
      { type: "REQUEST_LAST_AI_MESSAGE", provider: message.provider },
      (response) => {
        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message;
          console.warn(
            "[Vivid Chat][service-worker] Error forwarding to content script:",
            {
              message: errorMessage,
              tabId: tab.id,
              tabUrl: tab.url
            }
          );
          
          // "Receiving end does not exist" 에러인 경우 content script가 로드되지 않은 것
          // 이 경우 content script를 강제로 주입하고 재시도
          if (errorMessage.includes("Receiving end does not exist") || 
              errorMessage.includes("Could not establish connection")) {
            console.log(
              "[Vivid Chat][service-worker] Content script not loaded, injecting..."
            );
            
            // content script 주입 (manifest에 등록된 content script 재실행)
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            }).then(() => {
              console.log("[Vivid Chat][service-worker] Content script injected, retrying...");
              // 주입 후 약간의 지연을 두고 재시도
              setTimeout(() => {
                chrome.tabs.sendMessage(
                  tab.id,
                  { type: "REQUEST_LAST_AI_MESSAGE", provider: message.provider },
                  (retryResponse) => {
                    if (chrome.runtime.lastError) {
                      sendResponse({
                        success: false,
                        reason: "forward_error_after_injection",
                        error: chrome.runtime.lastError.message,
                      });
                      return;
                    }
                    console.log(
                      "[Vivid Chat][service-worker] LAST_AI_MESSAGE response (after injection):",
                      retryResponse
                    );
                    sendResponse(retryResponse);
                  }
                );
              }, 100);
            }).catch((injectionError) => {
              console.error(
                "[Vivid Chat][service-worker] Failed to inject content script:",
                injectionError
              );
              sendResponse({
                success: false,
                reason: "injection_failed",
                error: injectionError.message || errorMessage,
              });
            });
            return; // 비동기 처리 중이므로 여기서 반환
          }
          
          // 다른 에러인 경우 그대로 반환
          sendResponse({
            success: false,
            reason: "forward_error",
            error: errorMessage,
          });
          return;
        }

        console.log(
          "[Vivid Chat][service-worker] LAST_AI_MESSAGE response:",
          response
        );
        sendResponse(response);
      }
    );
  } catch (err) {
    console.error(
      "[Vivid Chat][service-worker] Unexpected error in handleRequestLastAiMessage:",
      err
    );
    sendResponse({
      success: false,
      reason: "unexpected_error",
    });
  }
}

// ============================================================================
// MAIN world hook 주입 (/_next/data/**/chat/**.json 후킹)
// ============================================================================

/**
 * MAIN world에서 실행될 fetch 후킹 함수
 * 페이지 컨텍스트에서 실행되므로 window.fetch를 직접 후킹 가능
 */
function installMainWorldHook() {
  // 1) 훅 설치 확인 로그 (무조건 보이게)
  console.log('[Rofan][hook] installed', location.href);

  // 중복 주입 방지
  if (window.__ROFAN_HOOK_INSTALLED__) {
    console.log('[Rofan][hook] already installed, skipping');
    return;
  }
  window.__ROFAN_HOOK_INSTALLED__ = true;

  // 원본 fetch 저장
  const originalFetch = window.fetch || globalThis.fetch || self.fetch;

  // fetch URL 로그 카운터 (처음 20개만)
  let fetchUrlLogCount = 0;
  const MAX_FETCH_URL_LOGS = 20;

  // fetch 후킹 함수
  const hookedFetch = async function(...args) {
    const url = args[0];
    const urlString = typeof url === 'string' ? url : url?.url || url?.toString() || '';

    // 3) 모든 fetch URL 로그 (처음 20개만)
    if (fetchUrlLogCount < MAX_FETCH_URL_LOGS) {
      console.log('[Rofan][hook] fetch url:', urlString);
      fetchUrlLogCount++;
    }

    // 4) 응답 후보를 넓게 감지
    const isCandidateUrl = 
      urlString.includes('/_next/data/') ||
      urlString.includes('GetDetailChatList') ||
      urlString.includes('GetModalBotDetails') ||
      urlString.includes('/api/chat') ||
      urlString.includes('/api/bot');

    if (isCandidateUrl) {
      console.log('[Rofan][hook] candidate hit:', urlString);

      // 원본 fetch 호출
      const response = await originalFetch.apply(this, args);

      // 5) hit 후보는 응답을 clone().json() 시도
      response.clone().json().then((json) => {
        try {
          // pageProps 파싱 (json.pageProps 또는 json.props?.pageProps)
          const pageProps = json.pageProps || json.props?.pageProps;
          
          if (!pageProps) {
            console.log('[Rofan][hook] candidate has no pageProps, skipping');
            return; // pageProps 없으면 스킵
          }

          // 필드 추출 (fallback 규칙 적용)
          const chatId = pageProps.chatId || pageProps.oriChatData?.chat_id;
          const botDetail = pageProps.botDetail || pageProps.oriBotDetail;
          const oriChatData = pageProps.oriChatData;

          if (!chatId || !botDetail) {
            console.log('[Rofan][hook] candidate missing chatId or botDetail, skipping');
            return; // 필수 필드 없으면 스킵
          }

          const botId = botDetail.bot_id || oriChatData?.bot_id;
          const botName = botDetail.char || pageProps.oriBotDetail?.char;
          const charPersona = botDetail.char_persona || pageProps.oriBotDetail?.char_persona;
          const worldview = botDetail.worldview || pageProps.oriBotDetail?.worldview;

          if (!botId) {
            console.log('[Rofan][hook] candidate missing botId, skipping');
            return; // botId 없으면 스킵
          }

          // 6) 민감정보 필터: cookies/userData/email/session-token 절대 포함 금지
          // payload 구성 시 민감 정보는 제외
          const payload = {
            chatId: String(chatId),
            botId: String(botId),
            botName: botName ? String(botName) : undefined,
            charPersona: charPersona ? String(charPersona) : undefined,
            worldview: worldview ? String(worldview) : undefined,
            userName: oriChatData?.user ? String(oriChatData.user) : undefined,
            userPersona: oriChatData?.user_persona ? String(oriChatData.user_persona) : undefined,
            updatedAt: Date.now(),
          };

          // window.postMessage로 content script에 전달
          window.postMessage({
            type: 'ROFAN_NEXT_DATA',
            payload: payload,
          }, '*');

          // 로그 (민감 정보 제외)
          console.log('[Rofan][hook] next-data hit', {
            chatId: payload.chatId,
            botId: payload.botId,
            personaLen: payload.charPersona?.length || 0,
            worldviewLen: payload.worldview?.length || 0,
          });
        } catch (err) {
          console.warn('[Rofan][hook] Failed to parse candidate response:', err);
        }
      }).catch((err) => {
        // JSON 파싱 실패
        console.warn('[Rofan][hook] json parse failed', urlString, err);
      });

      return response;
    }

    // 다른 URL은 원본 fetch 그대로 사용
    return originalFetch.apply(this, args);
  };

  // 2) fetch 후킹 범위 확대 (window.fetch, globalThis.fetch, self.fetch 모두 교체)
  window.fetch = hookedFetch;
  if (typeof globalThis !== 'undefined') {
    globalThis.fetch = hookedFetch;
  }
  if (typeof self !== 'undefined') {
    self.fetch = hookedFetch;
  }

  console.log('[Rofan][hook] fetch patched', { 
    same: globalThis.fetch === window.fetch,
    hasGlobalThis: typeof globalThis !== 'undefined',
    hasSelf: typeof self !== 'undefined',
  });
  console.log('[Rofan][hook] MAIN world hook installed');
}

/**
 * rofan.ai 탭에 MAIN world hook 주입
 */
async function injectMainWorldHook(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: installMainWorldHook,
    });
    console.log('[Vivid Chat][service-worker] MAIN world hook injected to tab', tabId);
  } catch (err) {
    console.warn('[Vivid Chat][service-worker] Failed to inject MAIN world hook:', err);
  }
}

/**
 * rofan.ai 탭 업데이트 시 MAIN world hook 주입
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // rofan.ai 채팅 URL이고 로딩 중일 때만 주입
  if (changeInfo.status === 'loading' && isRofanChatUrl(tab.url)) {
    injectMainWorldHook(tabId);
  }
});

/**
 * REQUEST_LAST_AI_MESSAGE 처리 시에도 hook 주입 보장
 */
async function ensureMainWorldHook(tabId) {
  try {
    // 이미 주입되어 있는지 확인 (MAIN world에서 확인 불가하므로 항상 시도)
    await injectMainWorldHook(tabId);
  } catch (err) {
    // 실패해도 계속 진행 (hook 없어도 다른 기능은 동작)
    console.warn('[Vivid Chat][service-worker] Hook injection failed (non-fatal):', err);
  }
}

// ============================================================================
// 메시지 리스너
// ============================================================================

// Content script로부터 메시지 수신 (TEXT_SELECTED 등)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  // TEXT_SELECTED 메시지 로깅 (side panel로도 전달됨)
  if (message.type === 'TEXT_SELECTED') {
    const tabId = sender.tab?.id;
    console.log(`[Vivid Chat][service-worker] TEXT_SELECTED received from tab ${tabId}`, message.text?.substring(0, 50) + '...');
    // sidepanel.js의 onMessage 리스너가 처리하도록 그대로 통과
    // false를 반환하면 다른 리스너(sidepanel.js)도 메시지를 받을 수 있음
    return false;
  }

  // Content script로부터 새 AI 턴 감지 메시지
  if (message.type === 'NEW_LAST_AI_TURN') {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    console.log('[Vivid Chat][service-worker] NEW_LAST_AI_TURN from tab', tabId, 'window', windowId);

    // sidepanel 쪽에서 필터링할 수 있도록 windowId를 붙여서 다시 브로드캐스트
    chrome.runtime.sendMessage({
      type: 'NEW_LAST_AI_TURN',
      provider: message.provider,
      text: message.text,
      sourceTabId: tabId,
      sourceWindowId: windowId,
    });

    // async response 필요 없음
    return false;
  }
  
  // Side panel로부터 마지막 AI 메시지 요청
  if (message.type === "REQUEST_LAST_AI_MESSAGE") {
    // hook 주입 보장
    if (sender.tab?.id) {
      ensureMainWorldHook(sender.tab.id);
    }
    handleRequestLastAiMessage(message, sendResponse);
    return true; // async response
  }
  
  return false; // 다른 메시지 타입은 처리하지 않음
});

