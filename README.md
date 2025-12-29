# Vivid Chat Chrome Extension

소설 텍스트를 분석하여 시각화해주는 Chrome Extension입니다.

**Current Version: v0.0.1**

Compatible with rofan.world v1.2.1+

## 설치 방법

1. Chrome 브라우저에서 `chrome://extensions/` 접속
2. 우측 상단의 "개발자 모드" 활성화
3. "압축해제된 확장 프로그램을 로드합니다" 클릭
4. 이 프로젝트 폴더 선택

## 사용 방법

1. 브라우저 툴바의 확장 프로그램 아이콘 클릭
2. 사이드 패널이 열리며 `http://localhost:3001/test-board` 페이지가 iframe으로 표시됩니다

## 주의사항

- 백엔드 서버(`http://localhost:3001/test-board`)가 실행 중이어야 합니다.
- 아이콘을 추가하려면 `icons` 폴더에 16x16, 48x48, 128x128 크기의 PNG 파일을 추가하고 `manifest.json`의 `icons` 섹션을 활성화하세요.

## Versioning

이 익스텐션은 `manifest.json`의 `version` 필드를 기준으로 SemVer(주.부.수) 방식으로 버전을 관리합니다.

- **패치 버전 올리기** (버그 수정 등)
  ```bash
  npm run version:patch
  ```

- **마이너 버전 올리기** (기능 추가, 호환성 유지)
  ```bash
  npm run version:minor
  ```

- **메이저 버전 올리기** (호환성 깨지는 변경)
  ```bash
  npm run version:major
  ```

명령을 실행하면:
- `manifest.json`의 `version`이 업데이트되고
- `VERSION.md`에 현재 버전이 기록됩니다.

이후 크롬 확장 프로그램을 다시 로드하고, 필요하다면 이 버전에 맞는 zip 파일을 만들어 공유하면 됩니다.

**참고**: 버전을 올릴 때는 `CHANGELOG.md`에 변경 사항을 수동으로 기록해주세요.

