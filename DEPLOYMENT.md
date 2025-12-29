# 배포 가이드

## Vivid Chat v0.2.1 배포

### 주요 변경사항
- Content script 자동 주입 기능 추가
- "scripting" 권한 추가 (동적 content script 주입용)
- 첫 턴 분석 실패 문제 해결

### 배포 단계

1. **프로덕션 빌드 생성**
   ```bash
   node scripts/buildZip.mjs
   ```
   또는
   ```bash
   ./scripts/package-prod.sh
   ```

2. **확인사항**
   - `manifest.json` 버전: 0.2.1
   - `VERSION.md` 버전: 0.2.1
   - `CHANGELOG.md` 업데이트 확인

3. **배포**
   - 생성된 zip 파일을 Chrome Web Store에 업로드
   - 또는 GitHub Release에 첨부

4. **버전 태그 생성**
   ```bash
   git tag v0.2.1
   git push origin v0.2.1
   ```

5. **GitHub Release 생성**
   - 태그: v0.2.1
   - 제목: Vivid Chat v0.2.1
   - 설명: Content script 자동 주입 및 첫 턴 분석 문제 해결

### 사용자 업데이트 안내
- Chrome Extension을 다시 로드해야 합니다
- `chrome://extensions/`에서 Extension 새로고침

