console.log('[Vivid Chat] Side panel script loaded');

// 개발자 모드 플래그 (디버깅 로그 제어)
const DEV_MODE = false; // true로 설정하면 상세 디버깅 로그 출력

// iframe 요소 참조
const iframe = document.getElementById('visualboard-frame');

// Provider 선택 상태
let currentProvider = 'rofan-ai';

// 분석 모드: 'last-ai' | 'selection' (개발자 모드에서만 사용)
let analysisMode = 'last-ai';

// 자동 업데이트 상태
let autoUpdateEnabled = false;

// 중복 분석 방지용 키 (같은 턴에 대해 두 번 분석하지 않도록)
// Step2: lastAnalyzed는 제거하고 lastSuccessRecord로 대체
// let lastAnalyzed = null; // { provider, messageId, textHash } 형태

// 현재 브라우저 창 전체에서 공유하는 Visualboard 세계 상태
let currentStoryState = null;

// 현재 턴 ID (Step2 추가)
let currentTurnId = null;

// 현재 이 사이드패널 인스턴스가 바라보고 있는 시나리오 키
// (예: https://rofan.ai/chat/xxxx 형태)
let currentScenarioKey = null;

// Window ID 기반 상태 관리 (v0에서는 메모리만 사용, 나중에 chrome.storage.session 확장 가능)
let currentWindowId = null;

// 메시지 sender 식별자
const SENDER_ID = 'visualboard-sidepanel';
// 프로토콜 버전
const PROTOCOL_VERSION = 'visualboard-v1';

// ============================================================================
// Dev/Prod 서버 전환 (커밋 1)
// ============================================================================

// baseUrl 모듈 스코프 변수 (window 전역 사용 안 함)
let currentBaseUrl = null;

/**
 * baseUrl 가져오기 (chrome.storage.local에서 읽기)
 */
async function getBaseUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['server_env'], (result) => {
      const env = result.server_env || 'prod'; // 기본값: prod
      const baseUrl = env === 'dev' 
        ? 'http://localhost:3001' 
        : 'https://rofan.world';
      resolve(baseUrl);
    });
  });
}

/**
 * Sidepanel 초기화 (baseUrl 로드 및 iframe src 설정)
 */
async function initializeSidepanel() {
  // baseUrl 로드
  currentBaseUrl = await getBaseUrl();
  console.log('[Vivid Chat] Initialized with baseUrl:', currentBaseUrl);
  
  // iframe src 설정
  const iframe = document.getElementById('visualboard-frame');
  if (iframe) {
    iframe.src = `${currentBaseUrl}/test-board?embed=1`;
    console.log('[Vivid Chat] Iframe src set to:', iframe.src);
  }
  
  // Dev 모드 표시 (선택)
  if (currentBaseUrl.includes('localhost')) {
    showDevIndicator();
  }
}

/**
 * 커밋5: sidepanel 마운트 시 1회 자동 복원 (자동업데이트 토글과 무관)
 */
async function restoreLastSuccessOnMount() {
  try {
    // 현재 활성 탭의 시나리오 키 가져오기
    const result = await requestLastAiMessageFromContentScript(currentProvider);
    if (!result || !result.scenarioKey) {
      console.log('[Vivid Chat] No scenario key available for auto-restore');
      return;
    }

    const scenarioKey = result.scenarioKey;
    
    // lastSuccessRecord 로드
    const lastSuccess = loadLastSuccessRecord(scenarioKey);
    // 핫픽스: lastError 체크 제거 - state가 있으면 복원 (lastError는 재시도 정책에만 사용)
    if (!lastSuccess || !lastSuccess.state) {
      console.log('[Vivid Chat] No valid lastSuccessRecord for auto-restore', {
        hasRecord: !!lastSuccess,
        hasState: !!lastSuccess?.state,
      });
      return;
    }

    // 보드가 이미 채워져 있으면 복원 스킵 (중복 방지)
    if (currentStoryState !== null) {
      console.log('[Vivid Chat] Board already has state, skipping auto-restore');
      return;
    }

    // 복원 실행
    console.log('[Vivid Chat] Auto-restoring last success state on mount');
    const restored = restoreLastSuccessState(lastSuccess, scenarioKey);
    
    if (restored) {
      console.log('[Vivid Chat] Auto-restore succeeded:', {
        turnId: lastSuccess.turnId,
        scenarioKey: scenarioKey,
      });
      // 복원 성공 시 currentStoryState/currentTurnId는 restoreLastSuccessState에서 이미 동기화됨
    } else {
      console.warn('[Vivid Chat] Auto-restore failed');
    }
  } catch (err) {
    // 복원 실패는 조용히 처리 (사용자에게 노출하지 않음)
    console.log('[Vivid Chat] Auto-restore skipped:', err.message);
  }
}

/**
 * Dev 모드 표시 (아주 작게)
 */
function showDevIndicator() {
  const indicator = document.getElementById('dev-mode-indicator');
  if (indicator) {
    indicator.style.display = 'inline';
    indicator.textContent = '🔴 DEV';
  }
}

// 현재 창 ID 가져오기
chrome.windows.getCurrent((window) => {
  if (window && window.id) {
    currentWindowId = window.id;
    console.log('[Vivid Chat] Current window ID:', currentWindowId);
  }
});

// 토스트 메시지 표시 함수 (중앙 하단)
function showToast(message, type = 'success') {
  let toast = document.getElementById('rv-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rv-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '16px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.padding = '8px 12px';
    toast.style.borderRadius = '999px';
    toast.style.fontSize = '12px';
    toast.style.zIndex = '9999';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.backgroundColor = type === 'success' ? '#16a34a' : '#dc2626';
  toast.style.color = '#fff';
  toast.style.opacity = '1';

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
  }, 1400);
}

// 버튼 상태 관리
const analyzeButton = document.getElementById('analyze-last-turn-btn');
const originalButtonText = analyzeButton ? analyzeButton.textContent : '최근 턴 분석하기';

// 분석 상태 및 에러 상태 관리
let isAnalyzingLastTurn = false;
let lastAnalyzeError = null;

function setButtonLoading(isLoading) {
  if (!analyzeButton) return;
  if (isLoading) {
    analyzeButton.disabled = true;
    analyzeButton.textContent = '분석 중...';
  } else {
    analyzeButton.disabled = false;
    analyzeButton.textContent = originalButtonText;
  }
}

// 에러 메시지를 sidepanel UI에만 표시하는 함수
function updateAnalyzeError(errorMessage) {
  lastAnalyzeError = errorMessage;
  
  // 에러 메시지 영역 찾기 또는 생성
  let errorContainer = document.getElementById('analyze-error-container');
  if (!errorContainer) {
    errorContainer = document.createElement('div');
    errorContainer.id = 'analyze-error-container';
    errorContainer.className = 'error-alert';
    
    // 컨트롤 바 바로 아래에 삽입
    const controlBar = document.querySelector('.control-bar');
    if (controlBar && controlBar.parentNode) {
      controlBar.parentNode.insertBefore(errorContainer, controlBar.nextSibling);
    }
  }
  
  if (errorMessage) {
    const errorMsg = '분석에 실패했어요. rofan.ai 채팅 탭을 열어둔 상태인지 확인한 뒤 다시 눌러주세요.';
    errorContainer.innerHTML = `
      <div class="error-alert-content">
        <span>${errorMsg}</span>
        <button class="error-alert-close" aria-label="닫기">×</button>
      </div>
    `;
    errorContainer.style.display = 'block';
    
    // 닫기 버튼 이벤트 리스너 추가
    const closeBtn = errorContainer.querySelector('.error-alert-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        errorContainer.style.display = 'none';
        lastAnalyzeError = null;
      });
    }
  } else {
    errorContainer.style.display = 'none';
  }
}

// 시나리오 변경 처리 헬퍼 함수
function handleScenarioChange(nextScenarioKey) {
  if (!nextScenarioKey) {
    return;
  }

  // 시나리오가 동일하면 아무 것도 하지 않음
  if (currentScenarioKey === nextScenarioKey) {
    return;
  }

  console.log(
    '[Vivid Chat] Scenario changed:',
    currentScenarioKey,
    '→',
    nextScenarioKey
  );

  // 시나리오 변경 시 내부 상태만 초기화 (RESET_STORY_STATE는 보내지 않음)
  // RESET_STORY_STATE는 사용자가 "보드 초기화" 버튼을 눌렀을 때만 전송
  currentStoryState = null;
  currentTurnId = null; // Step2: turnId 초기화
  // lastAnalyzed = null; // Step2: 제거 (lastSuccessRecord로 대체)
  lastPostedStateHash = null; // 마지막 전송한 state 해시도 리셋
  messageSendCounter = 0; // 메시지 카운터 리셋
  lastPostTime = 0; // 마지막 전송 시간 리셋

  // 시나리오 키 갱신
  currentScenarioKey = nextScenarioKey;
}

// 마지막으로 전송한 state 추적 (중복 전송 방지)
let lastPostedStateHash = null;
// 메시지 전송 카운터 (무한 루프 방지)
let messageSendCounter = 0;
// 마지막 전송 시간 (너무 빠른 연속 전송 방지)
let lastPostTime = 0;

// ============================================================================
// Step2: Storage 헬퍼 함수 (localStorage 직접 사용)
// ============================================================================

const LAST_SUCCESS_KEY_PREFIX = 'vivid-chat-last-success::';
const CAST_KEY_PREFIX = 'vivid-chat-cast::';

/**
 * TurnId 계산 (textHash 기반 또는 messageId)
 */
function calculateTurnId(text, messageId) {
  if (messageId) {
    return messageId;
  }
  // textHash: 길이 + 첫 50자
  const trimmed = text.trim();
  return `${trimmed.length}:${trimmed.slice(0, 50)}`;
}

/**
 * LastSuccessRecord 로드 (레거시 timestamp → savedAt 마이그레이션 포함)
 */
function loadLastSuccessRecord(scenarioKey) {
  if (!scenarioKey || typeof window === 'undefined') return null;
  
  const key = `${LAST_SUCCESS_KEY_PREFIX}${scenarioKey}`;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw);
    
    // 핫픽스: 레거시 timestamp → savedAt 마이그레이션
    if (record && !record.savedAt && record.timestamp) {
      record.savedAt = record.timestamp; // timestamp를 savedAt으로 복사
      // timestamp는 deprecated이지만 호환성을 위해 유지 (읽기 전용)
      console.log('[Vivid Chat] Migrated timestamp to savedAt for record:', scenarioKey);
      // 마이그레이션된 레코드 재저장 (선택적)
      try {
        saveLastSuccessRecord(scenarioKey, record);
      } catch (e) {
        console.warn('[Vivid Chat] Failed to save migrated record:', e);
      }
    }
    
    return record;
  } catch (e) {
    console.warn('[Vivid Chat] Failed to load last success record:', e);
    return null;
  }
}

