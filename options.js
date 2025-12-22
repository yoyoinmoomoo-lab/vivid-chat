// Options Page 로직

console.log('[Rofan Visualboard] Options page loaded');

// 현재 값 로딩
chrome.storage.local.get(['server_env'], (result) => {
  const env = result.server_env || 'prod'; // 기본값: prod
  const radio = document.querySelector(`input[name="server_env"][value="${env}"]`);
  if (radio) {
    radio.checked = true;
  }
  console.log('[Rofan Visualboard] Current server_env:', env);
});

// Save 버튼 클릭
document.getElementById('save-btn').addEventListener('click', () => {
  const selected = document.querySelector('input[name="server_env"]:checked');
  if (!selected) {
    showMessage('환경을 선택해주세요.', 'error');
    return;
  }
  
  const env = selected.value;
  
  // 저장
  chrome.storage.local.set({ server_env: env }, () => {
    if (chrome.runtime.lastError) {
      showMessage('저장에 실패했습니다: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    
    console.log('[Rofan Visualboard] server_env saved:', env);
    
    // 성공 메시지 표시
    showMessage('저장되었습니다. 사이드패널을 다시 열면 적용됩니다.', 'success');
    
    // sidepanel에 변경 알림 (열려 있으면 자동 반영)
    chrome.runtime.sendMessage(
      { type: 'ENV_CHANGED', server_env: env },
      (response) => {
        if (chrome.runtime.lastError) {
          // sidepanel이 열려 있지 않으면 에러는 무시
          console.log('[Rofan Visualboard] ENV_CHANGED message sent (sidepanel may not be open)');
        } else {
          console.log('[Rofan Visualboard] ENV_CHANGED message sent, sidepanel will reload');
        }
      }
    );
  });
});

// 메시지 표시 함수
function showMessage(text, type) {
  const messageEl = document.getElementById('message');
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  
  // 3초 후 자동 숨김 (success/info만)
  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      messageEl.className = 'message';
    }, 3000);
  }
}

