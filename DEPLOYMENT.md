# 배포 가이드

## Vivid Chat v0.0.1 배포

### 주요 변경사항
- Rebranded from "Rofan Visualboard" to "Vivid Chat"
- Initial release version reset to 0.0.1

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
   - `manifest.json` 버전: 0.0.1
   - `VERSION.md` 버전: 0.0.1
   - `CHANGELOG.md` 업데이트 확인

3. **배포**
   - 생성된 zip 파일을 Chrome Web Store에 업로드
   - 또는 GitHub Release에 첨부

4. **버전 태그 생성**
   ```bash
   git tag v0.0.1
   git push origin v0.0.1
   ```

5. **GitHub Release 생성**
   - 태그: v0.0.1
   - 제목: Vivid Chat v0.0.1
   - 설명: Initial release - Rebranded from Rofan Visualboard

### 사용자 업데이트 안내
- Chrome Extension을 다시 로드해야 합니다
- `chrome://extensions/`에서 Extension 새로고침