/**
 * LastSuccessRecord 저장
 */
function saveLastSuccessRecord(scenarioKey, record) {
  if (!scenarioKey || typeof window === 'undefined') return;
  
  const key = `${LAST_SUCCESS_KEY_PREFIX}${scenarioKey}`;
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch (e) {
    console.warn('[Vivid Chat] Failed to save last success record:', e);
  }
}

/**
 * CastStore 로드 (Step2에서 사용)
 */
function loadCastStore(scenarioKey) {
  if (!scenarioKey || typeof window === 'undefined') return null;
  
  const key = `${CAST_KEY_PREFIX}${scenarioKey}`;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    
    // v2 형식인지 확인
    if (parsed && typeof parsed === 'object' && parsed.version === 'v2') {
      return parsed;
    }
    
    // v1 형식이면 빈 v2 반환 (마이그레이션은 iframe에서 처리)
    return { version: 'v2', charactersById: {}, aliasMap: {} };
  } catch (e) {
    console.warn('[Vivid Chat] Failed to load cast store:', e);
    return null;
  }
}

/**
 * 빈 CastStore 생성
 */
function createEmptyCastStore() {
  return { version: 'v2', charactersById: {}, aliasMap: {} };
}

/**
 * CastStore 저장 (Step4 Hotfix: Extension localStorage에 저장)
 */
function saveCastStore(scenarioKey, castStore) {
  if (!scenarioKey || typeof window === 'undefined') return false;
  
  const key = `${CAST_KEY_PREFIX}${scenarioKey}`;
  try {
    window.localStorage.setItem(key, JSON.stringify(castStore));
    return true;
  } catch (e) {
    console.warn('[Vivid Chat] Failed to save castStore', {
      scenarioKey,
      error: String(e),
    });
    return false;
  }
}

/**
 * Step4: Alias 정규화 (trim, lowercase, 단일 공백)
 */
function normalizeAlias(alias) {
  if (!alias || typeof alias !== 'string') return '';
  return alias
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' '); // 연속 공백 → 단일 공백
}

/**
 * Step4: 대명사/지시어 필터링 (aliasMap 오염 방지)
 * 대명사는 aliasMap에 저장하지 않음 (AI가 문맥으로 매칭 가능)
 */
function isPronounOrDemonstrative(alias) {
  const normalized = normalizeAlias(alias);
  const pronouns = [
    '그', '그녀', '나', '너', '우리', '당신', '이 사람', '저 사람',
    '그쪽', '여기', '저기', '그것', '이것', '저것',
    '그녀석', '저자', '본인', '당신들', '그들', '그녀들',
    '그분', '이분', '저분', '그대', '이대', '저대'
  ];
  return pronouns.includes(normalized);
}

/**
 * Step4: CastStoreV2 → CastHint[] 변환
 * 대명사/지시어는 aliases에서 제외
 */
function buildCastHints(castStore) {
  if (!castStore || !castStore.charactersById) {
    return [];
  }
  
  const hints = [];
  const characterNames = [];
  
  for (const [id, entry] of Object.entries(castStore.charactersById)) {
    // aliases에서 대명사/지시어 필터링
    const filteredAliases = (entry.aliases || []).filter(
      alias => !isPronounOrDemonstrative(alias)
    );
    
    // castStore 실제 구조 검증: entry.gender 경로 확인
    const entryGender = entry.gender;
    const profileGender = entry.profile?.gender;
    const finalGender = entryGender || profileGender || 'unknown';
    
    // 디버깅: gender 값 및 경로 확인 (DEV_MODE만)
    if (DEV_MODE && (entryGender || profileGender)) {
      console.log('[Vivid Chat] buildCastHints entry:', {
        id: entry.id,
        canonicalName: entry.canonicalName,
        'entry.gender': entryGender,
        'entry.profile?.gender': profileGender,
        finalGender,
      });
    }
    
    hints.push({
      id: entry.id,
      canonicalName: entry.canonicalName || '',
      aliases: filteredAliases,
      gender: finalGender,
    });
    
    characterNames.push(entry.canonicalName || id);
  }
  
  // 로깅 (전문 금지: 개수 + canonicalName 목록만)
  if (hints.length > 0) {
    console.log('[Vivid Chat] castHints generated', {
      count: hints.length,
      characterNames: characterNames.slice(0, 10), // 최대 10개
    });
  }
  
  return hints;
}

/**
 * Step4 단계 5: UUID 생성 (crypto.randomUUID 사용)
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback (브라우저 호환성)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Step4 단계 5: Ghost 캐릭터 생성
 * 초기 상태: isGhost: true, gender: 'unknown', aliases: [canonicalName]
 */
function createGhostCharacter(name) {
  if (!name || typeof name !== 'string') {
    console.warn('[Vivid Chat] createGhostCharacter: invalid name', name);
    name = 'Unknown';
  }
  
  const id = generateUUID();
  return {
    id,
    canonicalName: name.trim(),
    aliases: [name.trim()], // 대명사/지시어는 이미 필터링됨
    gender: 'unknown',
    isGhost: true,
  };
}

/**
 * Step4 단계 5: aliasMap 업데이트 (충돌 시 Overwrite)
 * 대명사/지시어는 저장하지 않음
 */
function updateAliasMap(castStore, alias, characterId) {
  if (!castStore || !alias || !characterId) {
    console.warn('[Vivid Chat] updateAliasMap: invalid params', {
      hasCastStore: !!castStore,
      alias,
      characterId,
    });
    return;
  }
  
  const normalized = normalizeAlias(alias);
  
  // 대명사/지시어는 aliasMap에 저장하지 않음 (오염 방지)
  if (isPronounOrDemonstrative(alias)) {
    return; // 저장하지 않음
  }
  
  // 빈 문자열도 저장하지 않음
  if (!normalized || normalized.length === 0) {
    return;
  }
  
  const existingId = castStore.aliasMap[normalized];
  
  // 충돌 처리: Overwrite 정책
  if (existingId && existingId !== characterId) {
    console.warn(
      `[Vivid Chat] aliasMap conflict: "${alias}" was ${existingId}, now ${characterId}`
    );
  }
  
  castStore.aliasMap[normalized] = characterId;
}

/**
 * Step4 단계 5: 캐릭터 매칭 처리 (refId/isNew 기반 Ghost 생성 및 aliasMap 업데이트)
 * Ghost 생성 조건: isNew === true 또는 refId 없음 + aliasMap 매칭 실패
 */
function processCharacterMatching(state, castStore, scenarioKey) {
  if (!state || !state.scenes || !Array.isArray(state.scenes) || !castStore) {
    console.warn('[Vivid Chat] processCharacterMatching: invalid params', {
      hasState: !!state,
      hasScenes: !!(state && state.scenes),
      hasCastStore: !!castStore,
    });
    return castStore;
  }
  
  const updatedCast = {
    ...castStore,
    charactersById: { ...castStore.charactersById },
    aliasMap: { ...castStore.aliasMap },
  };
  
  let ghostCreatedCount = 0;
  let matchedCount = 0;
  
  for (const scene of state.scenes) {
    if (!scene.characters || !Array.isArray(scene.characters)) continue;
    
    for (const character of scene.characters) {
      if (!character || typeof character.name !== 'string') continue;
      
      const normalizedName = normalizeAlias(character.name);
      
      // 규칙 1: refId 우선 처리
      if (character.refId) {
        const existingChar = updatedCast.charactersById[character.refId];
        if (existingChar) {
          // 기존 캐릭터 재사용
          updateAliasMap(updatedCast, character.name, character.refId);
          matchedCount++;
        } else {
          // refId가 있지만 CastStore에 없음 → 경고 + Ghost 생성 (안전장치)
          console.warn('[Vivid Chat] refId not found in CastStore:', character.refId);
          const ghost = createGhostCharacter(character.name);
          updatedCast.charactersById[ghost.id] = ghost;
          updateAliasMap(updatedCast, character.name, ghost.id);
          character.refId = ghost.id; // 후처리
          ghostCreatedCount++;
        }
      }
      // 규칙 2: isNew === true 처리
      else if (character.isNew === true) {
        const ghost = createGhostCharacter(character.name);
        updatedCast.charactersById[ghost.id] = ghost;
        updateAliasMap(updatedCast, character.name, ghost.id);
        character.refId = ghost.id; // 후처리
        ghostCreatedCount++;
      }
      // 규칙 3: refId 없음 + aliasMap 매칭 시도
      else {
        // aliasMap에서 매칭 시도
        const matchedId = updatedCast.aliasMap[normalizedName];
        if (matchedId && updatedCast.charactersById[matchedId]) {
          // 매칭 성공: 기존 캐릭터 재사용
          updateAliasMap(updatedCast, character.name, matchedId);
          character.refId = matchedId; // 후처리
          matchedCount++;
        } else {
          // 매칭 실패: Ghost 생성
          const ghost = createGhostCharacter(character.name);
          updatedCast.charactersById[ghost.id] = ghost;
          updateAliasMap(updatedCast, character.name, ghost.id);
          character.refId = ghost.id; // 후처리
          ghostCreatedCount++;
        }
      }
    }
  }
  
  // CastStore 저장
  const saved = saveCastStore(scenarioKey, updatedCast);
  
  // 로깅 (전문 금지: 개수만)
  if (ghostCreatedCount > 0 || matchedCount > 0) {
    console.log('[Vivid Chat] Character matching completed', {
      ghostCreated: ghostCreatedCount,
      matched: matchedCount,
      saved,
    });
  }
  
  return updatedCast;
}

/**
 * Step4 Hotfix: iframe에서 캐스트 동기화 처리
 * scenarioKey 검증 후 extension castStore에 저장
 */
