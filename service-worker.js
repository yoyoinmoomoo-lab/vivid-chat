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
    "[Rofan Visualboard][service-worker] REQUEST_LAST_AI_MESSAGE from sidepanel, provider:",
    message.provider
  );

  try {
    const tab = await getActiveRofanChatTab();

    if (!tab || !tab.id) {
      console.warn(
        "[Rofan Visualboard][service-worker] No active rofan.ai chat tab"
      );
      sendResponse({
        success: false,
        reason: "no_active_rofan_chat_tab",
      });
      return;
    }

    console.log(
      "[Rofan Visualboard][service-worker] Sending REQUEST_LAST_AI_MESSAGE to tab:",
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
            "[Rofan Visualboard][service-worker] Error forwarding to content script:",
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
              "[Rofan Visualboard][service-worker] Content script not loaded, injecting..."
            );
            
            // content script 주입 (manifest에 등록된 content script 재실행)
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            }).then(() => {
              console.log("[Rofan Visualboard][service-worker] Content script injected, retrying...");
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
                      "[Rofan Visualboard][service-worker] LAST_AI_MESSAGE response (after injection):",
                      retryResponse
                    );
                    sendResponse(retryResponse);
                  }
                );
              }, 100);
            }).catch((injectionError) => {
              console.error(
                "[Rofan Visualboard][service-worker] Failed to inject content script:",
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
          "[Rofan Visualboard][service-worker] LAST_AI_MESSAGE response:",
          response
        );
        sendResponse(response);
      }
    );
  } catch (err) {
    console.error(
      "[Rofan Visualboard][service-worker] Unexpected error in handleRequestLastAiMessage:",
      err
    );
    sendResponse({
      success: false,
      reason: "unexpected_error",
    });
  }
}

// Content script로부터 메시지 수신 (TEXT_SELECTED 등)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  // TEXT_SELECTED 메시지 로깅 (side panel로도 전달됨)
  if (message.type === 'TEXT_SELECTED') {
    const tabId = sender.tab?.id;
    console.log(`[Rofan Visualboard][service-worker] TEXT_SELECTED received from tab ${tabId}`, message.text?.substring(0, 50) + '...');
    // sidepanel.js의 onMessage 리스너가 처리하도록 그대로 통과
    // false를 반환하면 다른 리스너(sidepanel.js)도 메시지를 받을 수 있음
    return false;
  }

  // Content script로부터 새 AI 턴 감지 메시지
  if (message.type === 'NEW_LAST_AI_TURN') {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    console.log('[Rofan Visualboard][service-worker] NEW_LAST_AI_TURN from tab', tabId, 'window', windowId);

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
    handleRequestLastAiMessage(message, sendResponse);
    return true; // async response
  }
  
  return false; // 다른 메시지 타입은 처리하지 않음
});

