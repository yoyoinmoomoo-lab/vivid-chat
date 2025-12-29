# Vivid Chat - 빠른 시작 가이드

## 🎯 프로젝트 목적
웹페이지에서 소설 텍스트를 선택하면, Chrome Extension을 통해 Next.js 서버로 전송하여 분석하고 시각화하는 시스템.

## 📂 핵심 파일 위치

### Chrome Extension
- **설정**: `manifest.json`
- **백그라운드**: `service-worker.js`
- **웹페이지 주입**: `content.js`
- **사이드 패널 HTML**: `sidepanel.html`
- **사이드 패널 로직**: `sidepanel.js`

### Next.js 백엔드
- **테스트 페이지**: `rofan-atelier/app/test-board/page.tsx`
- **분석 API**: `rofan-atelier/app/api/analyze-chat/route.ts`
- **시각화 컴포넌트**: `rofan-atelier/app/components/visualboard/VisualBoard.tsx`

## 🔄 현재 데이터 흐름

```
웹페이지 텍스트 선택
  ↓
content.js (감지)
  ↓
chrome.runtime.sendMessage
  ↓
sidepanel.js (수신)
  ↓
iframe.postMessage → Next.js
  ↓
test-board/page.tsx (수신 및 표시)
```

## 🚀 실행 방법

1. **Next.js 서버 시작**
   ```bash
   cd /Users/sunhapark/프로젝트/rofan-atelier
   npm run dev
   ```

2. **Chrome Extension 로드**
   - `chrome://extensions/` 접속
   - 개발자 모드 ON
   - "압축해제된 확장 프로그램을 로드합니다"
   - `/Users/sunhapark/프로젝트/Vivid Chat/` 선택

3. **테스트**
   - Extension 아이콘 클릭 → 사이드 패널 열림
   - "Next.js로 전송" 버튼 클릭 → 테스트 데이터 전송
   - `http://localhost:3001/test-board`에서 메시지 확인

## 📡 메시지 형식

### Extension → Next.js
```javascript
{
  type: 'STORY_DATA',
  payload: {
    speaker: '남주',
    text: '그게 무슨 소리야?',
    mood: 'angry'
  }
}
```

### Content Script → Side Panel
```javascript
{
  type: 'TEXT_SELECTED',
  text: '선택된 텍스트...'
}
```

## ⚠️ 현재 상태

✅ **완료된 것**
- Extension 기본 구조
- 사이드 패널 통신
- Next.js 메시지 수신 및 UI 표시

🚧 **미완료**
- 실제 텍스트 분석 연동
- TEXT_SELECTED → STORY_DATA 변환
- VisualBoard 컴포넌트 연동
- 여러 대화 히스토리 관리

## 🔧 다음 작업 제안

1. **텍스트 파싱**: 선택된 텍스트를 `STORY_DATA` 형식으로 변환
2. **API 연동**: `/api/analyze-chat` 호출하여 실제 분석 수행
3. **시각화**: 분석 결과를 `VisualBoard` 컴포넌트로 전달

## 📝 주요 코드 위치

- **텍스트 선택 감지**: `content.js` (line 6-27)
- **메시지 전송**: `sidepanel.js` (line 39-65)
- **메시지 수신**: `rofan-atelier/app/test-board/page.tsx` (line 18-37)
- **UI 표시**: `rofan-atelier/app/test-board/page.tsx` (line 108-127)