function handleCastStoreUpdate(scenarioKey, castStore) {
  if (!scenarioKey || !castStore) {
    console.warn('[Vivid Chat] Invalid cast store update:', { scenarioKey, hasCastStore: !!castStore });
    return;
  }
  
  // scenarioKey가 현재 sidepanel의 scenarioKey와 다르면 무시 (다른 탭/시나리오 오염 방지)
  if (scenarioKey !== currentScenarioKey) {
    console.warn('[Vivid Chat] Ignoring cast store update: scenarioKey mismatch', {
      received: scenarioKey,
      current: currentScenarioKey,
    });
    return;
  }
  
  // castStore 검증
  if (!castStore.version || castStore.version !== 'v2') {
    console.warn('[Vivid Chat] Invalid cast store version:', castStore.version);
    return;
  }
  
  // extension castStore에 저장 (안전장치: 함수 존재 여부 확인)
  if (typeof saveCastStore !== 'function') {
    console.error('[Vivid Chat] saveCastStore is not defined! Function definition missing.');
    return;
  }
  
  // 저장 전 상태 확인
  const charactersCount = castStore.charactersById ? Object.keys(castStore.charactersById).length : 0;
  
  // 중요: 저장 성공 로그는 유지 (핵심 기능 확인용)
  if (DEV_MODE) {
    const sampleCharacter = charactersCount > 0 ? Object.values(castStore.charactersById)[0] : null;
    const storageKey = `${CAST_KEY_PREFIX}${scenarioKey}`;
    console.log('[Vivid Chat] Before saveCastStore:', {
      scenarioKey,
      storageKey,
      charactersCount,
      sampleCharacterGender: sampleCharacter?.gender,
    });
  }
  
  const saved = saveCastStore(scenarioKey, castStore);
  
  // 저장 후 즉시 검증: 저장된 값 다시 읽어서 확인
  if (saved) {
    // 중요: 저장 성공 로그는 유지 (핵심 기능 확인용)
    console.log('[Vivid Chat] Cast store synced from iframe', {
      charactersCount,
    });
    
    if (DEV_MODE) {
      const verifyStore = loadCastStore(scenarioKey);
      const verifyCount = verifyStore?.charactersById ? Object.keys(verifyStore.charactersById).length : 0;
      const verifySample = verifyCount > 0 ? Object.values(verifyStore.charactersById)[0] : null;
      const sampleCharacter = charactersCount > 0 ? Object.values(castStore.charactersById)[0] : null;
      console.log('[Vivid Chat] Cast store verified:', {
        verifyCount,
        verifySampleGender: verifySample?.gender,
        match: verifyCount === charactersCount && verifySample?.gender === sampleCharacter?.gender,
      });
    }
  } else {
    console.warn('[Vivid Chat] Failed to save cast store from iframe', {
      scenarioKey,
      charactersCount,
    });
  }
}

/**
 * Step4: previousState.scenes에서 CastHint[] 추출 (fallback)
 * id는 omit (refId로 사용될 수 없도록 안전장치)
 * aliases는 [name]만 (대명사/지시어 금지)
 */
function buildCastHintsFromPreviousState(previousState) {
  if (!previousState || !previousState.scenes || !Array.isArray(previousState.scenes)) {
    return [];
  }
  
  const hints = [];
  const seenNames = new Set();
  
  for (const scene of previousState.scenes) {
    if (!scene.characters || !Array.isArray(scene.characters)) {
      continue;
    }
    
    for (const character of scene.characters) {
      const name = character.name?.trim();
      if (!name || seenNames.has(name)) {
        continue; // 중복 제거
      }
      
      // 대명사/지시어는 제외
      if (isPronounOrDemonstrative(name)) {
        continue;
      }
      
      // id는 omit (refId로 사용될 수 없도록 안전장치)
      hints.push({
        // id 없음 (optional이므로 omit 가능)
        canonicalName: name,
        aliases: [name], // name만 aliases로 사용
        gender: 'unknown',
      });
      
      seenNames.add(name);
    }
  }
  
  return hints;
}

/**
 * lastSuccessRecord 복원 (공통 로직) - Step3: v1 레거시 마이그레이션 포함
 */
function restoreLastSuccessState(record, scenarioKey) {
  if (!record || !record.state) return false;
  
  // Step3: v1 레거시 마이그레이션 (record.state 기준)
  let stateToRestore = record.state;
  
  if (!stateToRestore.scenes || !Array.isArray(stateToRestore.scenes) || stateToRestore.scenes.length === 0) {
    // v1 형식: scene + characters + dialogue_impact를 scenes[]로 변환
    if (stateToRestore.scene && stateToRestore.characters) {
      stateToRestore = {
        ...stateToRestore,
        scenes: [{
          summary: stateToRestore.scene.summary || '',
          type: stateToRestore.scene.type || 'room',
          location_name: stateToRestore.scene.location_name,
          backdrop_style: stateToRestore.scene.backdrop_style,
          characters: stateToRestore.characters, // characters 주입
          dialogue_impact: stateToRestore.dialogue_impact || 'medium', // dialogue_impact 주입
        }],
        activeSceneIndex: 0,
      };
      console.log('[Vivid Chat] Migrated v1 record to v2 format during restore');
    } else {
      console.warn('[Vivid Chat] Cannot restore: invalid state format');
      return false;
    }
  }
  
  // state 복원 (scenes가 반드시 존재)
  const sent = postStoryStateToIframe(stateToRestore, scenarioKey);
  if (!sent) return false;
  
  // 내부 상태 동기화
  currentStoryState = stateToRestore;
  currentTurnId = record.turnId;
  currentScenarioKey = scenarioKey;
  
  // Step3: 로깅 (scenes 정보만)
  const scenesCount = stateToRestore.scenes?.length || 0;
  const activeSceneIndex = stateToRestore.activeSceneIndex ?? (scenesCount > 0 ? scenesCount - 1 : 0);
  
  console.log('[Vivid Chat] Restored last success state:', {
    turnId: record.turnId,
    scenarioKey: scenarioKey,
    scenesCount: scenesCount,
    activeSceneIndex: activeSceneIndex,
  });
  
  return true;
}

/**
 * 분석 성공 시 lastSuccessRecord 저장 (공통 로직)
 */
function saveLastSuccessOnAnalysis(scenarioKey, turnId, state, updatedCastStore) {
  if (!scenarioKey || !turnId || !state) {
    console.warn('[Vivid Chat] saveLastSuccessOnAnalysis skipped: missing params', {
      hasScenarioKey: !!scenarioKey,
      hasTurnId: !!turnId,
      hasState: !!state,
    });
    return;
  }
  
  try {
    // Step4 단계 5: updatedCastStore가 있으면 우선 사용, 없으면 기존 로직
    const castStore = updatedCastStore || loadCastStore(scenarioKey) || createEmptyCastStore();
    
    const record = {
      scenarioKey: scenarioKey, // 명시적 필드 추가
      turnId: turnId,
      state: state,
      cast: castStore,
      savedAt: Date.now(), // 시간 필드 통일 (epoch ms)
      lastError: null, // 핫픽스: 성공 시 에러 명시적 초기화
    };
    
    saveLastSuccessRecord(scenarioKey, record);
    console.log('[Vivid Chat] Saved last success record:', { turnId, scenarioKey });
  } catch (err) {
    console.error('[Vivid Chat] Failed to save last success record:', err);
  }
}

/**
 * 분석 실패 시 lastError 저장 (공통 로직)
 */
function saveLastErrorOnFailure(scenarioKey, turnId, errorMessage) {
  if (!scenarioKey || !turnId || !errorMessage) {
    console.warn('[Vivid Chat] saveLastErrorOnFailure skipped: missing params', {
      hasScenarioKey: !!scenarioKey,
      hasTurnId: !!turnId,
      hasErrorMessage: !!errorMessage,
    });
    return;
  }
  
  try {
    const lastSuccess = loadLastSuccessRecord(scenarioKey);
    
    if (lastSuccess && lastSuccess.turnId === turnId) {
      // 같은 turnId면 lastError만 업데이트
      lastSuccess.lastError = errorMessage;
      lastSuccess.savedAt = Date.now(); // 시간 필드 통일 (epoch ms)
      saveLastSuccessRecord(scenarioKey, lastSuccess);
    } else {
      // 다른 turnId면 새 레코드 생성 (이전 state 유지)
      const castStore = loadCastStore(scenarioKey) || createEmptyCastStore();
      const record = {
        scenarioKey: scenarioKey, // 명시적 필드 추가
        turnId: turnId,
        state: lastSuccess?.state || null, // 이전 state 유지
        cast: castStore,
        savedAt: Date.now(), // 시간 필드 통일 (epoch ms)
        lastError: errorMessage,
      };
      saveLastSuccessRecord(scenarioKey, record);
    }
    
    console.log('[Vivid Chat] Saved last error:', { turnId, errorMessage, scenarioKey });
  } catch (err) {
    console.error('[Vivid Chat] Failed to save last error:', err);
  }
}

