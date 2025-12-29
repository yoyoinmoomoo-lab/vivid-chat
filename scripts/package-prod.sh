#!/bin/bash

# Production zip 생성 스크립트
# Web Store 제출용 패키징 (localhost 권한 검증 포함)

set -e  # 에러 발생 시 즉시 종료

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_FILE="$PROJECT_ROOT/manifest.json"
OUTPUT_DIR="$PROJECT_ROOT/dist"
ZIP_NAME="vivid-chat-prod.zip"

echo "🔍 Production 패키징 시작..."

# 1. manifest.json 존재 확인
if [ ! -f "$MANIFEST_FILE" ]; then
  echo "❌ ERROR: manifest.json을 찾을 수 없습니다."
  exit 1
fi

# 2. manifest.json에 localhost 문자열 체크
if grep -q "localhost" "$MANIFEST_FILE"; then
  echo "❌ ERROR: manifest.json에 'localhost' 문자열이 포함되어 있습니다."
  echo "   Production 제출본에는 localhost 권한이 포함되면 안 됩니다."
  exit 1
fi

# 3. host_permissions에 http://localhost 체크
if grep -q '"http://localhost' "$MANIFEST_FILE"; then
  echo "❌ ERROR: manifest.json의 host_permissions에 'http://localhost'가 포함되어 있습니다."
  echo "   Production 제출본에는 localhost 권한이 포함되면 안 됩니다."
  exit 1
fi

# 4. manifest.dev.json이 zip에 포함되지 않도록 확인 (나중에 zip 생성 시 체크)
echo "✅ manifest.json 검증 완료 (localhost 권한 없음)"

# 5. dist 디렉토리 생성
mkdir -p "$OUTPUT_DIR"

# 6. 임시 디렉토리에 파일 복사 (manifest.dev.json 제외)
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "📦 파일 복사 중..."
cd "$PROJECT_ROOT"

# 필요한 파일들만 복사
cp manifest.json "$TEMP_DIR/"
cp sidepanel.html "$TEMP_DIR/"
cp sidepanel.js "$TEMP_DIR/"
cp content.js "$TEMP_DIR/"
cp service-worker.js "$TEMP_DIR/"

# options.html, options.js가 있으면 복사
[ -f "options.html" ] && cp options.html "$TEMP_DIR/"
[ -f "options.js" ] && cp options.js "$TEMP_DIR/"

# manifest.dev.json은 복사하지 않음 (의도적으로 제외)

# 7. zip 생성
echo "📦 zip 파일 생성 중..."
cd "$TEMP_DIR"
zip -r "$OUTPUT_DIR/$ZIP_NAME" . > /dev/null

# 8. zip에 manifest.dev.json이 포함되어 있는지 최종 체크
if unzip -l "$OUTPUT_DIR/$ZIP_NAME" | grep -q "manifest.dev.json"; then
  echo "❌ ERROR: 생성된 zip 파일에 manifest.dev.json이 포함되어 있습니다."
  echo "   Production 제출본에는 manifest.dev.json이 포함되면 안 됩니다."
  exit 1
fi

echo "✅ Production zip 생성 완료: $OUTPUT_DIR/$ZIP_NAME"
echo "📋 파일 크기: $(du -h "$OUTPUT_DIR/$ZIP_NAME" | cut -f1)"
echo ""
echo "🎉 Web Store 제출 준비 완료!"

