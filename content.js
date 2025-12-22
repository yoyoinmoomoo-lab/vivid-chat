// content.js

console.log(
  "[Rofan Visualboard][content] Content script loaded",
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
      "[Rofan Visualboard][content] chrome.runtime is not available",
      chrome && chrome.runtime
    );
    return;
  }

  // 2단계: sendMessage 함수 존재 확인
  if (typeof chrome.runtime.sendMessage !== "function") {
    console.warn(
      "[Rofan Visualboard][content] chrome.runtime.sendMessage is not a function",
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
          "[Rofan Visualboard][content] sendMessage error:",
          chrome.runtime.lastError.message
        );
        return;
      }

      console.log(
        "[Rofan Visualboard][content] TEXT_SELECTED sent to background:",
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
    "[Rofan Visualboard][content] Text selected:",
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

// rofan.ai에서 마지막 AI 메시지 추출 함수
function extractLastAiMessageFromRofanAi() {
  // 1) 기본 규칙 - 기존 채팅 턴 (div.mt-5) 우선
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
        "[Rofan Visualboard][content] Last AI message from turn:",
        text.slice(0, 120)
      );
      return {
        success: true,
        provider: 'rofan-ai',
        source: 'last-ai',
        text,
      };
    }
  }

  // 2) 프롤로그(초기 시나리오) fallback
  // div.mt-5가 하나도 없는 경우 (= 아직 유저/AI 턴이 없는 새 대화)
  const scrollRoot = document.querySelector(
    'div.lg\\:pr-5.overflow-y-auto'
  );

  if (scrollRoot) {
    // font-size: 14px; line-height: 1.5rem; 스타일이 들어있는 div 찾기
    const scenarioBlock = scrollRoot.querySelector(
      'div[style*="line-height: 1.5rem"]'
    );

    if (scenarioBlock) {
      // scenarioBlock 안의 span/br 들을 포함한 전체 텍스트를 innerText로 가져오고, 공백을 정리
      let text = scenarioBlock.innerText || '';
      text = text.replace(/\s+/g, ' ').trim();

      if (text) {
        console.log(
          "[Rofan Visualboard][content] Scenario text found:",
          text.slice(0, 120)
        );
        return {
          success: true,
          provider: 'rofan-ai',
          source: 'scenario',
          text,
        };
      }
    }
  }

  // 3) 실패 시 로그
  console.warn(
    '[Rofan Visualboard][content] Could not find last AI message on rofan.ai - DOM structure may have changed.'
  );
  return {
    success: false,
    provider: 'rofan-ai',
  };
}

// Extension으로부터 메시지 수신
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'REQUEST_LAST_AI_MESSAGE') {
    console.log(
      "[Rofan Visualboard][content] REQUEST_LAST_AI_MESSAGE",
      "provider:",
      message.provider
    );

    if (message.provider === 'rofan-ai') {
      // rofan.ai 채팅 페이지인지 확인
      if (!isRofanChatPage()) {
        console.warn('[Rofan Visualboard][content] Not a rofan.ai chat page:', window.location.href);
        sendResponse({
          success: false,
          reason: 'not_rofan_chat_page',
          provider: message.provider,
        });
        return true;
      }

      // 마지막 AI 메시지 추출
      const result = extractLastAiMessageFromRofanAi();
      
      // scenarioKey 계산하여 포함
      const scenarioKey = getScenarioKeyFromLocation(window.location);
      
      sendResponse({
        ...result,
        scenarioKey: scenarioKey,
      });
      return true;
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
    console.log('[Rofan Visualboard][content] Auto-update observer detached');
  }
}

// rofan.ai 자동 업데이트 Observer 설정
function setupRofanAutoUpdateObserver() {
  // 이미 설정돼 있으면 다시 만들지 않음
  if (autoUpdateObserver) return;

  const chatRoot = document.querySelector('div.lg\\:pr-5.overflow-y-auto');
  if (!chatRoot) {
    console.warn('[Rofan Visualboard][content] chat root not found for auto update');
    return;
  }

  let timer = null;
  autoUpdateObserver = new MutationObserver(() => {
    // 너무 자주 호출되지 않게 디바운스
    if (timer) clearTimeout(timer);
    timer = setTimeout(handleAutoUpdateTurn, 500);
  });

  autoUpdateObserver.observe(chatRoot, {
    childList: true,
    subtree: true,
  });

  console.log('[Rofan Visualboard][content] Auto-update observer attached');
}

// 새 턴이 감지되면 마지막 턴 텍스트 추출 → service-worker로 전달
function handleAutoUpdateTurn() {
  const result = extractLastAiMessageFromRofanAi();
  if (!result || !result.success || !result.text) return;

  const text = result.text;

  // 이전에 보낸 것과 동일하면 무시 (연속 Mutation 방지)
  if (text === lastAutoTurnText) return;

  // debounce: 500ms 이내에 추가 요청이 오면 무시
  const now = Date.now();
  if (now - lastAutoUpdateRequestTime < 500) {
    console.log('[Rofan Visualboard][content] Auto-update request throttled (debounce)');
    return;
  }

  lastAutoTurnText = text;
  lastAutoUpdateRequestTime = now;

  // chrome.runtime 확인
  if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    console.warn('[Rofan Visualboard][content] chrome.runtime.sendMessage not available');
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
    console.log('[Rofan Visualboard][content] Entered chat page:', currentPath);
    // DOM이 완전히 로드될 때까지 대기
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setupRofanAutoUpdateObserver();
      }, { once: true });
    } else {
      // DOM이 이미 로드된 경우
      setupRofanAutoUpdateObserver();
    }
  } else {
    // /chat/... 페이지에서 벗어남
    if (autoUpdateObserver) {
      console.log('[Rofan Visualboard][content] Left chat page:', currentPath);
      teardownRofanAutoUpdateObserver();
    }
  }
}

// 초기화: rofan.ai 도메인에서 location.href 감시 시작
if (window.location.host === 'rofan.ai') {
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