// iframe으로 StoryState 전달하는 헬퍼 함수 - Step3: scenes[] 반드시 존재 보장
function postStoryStateToIframe(state, scenarioKey) {
  const iframe = document.getElementById('visualboard-frame');
  if (!iframe || !iframe.contentWindow) {
    console.warn('[Vivid Chat] iframe not ready');
    return false;
  }

  // Step3: StoryStateV2 기준 - scenes가 반드시 존재하도록 보장
  let stateToSend = state;
  if (!stateToSend.scenes || !Array.isArray(stateToSend.scenes) || stateToSend.scenes.length === 0) {
    // v1 형식이면 변환 (보험용)
    if (stateToSend.scene && stateToSend.characters) {
      stateToSend = {
        ...stateToSend,
        scenes: [{
          summary: stateToSend.scene.summary || '',
          type: stateToSend.scene.type || 'room',
          location_name: stateToSend.scene.location_name,
          backdrop_style: stateToSend.scene.backdrop_style,
          characters: stateToSend.characters,
          dialogue_impact: stateToSend.dialogue_impact || 'medium',
        }],
        activeSceneIndex: 0,
      };
      console.log('[Vivid Chat] Converted v1 state to v2 before sending to iframe');
    } else {
      console.error('[Vivid Chat] Cannot send: state missing scenes');
      return false;
    }
  }

  // scenarioKey가 제공되지 않으면 현재 시나리오 키 사용
  const finalScenarioKey = scenarioKey ?? currentScenarioKey ?? null;

  // 중복 전송 방지: 같은 state를 연속으로 보내지 않음
  const stateHash = stateToSend ? JSON.stringify(stateToSend) : null;
  if (stateHash && stateHash === lastPostedStateHash) {
    console.log('[Vivid Chat] Skip postStoryStateToIframe: duplicate state (no-op)');
    return 'duplicate'; // Step4 Hotfix: duplicate는 성공(no-op)으로 처리
  }

  // 너무 빠른 연속 전송 방지 (100ms 이내 재전송 차단)
  const now = Date.now();
  if (now - lastPostTime < 100) {
    console.warn('[Vivid Chat] Skip postStoryStateToIframe: too frequent (throttled)');
    return false;
  }
  lastPostTime = now;

  // 메시지 고유 ID 생성
  messageSendCounter += 1;
  const messageId = `sidepanel-${Date.now()}-${messageSendCounter}`;

  lastPostedStateHash = stateHash;

  // Step3: 로깅 (scenes 정보만)
  const scenesCount = stateToSend.scenes?.length || 0;
  const activeSceneIndex = stateToSend.activeSceneIndex ?? (scenesCount > 0 ? scenesCount - 1 : 0);
  const locationNames = stateToSend.scenes?.slice(0, 5).map(s => s.location_name || '(없음)').join(', ') || '';

  console.log('[Vivid Chat] STORY_STATE_UPDATE posted to iframe:', {
      messageId: messageId,
      scenarioKey: finalScenarioKey,
    scenesCount: scenesCount,
    activeSceneIndex: activeSceneIndex,
    locationNames: scenesCount > 5 ? locationNames + '...' : locationNames,
  });

  // 프로토콜 v1 형식으로 메시지 전송 (scenes[] 포함)
  iframe.contentWindow.postMessage(
    {
      protocol: PROTOCOL_VERSION,
      sender: SENDER_ID,
      type: 'STORY_STATE_UPDATE',
      state: stateToSend, // scenes[] 반드시 포함
      scenarioKey: finalScenarioKey,
      timestamp: Date.now(),
    },
    '*' // 실제 iframe origin (www.rofan.world 또는 rofan.world)과 상관없이 전달
  );

  return true;
}

// ============================================================================
// BotContext 조회 유틸 (chrome.storage.local)
// ============================================================================

/**
 * 현재 탭 URL에서 chatId 추출
 */
async function getChatIdFromActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs || tabs.length === 0) return null;
    
    const tab = tabs[0];
    if (!tab.url) return null;

    // URL에서 chatId 추출: /chat/{chatId} 또는 /en/chat/{chatId}
    const url = new URL(tab.url);
    const pathMatch = url.pathname.match(/\/(?:en\/)?chat\/([^\/]+)/);
    return pathMatch ? pathMatch[1] : null;
  } catch (err) {
    console.warn('[Vivid Chat] Failed to get chatId from active tab:', err);
    return null;
  }
}

/**
 * 현재 탭 URL에서 scenarioKey 추출 (기존 함수)
 */
async function getScenarioKeyFromActiveTabUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs || tabs.length === 0) return null;
    
    const tab = tabs[0];
    if (!tab.url) return null;

    const url = new URL(tab.url);
    if (url.hostname === 'rofan.ai') {
      const path = url.pathname;
      // /chat/... 또는 /en/chat/... 경로 체크
      if (path.startsWith('/chat/') || path.startsWith('/en/chat/')) {
        return `${url.origin}${url.pathname}`;
      }
    }
    return null;
  } catch (err) {
    console.warn('[Vivid Chat] Failed to get scenarioKey from active tab:', err);
    return null;
  }
}

/**
 * chatId 후보군으로부터 botContext 조회
 * @param {string} primaryChatId - URL에서 추출한 chatId (우선 시도)
 * @returns {Promise<{charName, persona, worldview, userName, userPersona} | null>}
 */
async function getBotContextForChatId(primaryChatId) {
  if (!primaryChatId) return null;

  // chatId 후보군: URL chatId + __NEXT_DATA__에서 추출 가능한 chatId
  // 일단 primaryChatId로 시도하고, 실패하면 다른 후보들도 시도
  const chatIdCandidates = [primaryChatId];
  
  // __NEXT_DATA__에서 chatId 후보 추가 시도 (content script에서 이미 저장했을 수 있음)
  // 여기서는 일단 primaryChatId만 사용하고, 실패 시 재시도 로직으로 처리

  return new Promise((resolve) => {
    // 모든 후보에 대해 session_map 조회 시도
    const keysToGet = [];
    chatIdCandidates.forEach(id => {
      keysToGet.push(`session_map::${id}`, `chat_user::${id}`);
    });

    chrome.storage.local.get(keysToGet, (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[Vivid Chat] Failed to get session_map/chat_user:', chrome.runtime.lastError);
        resolve(null);
        return;
      }

      // 후보군을 순회하며 botId 찾기
      let botId = null;
      let chatUser = null;
      let resolvedChatId = null;

      for (const id of chatIdCandidates) {
        const candidateBotId = result[`session_map::${id}`];
        const candidateChatUser = result[`chat_user::${id}`];
        
        if (candidateBotId) {
          botId = candidateBotId;
          chatUser = candidateChatUser;
          resolvedChatId = id;
          console.log('[Vivid Chat][debug] botContext resolved from chatId:', id);
          break;
        }
      }

      if (!botId) {
        console.warn('[Vivid Chat] botContext not found for chatIdCandidates:', chatIdCandidates);
        resolve(null);
        return;
      }

      // bot_master에서 persona/worldview 조회
      chrome.storage.local.get([`bot_master::${botId}`], (botResult) => {
        if (chrome.runtime.lastError) {
          console.warn('[Vivid Chat] Failed to get bot_master:', chrome.runtime.lastError);
          resolve(null);
          return;
        }

        const botMaster = botResult[`bot_master::${botId}`];
        if (!botMaster) {
          console.warn('[Vivid Chat] botMaster not found for botId:', botId);
          resolve(null);
          return;
        }

        const botContext = {
          charName: botMaster.botName || null, // ✅ 추가: 캐릭터 이름
          persona: botMaster.charPersona || null,
          worldview: botMaster.worldview || null,
          userName: chatUser?.userName || null,
          userPersona: chatUser?.userPersona || null,
        };

        // persona나 worldview 중 하나라도 있으면 반환
        if (botContext.persona || botContext.worldview || botContext.charName) {
          console.log('[Vivid Chat][load] botContext loaded', {
            primaryChatId: primaryChatId,
            resolvedChatId: resolvedChatId,
            chatIdCandidates: chatIdCandidates,
            botId: botId,
            charName: botContext.charName || null,
            personaLen: botContext.persona?.length || 0,
            worldviewLen: botContext.worldview?.length || 0,
            userName: botContext.userName || null,
          });
          resolve(botContext);
        } else {
          console.warn('[Vivid Chat] botContext incomplete (no persona/worldview/charName)');
          resolve(null);
        }
      });
    });
  });
}

// ============================================================================
// 공통 텍스트 분석 함수 (previousState 포함)
// ============================================================================

