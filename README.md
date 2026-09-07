# 배리어프리 복지 데모 - 백엔드 프록시

인증키를 서버(.env)에만 두고, 홈페이지(public/welfare_demo.html)는 이 서버에만 요청합니다.

## 실행 방법

```bash
npm install
cp .env.example .env
# .env 파일을 열어 아래 값을 채워넣으세요
#   WELFARE_SERVICE_KEY_CENTRAL = 마이페이지에서 발급받은 인증키(Decoding)
#   WELFARE_LIST_PATH           = 마이페이지 '요청주소' 탭에서 확인한 실제 경로

node server.js
```

브라우저에서 http://localhost:3001/welfare_demo.html 접속 후 "실시간 조회 실행" 버튼을 눌러보세요.

## 아직 확정 안 된 부분

`server.js` 상단 `OPERATIONS` 객체의 `list`/`detail` 경로는 예시값입니다.
data.go.kr 마이페이지 > 활용신청현황 상세 화면의 '요청주소' 탭에 나온 실제 경로로
`.env`의 `WELFARE_LIST_PATH`, `WELFARE_DETAIL_PATH`를 바꿔주세요.

## 실서비스로 갈 때

- 이 서버를 Vercel/Cloudflare Workers/자체 서버 등에 올리고, 홈페이지 도메인에서 이 서버의 `/api/welfare/...`만 호출하도록 프론트를 배포하면 됩니다.
- `.env` 파일은 절대 깃허브에 커밋하지 마세요 (`.gitignore`에 추가 권장).