async function analyzeTextAndUpdateBoard({ source, provider, text, scenarioKey, messageId = null, allowDuplicate = false, force = false, onSuccess, onError }) {
  if (!text || !text.trim()) {
    console.warn('[Vivid Chat] analyzeText skipped – empty text');
    if (onError) onError('텍스트가 비어있습니다.');
    return;
  }

  // scenarioKey 확정: 파라미터 → currentScenarioKey → active tab URL 순서로 시도
  let finalScenarioKey = scenarioKey || currentScenarioKey;
  if (!finalScenarioKey) {
    console.warn('[Vivid Chat] scenarioKey is null, trying to get from active tab URL');
    finalScenarioKey = await getScenarioKeyFromActiveTabUrl();
    if (finalScenarioKey) {
      // 추출한 scenarioKey를 currentScenarioKey에 저장
      currentScenarioKey = finalScenarioKey;
      console.log('[Vivid Chat] scenarioKey set from active tab URL:', finalScenarioKey);
    }
  }
  
  // 최종적으로도 null이면 에러
  if (!finalScenarioKey) {
    console.error('[Vivid Chat] Cannot determine scenarioKey, aborting analysis');
    if (onError) onError('시나리오 키를 확인할 수 없습니다.');
    return;
  }

  // 디버그 로그
  console.log('[Vivid Chat] analyzeTextAndUpdateBoard called', {
    provider,
    autoUpdateEnabled,
    scenarioKeyParam: scenarioKey,
    currentScenarioKey: currentScenarioKey,
    finalScenarioKey: finalScenarioKey,
    source,
    force,
  });

  // Step2: 스킵 정책 재설계
  // 1) turnId 계산 (text 기반 해시)
  const turnId = calculateTurnId(text, messageId);
  
  // 2) lastSuccessRecord 로드 (finalScenarioKey 사용)
  const lastSuccess = finalScenarioKey ? loadLastSuccessRecord(finalScenarioKey) : null;
  
  // 3) 보드 상태 확인
  const isBoardEmpty = currentStoryState === null;
  
  // 4) Manual vs Auto 구분
  const isManual = source === 'last-ai' || force;
  const isAuto = source === 'auto' && !force;
  
  // 5) 스킵 판정 (Step2 상태 머신) - turnId 기반 강화
  if (!force) {
    // boardEmpty면 절대 스킵 금지 → 복원 또는 재분석
    if (isBoardEmpty && lastSuccess && lastSuccess.turnId === turnId && !lastSuccess.lastError) {
      // 복원 가능
      console.log('[Vivid Chat] Board empty, restoring from lastSuccessRecord');
      const restored = restoreLastSuccessState(lastSuccess, finalScenarioKey);
      if (restored) {
        // 복원 성공 시 API 호출은 스킵 (선택적)
        if (onSuccess) onSuccess();
        return;
      }
      // 복원 실패 시 재분석 진행
    }
    
    // ✅ turnId가 바뀌면 절대 no-op 처리하면 안 됨 (새 텍스트면 새 state)
    const previousTurnId = currentTurnId || null;
    const turnIdChanged = previousTurnId !== turnId;
    
    // boardHasState + Auto + sameTurnId + noError → 스킵
    if (!isBoardEmpty && isAuto && lastSuccess && lastSuccess.turnId === turnId && !lastSuccess.lastError && !turnIdChanged) {
      console.log('[Vivid Chat] Skip analyze: same turn already displayed (Auto mode)');
      return;
    }
    
    // ✅ turnId가 바뀌었으면 무조건 재분석 (중복 체크 무시)
    if (turnIdChanged) {
      console.log('[Vivid Chat] TurnId changed, forcing re-analysis:', {
        previousTurnId: previousTurnId,
        newTurnId: turnId,
      });
      // 재분석 진행 (스킵 안 함)
    }
    
    // lastError가 있으면 재시도 (boardEmpty든 boardHasState든)
    if (lastSuccess && lastSuccess.turnId === turnId && lastSuccess.lastError) {
      console.log('[Vivid Chat] Retrying analysis due to lastError:', lastSuccess.lastError);
      // 재시도 진행 (스킵 안 함)
    }
    
    // Manual은 "강제 최신 보기" (보드에 state가 있어도 재분석)
    // → 스킵 안 함, 재분석 진행
  }
  
  // force === true면 무조건 재분석 진행 (스킵 안 함)

  // 커밋3: 성공/실패 저장을 위한 상태 추적
  let analysisSucceeded = false;
  let analysisError = null;
  let finalStoryState = null;

  try {
    // baseUrl 사용 (모듈 스코프 변수)
    const baseUrl = currentBaseUrl || await getBaseUrl();
    if (!currentBaseUrl) {
      currentBaseUrl = baseUrl; // 캐시
    }
    
    const apiUrl = `${baseUrl}/api/analyze-chat`;
    console.log('[Vivid Chat] API call to:', apiUrl);
    
    // Step4: castHints 생성 (우선순위: castStore > lastSuccess > previousState)
    let castHints = [];
    let castStore = null;
    let castHintsSource = 'none';
    
    try {
      // 1순위: loadCastStore(finalScenarioKey) - scenarioKey가 null이어도 finalScenarioKey는 확정됨
      castStore = finalScenarioKey ? loadCastStore(finalScenarioKey) : null;
      
      // 디버깅: castStore 로드 결과 확인 (간소화)
      const hasCastStore = !!castStore;
      const charactersCount = castStore?.charactersById ? Object.keys(castStore.charactersById).length : 0;
      
      if (DEV_MODE) {
        const sampleCharacter = charactersCount > 0 ? Object.values(castStore.charactersById)[0] : null;
        console.log('[Rofan] loadCastStore (fetch 직전):', {
          hasStore: hasCastStore,
          charactersCount: charactersCount,
          sampleGender: sampleCharacter?.gender,
          sampleCanonicalName: sampleCharacter?.canonicalName,
          scenarioKey: finalScenarioKey || '(null)',
        });
      }
      
      if (castStore && castStore.charactersById && Object.keys(castStore.charactersById).length > 0) {
        castHints = buildCastHints(castStore);
        castHintsSource = 'castStore';
        // 중요: castHints source 로그는 유지 (핵심 기능 확인용)
        console.log('[Vivid Chat] castHints source: castStore');
      }
      // 2순위: lastSuccessRecord.cast (Step2에서 저장됨)
      else if (lastSuccess && lastSuccess.cast && lastSuccess.cast.charactersById && Object.keys(lastSuccess.cast.charactersById).length > 0) {
        castStore = lastSuccess.cast;
        castHints = buildCastHints(castStore);
        castHintsSource = 'lastSuccess';
        console.log('[Vivid Chat] castHints source: lastSuccess');
      }
      
      // 3순위: previousState.scenes에서 추출 (fallback, id 없음)
      if (castHints.length === 0 && currentStoryState) {
        castHints = buildCastHintsFromPreviousState(currentStoryState);
        castHintsSource = 'previousState';
        if (DEV_MODE) {
          console.log('[Vivid Chat] castHints source: previousState (fallback)');
        }
      }
    } catch (e) {
      console.warn('[Vivid Chat] Failed to build castHints:', e);
      castHints = []; // 실패 시 빈 배열 (안전장치)
    }
    
    // botContext 조회 (chatId에서) - 수동/자동 경로 모두에서 항상 수행
    let botContext = null;
    try {
      const chatId = await getChatIdFromActiveTab();
      if (chatId) {
        botContext = await getBotContextForChatId(chatId);
      } else {
        console.warn('[Vivid Chat] Cannot get chatId from active tab, botContext will be null');
      }
    } catch (e) {
      console.warn('[Vivid Chat] Failed to get botContext:', e);
      // botContext 실패해도 계속 진행
    }
    
    // 요청 body 구성
    const requestBody = {
        chatText: text.trim(),
        previousState: currentStoryState, // ★ 이전 세계 상태 넘기기
    };
    
    // castHints가 1명 이상이면 반드시 포함, 0명일 때만 생략
    if (castHints.length > 0) {
      requestBody.castHints = castHints;
    }
    
    // botContext가 있으면 항상 포함 (조건 제거)
    if (botContext) {
      requestBody.botContext = {
        charName: botContext.charName || undefined, // ✅ 추가: 캐릭터 이름
        persona: botContext.persona || undefined,
        worldview: botContext.worldview || undefined,
        userName: botContext.userName || undefined,
        userPersona: botContext.userPersona || undefined,
      };
    } else {
      // botContext가 없을 때 명시적으로 처리하고 경고 로그
      console.warn('[Vivid Chat] botContext is null/undefined, API call will proceed without bot context');
    }
      
      // 진단 로깅 (전문 텍스트 금지) + gender 값 확인
      const bodyKeys = Object.keys(requestBody);
      const castHintsIncluded = 'castHints' in requestBody;
      const botContextIncluded = 'botContext' in requestBody;
      const charsCount = castStore?.charactersById ? Object.keys(castStore.charactersById).length : 0;
      const sampleCastHint = castHints.length > 0 ? castHints[0] : null;
      
      // 중요: req 로그는 유지하되 간소화 (핵심 정보만)
      // source: 'manual' | 'auto' 구분
      const analyzeSource = source === 'last-ai' || source === 'selection' || force ? 'manual' : 'auto';
      console.log('[Rofan] req', {
        scenarioKey: finalScenarioKey || '(null)',
        chars: charsCount,
        castHints: castHints.length,
        source: castHintsSource,
        'analyze-call source': analyzeSource,
        hasBotContext: !!botContext,
        personaLen: botContext?.persona?.length || 0,
        worldviewLen: botContext?.worldview?.length || 0,
        botContext: botContextIncluded ? 'yes' : 'no',
        sampleCastHintGender: sampleCastHint?.gender,
      });
      
      // 상세 정보는 DEV_MODE만
      if (DEV_MODE) {
        console.log('[Rofan] req (detailed)', {
          scenarioKeyParam: scenarioKey || '(null)',
          currentScenarioKey: currentScenarioKey || '(null)',
          keys: bodyKeys,
          included: castHintsIncluded,
          botContextIncluded: botContextIncluded,
          sampleCastHintCanonicalName: sampleCastHint?.canonicalName,
          castHintsGenders: castHints.slice(0, 5).map(h => ({ name: h.canonicalName, gender: h.gender })),
        });
      }
    
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    console.log('[Vivid Chat] API response status:', resp.status);

    if (!resp.ok) {
      console.warn('[Vivid Chat] API error:', resp.status);
      analysisError = `API error: ${resp.status}`;
      throw new Error(analysisError);
    }

    const data = await resp.json();
    
    // ✅ 디버깅 로그: 응답 전체 구조 확인
    console.log('[Vivid Chat] API response received:', {
      hasOk: 'ok' in data,
      ok: data.ok,
      hasState: 'state' in data,
      hasData: 'data' in data,
      hasDataState: !!(data.data && 'state' in data.data),
      responseKeys: Object.keys(data),
    });
    
    // ✅ 표준화된 응답 형식 처리: ok 필드 확인
    if (data.ok === false) {
      // 에러 응답 처리
      const errorInfo = data.error || {};
      const errorCode = errorInfo.code || 'UNKNOWN_ERROR';
      const errorMessage = errorInfo.message || '분석 중 오류가 발생했습니다.';
      const rawPreview = errorInfo.rawPreview;
      
      console.error('[Vivid Chat] API returned error response:', {
        code: errorCode,
        message: errorMessage,
        hasRawPreview: !!rawPreview,
      });
      
      // 에러 메시지 생성
      let userFriendlyMessage = errorMessage;
      if (errorCode === 'PARSE_ERROR') {
        userFriendlyMessage = '분석 결과 형식이 올바르지 않아 표시할 수 없어요. 다시 시도해주세요.';
      } else if (errorCode === 'MODEL_REFUSAL') {
        userFriendlyMessage = '안전 정책으로 분석이 거절되었어요. (텍스트 일부가 제한될 수 있어요)';
      } else if (errorCode === 'SCHEMA_ERROR') {
        userFriendlyMessage = '분석 데이터 구조가 예상과 달라요. 새로고침 후 다시 시도해주세요.';
      } else if (errorCode === 'EMPTY_RESPONSE') {
        userFriendlyMessage = '분석 응답이 비어있어요. 다시 시도해주세요.';
      } else if (errorCode === 'OPENAI_API_ERROR') {
        userFriendlyMessage = '분석 서비스에 일시적인 문제가 있어요. 잠시 후 다시 시도해주세요.';
      }
      
      analysisError = userFriendlyMessage;
      
      // ✅ 보드는 유지하고 에러만 표시 (자동 업데이트는 계속 동작)
      if (onError) onError(userFriendlyMessage);
      return; // 보드 업데이트는 하지 않음
    }
    
    // ✅ 성공 응답 처리: 표준화된 형식 { ok: true, data: { state } } 우선 사용
    let newState = data.data?.state;
    
    // TODO: 하위 호환성 fallback (추후 제거 예정)
    if (!newState) {
      console.warn('[Vivid Chat] Using fallback state extraction (legacy format). TODO: Remove fallback after migration.');
      newState = data.state ?? data.data;
    }
    
    // ✅ 디버깅 로그: state 추출 결과
    console.log('[Vivid Chat] State extracted:', {
      source: data.data?.state ? 'data.data.state' : (data.state ? 'data.state (fallback)' : 'data.data (fallback)'),
      hasState: !!newState,
      hasScenes: !!(newState && Array.isArray(newState.scenes)),
      scenesCount: newState?.scenes?.length || 0,
    });

    if (!newState || !Array.isArray(newState.scenes)) {
      console.error('[Vivid Chat] API response missing state or scenes:', {
        hasState: !!newState,
        hasScenes: !!(newState && Array.isArray(newState.scenes)),
        responseData: data,
      });
      analysisError = 'API response missing state';
      if (onError) onError('분석 결과를 받을 수 없었어요. 다시 시도해주세요.');
      return; // 보드 업데이트는 하지 않음
    }

    // Step3: scenes[] 우선 처리, v1 변환은 보험용으로만
    let storyState = newState;
    
    // scenes가 없으면 v1 형식으로 간주하여 변환 (보험용)
    if (!storyState.scenes || !Array.isArray(storyState.scenes) || storyState.scenes.length === 0) {
      if (storyState.scene && storyState.characters) {
        // v1 → v2 변환: scene + characters + dialogue_impact를 scenes[]로 변환
        storyState = {
          ...storyState,
          scenes: [{
            summary: storyState.scene.summary || '',
            type: storyState.scene.type || 'room',
            location_name: storyState.scene.location_name,
            backdrop_style: storyState.scene.backdrop_style,
            characters: storyState.characters,
            dialogue_impact: storyState.dialogue_impact || 'medium',
          }],
          activeSceneIndex: 0,
        };
        console.log('[Vivid Chat] Converted v1 response to v2 format');
      } else {
        // v1 형식도 아니면 에러
        analysisError = 'Invalid state format: missing scenes and scene';
        throw new Error(analysisError);
      }
    }

    // relations는 빈 배열로 설정 (요구사항)
    storyState = {
      ...storyState,
      relations: [],
    };

    // 전역 상태 갱신
    currentStoryState = storyState;
    currentTurnId = turnId; // Step2: turnId 동기화
    finalStoryState = storyState; // 저장용

    // ✅ 응답 직후 디버깅 로그 (필수)
    const scenesCount = storyState.scenes?.length || 0;
    const activeSceneIndex = storyState.activeSceneIndex ?? (scenesCount > 0 ? scenesCount - 1 : 0);
    const locationNames = storyState.scenes?.slice(0, 5).map(s => s.location_name || s.summary || '(없음)').join(', ') || '';
    
    console.log('[Vivid Chat] New StoryState received from API:', {
      turnId: turnId,
      scenesCount: scenesCount,
      activeSceneIndex: activeSceneIndex,
      locationNames: scenesCount > 5 ? locationNames + '...' : locationNames,
      scenes: storyState.scenes?.map(s => ({
        locationName: s.location_name || '(없음)',
        summary: s.summary?.slice(0, 50) || '(없음)',
        charactersCount: s.characters?.length || 0,
      })) || [],
    });

    // Step4 단계 5: 캐릭터 매칭 처리 (Ghost 생성 및 aliasMap 업데이트)
    let updatedCastStore = null;
    if (finalScenarioKey) {
      const currentCastStore = loadCastStore(finalScenarioKey) || createEmptyCastStore();
      try {
        updatedCastStore = processCharacterMatching(storyState, currentCastStore, finalScenarioKey);
        // 업데이트된 CastStore를 lastSuccessRecord.cast에 저장 (다음 분석 시 castHints로 사용)
      } catch (matchingError) {
        // 매칭 실패해도 전체 분석 흐름은 중단하지 않음
        console.warn('[Vivid Chat] Character matching failed (non-fatal):', matchingError);
      }
    }

    // iframe으로 전달 (중복 체크 포함)
    const sent = postStoryStateToIframe(storyState, finalScenarioKey);
    
    // 디버깅: postStoryStateToIframe 반환값 확인 (DEV_MODE만)
    if (DEV_MODE && sent === 'duplicate') {
      console.log('[Vivid Chat] postStoryStateToIframe: duplicate state');
    }
    
    // Step4 Hotfix: duplicate는 성공(no-op)으로 처리
    if (sent === 'duplicate') {
      console.log('[Vivid Chat] State already posted (duplicate, no-op)');
      // duplicate는 성공으로 처리 (에러 처리하지 않음)
      analysisSucceeded = true;
      if (onSuccess) onSuccess();
      return; // 에러 처리하지 않고 종료
    }
    
    if (!sent) {
      console.warn('[Vivid Chat] Failed to post state to iframe (error)');
      analysisError = 'Failed to post state to iframe';
      throw new Error(analysisError);
    }

    // 성공 플래그 설정
    analysisSucceeded = true;

    // 성공 콜백 호출
    if (onSuccess) onSuccess();
  } catch (err) {
    // 실제 에러는 콘솔에 상세히 로그 (네트워크 오류 등 디버깅용)
    console.error('[Vivid Chat] analyzeText failed:', err);
    console.error('[Vivid Chat] Error details:', {
      message: err.message,
      stack: err.stack,
      name: err.name,
    });
    
    if (!analysisError) {
      analysisError = err.message || 'Network error';
    }
    
    // 사용자에게는 통일된 메시지 표시
    if (onError) onError('최근 턴 분석에 실패했습니다. 잠시 후 다시 시도해주세요.');
  } finally {
    // 커밋3: 성공/실패 저장을 finally에서 확실히 실행
    if (scenarioKey && turnId) {
      if (analysisSucceeded && finalStoryState) {
        // 성공 시 저장 (Step4 단계 5: 업데이트된 CastStore 포함)
        const updatedCastStore = scenarioKey ? (loadCastStore(scenarioKey) || createEmptyCastStore()) : null;
        saveLastSuccessOnAnalysis(scenarioKey, turnId, finalStoryState, updatedCastStore);
      } else if (analysisError) {
        // 실패 시 저장
        saveLastErrorOnFailure(scenarioKey, turnId, analysisError);
      }
    }
  }
}

// Content script로부터 메시지 수신
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;
  
  // ENV_CHANGED 메시지 처리 (Options에서 환경 변경 시)
  if (message.type === 'ENV_CHANGED') {
    console.log('[Vivid Chat] ENV_CHANGED received, reloading sidepanel...');
    // baseUrl 재로드 및 iframe 재설정
    initializeSidepanel().then(() => {
      console.log('[Vivid Chat] Sidepanel reloaded with new baseUrl');
      sendResponse({ success: true });
    });
    return true; // 비동기 응답
  }

  if (message.type === 'TEXT_SELECTED') {
    if (!DEV_MODE) {
      // 사용자 모드에서는 TEXT_SELECTED 무시
      return;
    }

    const preview = (message.text || '').slice(0, 80);
    console.log('[Vivid Chat] TEXT_SELECTED (dev mode):', preview);

    if (analysisMode !== 'selection') {
      // 선택 텍스트 모드가 아닐 때는 무시
      sendResponse({ success: true });
      return;
    }

    if (!message.text || !message.text.trim()) {
      console.warn(
        '[Vivid Chat] TEXT_SELECTED ignored: empty text in selection mode'
      );
      sendResponse({ success: true });
      return;
    }

    analyzeTextAndUpdateBoard({
      source: 'selection',
      provider: currentProvider,
      text: message.text,
      onSuccess: () => showToast('보드가 업데이트되었습니다.'),
      onError: (error) => showToast('업데이트에 실패했습니다. 다시 시도해 주세요.', 'error'),
    });

    sendResponse({ success: true });
    return;
  }

  if (message.type === 'NEW_LAST_AI_TURN') {
    // ✅ 디버깅 로그: 수신 정보
    console.log('[Vivid Chat] NEW_LAST_AI_TURN received in sidepanel:', {
      hasSourceWindowId: !!message.sourceWindowId,
      sourceWindowId: message.sourceWindowId,
      currentWindowId: currentWindowId,
      provider: message.provider,
      scenarioKey: message.scenarioKey,
      currentScenarioKey: currentScenarioKey,
      hasUserText: !!message.userText,
      hasAiText: !!message.aiText,
      messageKeys: Object.keys(message),
    });

    // ✅ 필터 1: sourceWindowId가 없으면 content.js에서 직접 온 1차 메시지이므로 무시
    if (!message.sourceWindowId) {
      console.log('[Vivid Chat] Filtered: missing sourceWindowId (direct from content.js)');
      return;
    }

    const { provider, text, userText, aiText, sourceWindowId, scenarioKey } = message;

    // ✅ 필터 2: provider 필터
    if (provider !== 'rofan-ai') {
      console.log('[Vivid Chat] Filtered: wrong provider', { provider, expected: 'rofan-ai' });
      return;
    }

    // ✅ 필터 3: 자동 업데이트 토글 체크
    if (!autoUpdateEnabled) {
      console.log('[Vivid Chat] Filtered: auto-update disabled');
      return;
    }

    // ✅ 필터 4: 시나리오 변경 감지 및 보드 리셋
    handleScenarioChange(scenarioKey);

    // ✅ 필터 5: 현재 윈도우와 다른 창에서 온 메시지면 무시
    if (currentWindowId && sourceWindowId !== currentWindowId) {
      console.log('[Vivid Chat] Filtered: window mismatch', {
        currentWindowId,
        sourceWindowId,
        reason: 'different_window',
      });
      return;
    }

    // ✅ 필터 통과 로그
    console.log('[Vivid Chat] NEW_LAST_AI_TURN passed all filters, proceeding to analysis');

    // ✅ 5) User+AI 세트를 합쳐서 분석 텍스트 생성
    let combinedText = text; // 하위 호환성: 기존 text 필드 우선
    
    if (userText && aiText) {
      // User+AI 세트가 있으면 합쳐서 전달
      combinedText = [
        userText ? `[USER]\n${userText}` : "",
        aiText ? `[AI]\n${aiText}` : "",
      ].filter(Boolean).join("\n\n");
    } else if (aiText) {
      // AI만 있으면 AI만 사용
      combinedText = `[AI]\n${aiText}`;
    } else if (userText) {
      // User만 있으면 User만 사용 (드문 케이스)
      combinedText = `[USER]\n${userText}`;
    }

    // ✅ 6) 자동업데이트 중복 방지 (2차 가드)
    const analyzeKey = `${scenarioKey}::${combinedText.slice(0, 100)}`;
    if (window.__vividLastAutoAnalyzeKey === analyzeKey) {
      console.log('[Vivid Chat] Skip auto-update: duplicate key');
      return;
    }
    window.__vividLastAutoAnalyzeKey = analyzeKey;

    // 7) 실제 분석 호출
    analyzeTextAndUpdateBoard({
      source: 'auto',
      provider: 'rofan-ai',
      text: combinedText,
      scenarioKey: scenarioKey,
      messageId: null, // messageId가 있다면 여기에 전달
      force: false, // 자동 업데이트는 중복 체크 수행
      onSuccess: () => {
        // 자동 업데이트는 조용히 처리 (토스트 없음)
        console.log('[Vivid Chat] Auto-update: board updated');
      },
      onError: (error) => {
        console.error('[Vivid Chat] Auto-update failed:', error);
        // 자동 업데이트 실패는 조용히 처리 (토스트 없음)
      },
    });

    return;
  }

  if (message.type === 'AUTO_UPDATE_ERROR') {
    const { provider, reason, message: errorMessage } = message;

    console.warn('[Vivid Chat] AUTO_UPDATE_ERROR received:', { provider, reason, errorMessage });

    // 1) provider 필터
    if (provider !== 'rofan-ai') {
      console.log('[Vivid Chat] Ignoring AUTO_UPDATE_ERROR from other provider:', provider);
      return;
    }

    // 2) 자동 업데이트 토글 OFF
    autoUpdateEnabled = false;
    
    // 3) UI에 토글 상태 반영
    const autoUpdateCheckbox = document.getElementById('auto-update-toggle');
    if (autoUpdateCheckbox) {
      autoUpdateCheckbox.checked = false;
    }

    // 4) 에러 메시지 표시
    const displayMessage = errorMessage || "자동 업데이트 연결이 끊어졌어요. 로판AI 탭을 새로고침한 뒤 다시 켜주세요.";
    updateAnalyzeError(displayMessage);
    showToast(displayMessage, 'error');

    console.log('[Vivid Chat] Auto-update disabled due to error:', reason);
    return;
  }

  return true; // 비동기 응답을 위해 true 반환
});

// iframe 로드 완료 확인
if (iframe) {
  iframe.addEventListener('load', () => {
    console.log('[Vivid Chat] Iframe loaded');
    // 커밋5: iframe 로드 완료 후 자동 복원 시도 (마운트 시 복원이 실패했을 수 있음)
    // 단, 이미 복원되었거나 보드가 채워져 있으면 스킵
    if (currentStoryState === null) {
      restoreLastSuccessOnMount().catch(err => {
        console.log('[Vivid Chat] Auto-restore on iframe load skipped:', err.message);
      });
    }
  });
}

// iframe에서 오는 메시지 리스너 (무한 루프 방지)
window.addEventListener('message', (event) => {
  // 디버깅: 필터 이전 raw message 로깅 (DEV_MODE만)
  if (DEV_MODE) {
    console.log('[sidepanel] raw message', {
    origin: event.origin,
    sender: event.data?.sender,
    type: event.data?.type,
      protocol: event.data?.protocol,
      hasData: !!event.data,
      dataKeys: event.data ? Object.keys(event.data) : [],
    });
  }

  // 보안: origin 체크 (baseUrl 기반 정확한 일치 비교)
  // currentBaseUrl이 없으면 동기적으로 기본값 사용 (초기화 전일 수 있음)
  const baseUrl = currentBaseUrl || 'https://rofan.world'; // 기본값: prod
  const allowedOrigin = baseUrl; // http://localhost:3001 또는 https://rofan.world
  
  // www. 서브도메인을 무시하고 비교 (www.rofan.world === rofan.world)
  const normalizeOrigin = (origin) => {
    if (!origin) return origin;
    // www. 서브도메인 제거
    return origin.replace(/^https?:\/\/www\./, (match) => {
      return match.replace('www.', '');
    });
  };
  
  const normalizedReceived = normalizeOrigin(event.origin);
  const normalizedExpected = normalizeOrigin(allowedOrigin);
  
  if (normalizedReceived !== normalizedExpected) {
    console.log('[Vivid Chat] Ignoring message: origin mismatch', {
      received: event.origin,
      expected: allowedOrigin,
      currentBaseUrl: currentBaseUrl,
    });
    return;
  }

  const message = event.data;
  if (!message || typeof message !== 'object') {
    console.log('[Vivid Chat] Ignoring message: invalid data format');
    return;
  }

  // 필터 1: sender가 내 자신이면 무시
  if (message.sender === SENDER_ID) {
    console.log('[Vivid Chat] Ignoring message: sender is myself', SENDER_ID);
    return;
  }

  // 필터 2: sender가 test-board인 경우 CAST_STORE_UPDATE만 허용, 나머지는 무시
  if (message.sender === 'test-board') {
    if (message.type === 'CAST_STORE_UPDATE') {
      // CAST_STORE_UPDATE는 허용 (캐스트 동기화용)
      // 아래에서 처리 계속
    } else {
      console.log('[Vivid Chat] Ignoring message from test-board:', message.type);
    return;
    }
  }

  // 필터 3: STORY_STATE_UPDATE 또는 CAST_STORE_UPDATE 타입만 처리
  if (message.type !== 'STORY_STATE_UPDATE' && message.type !== 'CAST_STORE_UPDATE') {
    console.log('[Vivid Chat] Ignoring message: not STORY_STATE_UPDATE or CAST_STORE_UPDATE', message.type);
    return;
  }
  
  // CAST_STORE_UPDATE 처리 (캐스트 동기화)
  if (message.type === 'CAST_STORE_UPDATE') {
    if (DEV_MODE) {
      console.log('[Vivid Chat] CAST_STORE_UPDATE received:', {
        scenarioKey: message.scenarioKey,
        currentScenarioKey: currentScenarioKey,
        hasCastStore: !!message.castStore,
        castStoreVersion: message.castStore?.version,
        charactersCount: message.castStore?.charactersById ? Object.keys(message.castStore.charactersById).length : 0,
      });
    }
    
    handleCastStoreUpdate(message.scenarioKey, message.castStore);
    return; // 처리 완료
  }
  
  // 아래는 STORY_STATE_UPDATE 처리 (기존 로직)

  // 필터 4: sender가 없으면 무시 (이건 iframe에서 보낸 메시지가 아님)
  if (!message.sender) {
    console.warn(
      '[Vivid Chat] WARNING: STORY_STATE_UPDATE without sender field - this may cause loop!',
      message
    );
    // sender가 없으면 무시 (안전을 위해)
    return;
  }

  // 필터 5: scenarioKey가 현재 시나리오와 다르면 무시
  if (message.scenarioKey && message.scenarioKey !== currentScenarioKey) {
    console.log(
      '[Vivid Chat] Ignoring STORY_STATE_UPDATE: scenarioKey mismatch',
      { received: message.scenarioKey, current: currentScenarioKey }
    );
    return;
  }

  // 필터 6: 중복 state 확인 (같은 state면 무시)
  if (message.state && currentStoryState) {
    const currentStateStr = JSON.stringify(currentStoryState);
    const receivedStateStr = JSON.stringify(message.state);
    if (currentStateStr === receivedStateStr) {
      console.log('[Vivid Chat] Ignoring STORY_STATE_UPDATE: duplicate state');
      return;
    }
  }

  // 여기까지 왔다면 유효한 메시지이지만, sidepanel에서는 다시 analyze를 호출하지 않음
  // 단지 state를 동기화만 함 (이미 iframe에서 처리된 state이므로)
  console.log(
    '[Vivid Chat] Received STORY_STATE_UPDATE from iframe (ignoring to prevent loop)',
    { sender: message.sender, scenarioKey: message.scenarioKey, type: message.type }
  );

  // state 동기화만 수행 (analyze 호출하지 않음)
  if (message.state) {
    currentStoryState = message.state;
  }
});

// 자동 업데이트 토글 초기화
function setupAutoUpdateToggle() {
  const checkbox = document.getElementById('rv-auto-update-toggle');
  if (!checkbox) {
    console.warn('[Vivid Chat] Auto-update toggle checkbox not found');
    return;
  }

  // 초기 값 동기화
  autoUpdateEnabled = checkbox.checked;
  console.log(
    '[Vivid Chat] Auto-update initial state:',
    autoUpdateEnabled
  );

  checkbox.addEventListener('change', () => {
    autoUpdateEnabled = checkbox.checked;
    console.log(
      '[Vivid Chat] Auto-update toggle changed:',
      autoUpdateEnabled
    );
    showToast(
      autoUpdateEnabled
        ? '자동 업데이트가 켜졌습니다. 새 AI 답변이 나오면 보드가 자동으로 갱신됩니다.'
        : '자동 업데이트가 꺼졌습니다. 이제는 "최근 턴 분석하기" 버튼을 눌러 갱신하세요.'
    );
  });
}

// 분석 모드 셀렉터 초기화 (개발자 모드에서만)
function setupAnalysisModeSelector() {
  if (!DEV_MODE) return;

  const modeSelect = document.getElementById('rv-analysis-mode');
  if (!modeSelect) {
    console.warn('[Vivid Chat] Analysis mode select not found');
    return;
  }

  // 초기값
  analysisMode = modeSelect.value || 'last-ai';

  modeSelect.addEventListener('change', () => {
    analysisMode = modeSelect.value || 'last-ai';
    console.log('[Vivid Chat] Analysis mode changed:', analysisMode);
  });
}

// Provider 선택 드롭다운 초기화
function setupProviderSelector() {
  const providerSelect = document.getElementById('provider-select');
  if (providerSelect) {
    providerSelect.addEventListener('change', (e) => {
      currentProvider = e.target.value;
      console.log('[Vivid Chat] Provider changed:', currentProvider);
    });
  }
}

// 개발자 모드 토글 함수
function toggleDevMode() {
  try {
    const current = localStorage.getItem('rv-dev-mode') === 'true';
    localStorage.setItem('rv-dev-mode', (!current).toString());
    console.log('[Vivid Chat] Dev mode toggled:', !current);
    // 페이지 새로고침 안내
    alert(`개발자 모드가 ${!current ? '켜졌습니다' : '꺼졌습니다'}. 사이드패널을 다시 열어주세요.`);
  } catch (e) {
    console.error('[Vivid Chat] Failed to toggle dev mode:', e);
  }
}

// 개발자 도구 초기화
function setupDevTools() {
  const devToolsSection = document.getElementById('dev-tools');
  if (!devToolsSection) {
    console.warn('[Vivid Chat] dev-tools section not found');
    return;
  }

  if (DEV_MODE) {
    console.log('[Vivid Chat] Dev mode enabled - showing dev tools');
    devToolsSection.style.display = 'block';
    devToolsSection.classList.add('visible');

    // 개발자용 텍스트 입력 분석 버튼
    const devAnalyzeBtn = document.getElementById('dev-analyze-btn');
    const devTextInput = document.getElementById('dev-text-input');

    if (devAnalyzeBtn && devTextInput) {
      devAnalyzeBtn.addEventListener('click', async () => {
        const text = devTextInput.value.trim();
        if (!text) {
          showToast('텍스트를 입력해주세요.', 'error');
          return;
        }

        devAnalyzeBtn.disabled = true;
        devAnalyzeBtn.textContent = '분석 중...';

        await analyzeTextAndUpdateBoard({
          source: 'manual',
          provider: currentProvider,
          text: text,
          onSuccess: () => {
            showToast('보드가 업데이트되었습니다.');
            devAnalyzeBtn.disabled = false;
            devAnalyzeBtn.textContent = '분석하기';
          },
          onError: (error) => {
            showToast('업데이트에 실패했습니다. 다시 시도해 주세요.', 'error');
            devAnalyzeBtn.disabled = false;
            devAnalyzeBtn.textContent = '분석하기';
          },
        });
      });
    }

    // 분석 모드 셀렉터 초기화
    setupAnalysisModeSelector();
  } else {
    // DEV_MODE가 false일 때 dev-tools 섹션 확실히 숨기기
    console.log('[Vivid Chat] Dev mode disabled - hiding dev tools');
    devToolsSection.style.display = 'none';
    devToolsSection.style.visibility = 'hidden';
    devToolsSection.classList.remove('visible');
  }
}

// 마지막 AI 메시지 요청 헬퍼 함수
function requestLastAiMessageFromContentScript(provider) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'REQUEST_LAST_AI_MESSAGE',
        provider: provider,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response || !response.success) {
          reject(new Error(response?.reason || 'Unknown error'));
          return;
        }

        if (response.text) {
          resolve({
            text: response.text,
            userText: response.userText, // User+AI 세트 지원
            aiText: response.aiText, // User+AI 세트 지원
            scenarioKey: response.scenarioKey,
          });
        } else {
          reject(new Error('No text in response'));
        }
      }
    );
  });
}

// '최근 턴 분석하기' 버튼 클릭 이벤트 (커밋4: 일반 클릭 vs Shift+Click)
if (analyzeButton) {
  analyzeButton.addEventListener('click', async (event) => {
    const isShiftClick = event.shiftKey;
    console.log('[Vivid Chat] Analyze last turn clicked', {
      provider: currentProvider,
      isShiftClick: isShiftClick,
    });

    // 이미 분석 중이면 무시
    if (isAnalyzingLastTurn) {
      return;
    }

    // 상태 초기화
    isAnalyzingLastTurn = true;
    lastAnalyzeError = null;
    updateAnalyzeError(null);
    setButtonLoading(true);

    try {
      const result = await requestLastAiMessageFromContentScript(currentProvider);
      
      if (!result || !result.text) {
        console.warn('[Vivid Chat] No last AI message text');
        const errorMsg = '최근 턴 분석에 실패했습니다. 잠시 후 다시 시도해주세요.';
        lastAnalyzeError = errorMsg;
        updateAnalyzeError(errorMsg);
        return;
      }

      const { text, userText, aiText, scenarioKey } = result;

      // ✅ User+AI 세트를 합쳐서 분석 텍스트 생성
      let combinedText = text; // 하위 호환성: 기존 text 필드 우선
      
      if (userText && aiText) {
        // User+AI 세트가 있으면 합쳐서 전달
        combinedText = [
          userText ? `[USER]\n${userText}` : "",
          aiText ? `[AI]\n${aiText}` : "",
        ].filter(Boolean).join("\n\n");
      } else if (aiText) {
        // AI만 있으면 AI만 사용
        combinedText = `[AI]\n${aiText}`;
      } else if (userText) {
        // User만 있으면 User만 사용 (드문 케이스)
        combinedText = `[USER]\n${userText}`;
      }

      // 시나리오 변경 감지 및 보드 리셋
      handleScenarioChange(scenarioKey);

      // botContext를 먼저 로드 (수동 분석 시 보장)
      let botContext = null;
      let chatId = null;
      try {
        chatId = await getChatIdFromActiveTab();
        if (chatId) {
          botContext = await getBotContextForChatId(chatId);
          if (!botContext) {
            // 한 번 더 시도
            console.log('[Vivid Chat] botContext not found, retrying...');
            await new Promise(resolve => setTimeout(resolve, 500)); // 500ms 대기
            botContext = await getBotContextForChatId(chatId);
          }
        }
      } catch (e) {
        console.warn('[Vivid Chat] Failed to load botContext before manual analysis:', e);
      }

      if (!botContext) {
        console.warn('[Vivid Chat] botContext is still null after retry, proceeding without bot context', {
          chatId: chatId || 'null',
        });
      } else {
        console.log('[Vivid Chat] botContext loaded before manual analysis', {
          chatId: chatId,
          personaLen: botContext.persona?.length || 0,
          worldviewLen: botContext.worldview?.length || 0,
          userName: botContext.userName || null,
        });
      }

      // ✅ 수동 분석은 항상 force: true (캐시 무시하고 최신 DOM 기반으로 재분석)
      // 커밋4: Shift+Click이면 무조건 강제 재분석, 일반 클릭이면 보드 상태에 따라 복원/분석
      const isBoardEmpty = currentStoryState === null;
      const shouldForce = true; // ✅ 수동 분석은 항상 force: true
      
      if (!isShiftClick && isBoardEmpty) {
        // 일반 클릭 + 보드 비어있음 → 복원 우선 시도 (force: true지만 복원 시도는 허용)
        const lastSuccess = loadLastSuccessRecord(scenarioKey);
        if (lastSuccess && lastSuccess.state && !lastSuccess.lastError) {
          const turnId = calculateTurnId(text, null);
          if (lastSuccess.turnId === turnId) {
            console.log('[Vivid Chat] Board empty, restoring from lastSuccessRecord (manual click)');
            const restored = restoreLastSuccessState(lastSuccess, scenarioKey);
            if (restored) {
              lastAnalyzeError = null;
              updateAnalyzeError(null);
              showToast('보드가 복원되었습니다.');
              return;
            }
          }
        }
        // 복원 실패 시 재분석 진행
      }

      await analyzeTextAndUpdateBoard({
        source: 'last-ai',
        provider: currentProvider,
        text: combinedText, // ✅ User+AI 합본 사용
        scenarioKey: scenarioKey,
        messageId: null, // messageId가 있다면 여기에 전달
        force: shouldForce, // ✅ 수동 분석은 항상 force: true
        onSuccess: () => {
          lastAnalyzeError = null;
          updateAnalyzeError(null);
          showToast(isShiftClick ? '보드가 강제 재분석되었습니다.' : '보드가 업데이트되었습니다.');
        },
        onError: (error) => {
          const errorMsg = error || '최근 턴 분석에 실패했습니다. 잠시 후 다시 시도해주세요.';
          lastAnalyzeError = errorMsg;
          updateAnalyzeError(errorMsg);
        },
      });
    } catch (error) {
      console.error('[Vivid Chat] Error in analyze last turn:', error);
      const errorMsg = '최근 턴 분석에 실패했습니다. 잠시 후 다시 시도해주세요.';
      lastAnalyzeError = errorMsg;
      updateAnalyzeError(errorMsg);
    } finally {
      // 버튼 로딩 상태 종료
      isAnalyzingLastTurn = false;
      setButtonLoading(false);
    }
  });
}

// 보드 초기화 핸들러
function setupResetButton() {
  const resetBtn = document.getElementById('reset-board-btn');
  if (!resetBtn) {
    console.warn('[Vivid Chat] reset-board-btn not found');
    return;
  }

  resetBtn.addEventListener('click', () => {
    console.log('[Vivid Chat] Reset board clicked');
    currentStoryState = null;
    currentTurnId = null; // Step2: turnId 리셋
    // lastAnalyzed = null; // Step2: 제거 (lastSuccessRecord로 대체)
    lastPostedStateHash = null; // 마지막 전송한 state 해시도 리셋
    messageSendCounter = 0; // 메시지 카운터 리셋
    lastPostTime = 0; // 마지막 전송 시간 리셋

    const iframe = document.getElementById('visualboard-frame');
    if (iframe && iframe.contentWindow) {
      // 프로토콜 v1 형식으로 메시지 전송
      iframe.contentWindow.postMessage(
        {
          protocol: PROTOCOL_VERSION,
          sender: SENDER_ID,
          type: 'RESET_STORY_STATE',
          timestamp: Date.now(),
        },
        '*' // 실제 iframe origin (www.rofan.world 또는 rofan.world)과 상관없이 전달
      );
      console.log('[Vivid Chat] RESET_STORY_STATE posted to iframe (reason: user-reset)');
      showToast('보드가 초기화되었습니다.');
    }
  });
}

// 버전 정보 설정 함수
function setupVersionDisplay() {
  try {
    const manifest = chrome.runtime?.getManifest?.();
    const extensionVersion = manifest?.version || '0.0.0';
    const versionEl = document.getElementById('rvb-version-value');
    if (versionEl) {
      versionEl.textContent = `v${extensionVersion}`;
    }
  } catch (err) {
    console.warn('[Vivid Chat] Failed to get extension version:', err);
  }
}

// 초기화 - DOMContentLoaded에서 실행
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', async () => {
    console.log('[Vivid Chat] Side panel DOM loaded');
    await initializeSidepanel(); // baseUrl 로드 및 iframe 설정
    setupVersionDisplay();
    setupProviderSelector();
    setupAutoUpdateToggle();
    setupDevTools();
    setupResetButton();
    
    // 커밋5: sidepanel 마운트 시 1회 자동 복원 (자동업데이트 토글과 무관)
    // iframe 로드 후 복원 (약간의 지연 필요)
    setTimeout(async () => {
      await restoreLastSuccessOnMount();
    }, 500); // iframe 로드 대기
  });
} else {
  // DOM이 이미 로드된 경우
  console.log('[Vivid Chat] Side panel DOM already loaded');
  (async () => {
    await initializeSidepanel(); // baseUrl 로드 및 iframe 설정
  setupVersionDisplay();
  setupProviderSelector();
  setupAutoUpdateToggle();
  setupDevTools();
  setupResetButton();
    
    // 커밋5: sidepanel 마운트 시 1회 자동 복원 (자동업데이트 토글과 무관)
    // iframe 로드 후 복원 (약간의 지연 필요)
    setTimeout(async () => {
      await restoreLastSuccessOnMount();
    }, 500); // iframe 로드 대기
  })();
}
