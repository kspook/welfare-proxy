/**
 * 배리어프리 복지 데모 - 백엔드 프록시 서버
 * ------------------------------------------------
 * 역할: data.go.kr 인증키를 서버에만 보관하고,
 *       홈페이지(프론트엔드)는 이 서버에만 요청을 보낸다.
 *       => 브라우저 소스에 키가 노출되지 않고, CORS 문제도 여기서 흡수한다.
 *
 * 실행:
 *   1) npm install
 *   2) .env.example을 .env로 복사하고 실제 인증키 입력
 *   3) node server.js
 *   4) http://localhost:3001/welfare_demo.html 접속해서 테스트
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
});

const app = express();
const PORT = process.env.PORT || 3001;

// 중앙부처/지자체는 Base URL(서비스 그룹)이 다를 수 있어 분리해서 관리한다.
const BASE_URL_CENTRAL =
  process.env.WELFARE_BASE_URL_CENTRAL ||
  "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001"; // ✅ 확인됨
const BASE_URL_LOCAL =
  process.env.WELFARE_BASE_URL_LOCAL ||
  "https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations"; // ✅ 확인됨

// ⚠️ 아래 경로는 마이페이지 > 활용신청현황 상세 화면의 '요청주소' 탭에서
//    확인한 실제 오퍼레이션 경로로 반드시 교체해야 합니다.
const OPERATIONS = {
  central: {
    list: process.env.WELFARE_CENTRAL_LIST_PATH || "/NationalWelfarelistV001", // ✅ 확인됨
    detail: process.env.WELFARE_CENTRAL_DETAIL_PATH || "/NationalWelfaredetailedV001", // ✅ 확인됨
  },
  local: {
    list: process.env.WELFARE_LOCAL_LIST_PATH || "/LcgvWelfarelist", // ✅ 확인됨
    detail: process.env.WELFARE_LOCAL_DETAIL_PATH || "/LcgvWelfaredetailed", // ✅ 확인됨
  },
};

// data.go.kr 마이페이지에서 Encoding 키만 보이는 경우가 있다.
// URLSearchParams가 어차피 다시 인코딩하므로, 여기서 먼저 디코딩해두면
// Encoding 키를 넣든 Decoding 키를 넣든 결과가 같아진다(이중 인코딩 방지).
function normalizeServiceKey(key) {
  if (!key) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    // 이미 디코딩된 값이라 %XX 형태가 아니면 여기로 오는데, 그대로 쓰면 된다.
    return key;
  }
}

const SERVICE_KEY = normalizeServiceKey(process.env.WELFARE_SERVICE_KEY_CENTRAL || "");
const SERVICE_KEY_LOCAL = normalizeServiceKey(
  process.env.WELFARE_SERVICE_KEY_LOCAL || SERVICE_KEY
);

if (!SERVICE_KEY) {
  console.warn(
    "[경고] WELFARE_SERVICE_KEY_CENTRAL이 설정되지 않았습니다. .env 파일을 확인하세요."
  );
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/**
 * 프론트엔드는 이 엔드포인트만 호출한다: /api/welfare/list?scope=central&pageNo=1&numOfRows=10
 * 서버가 실제 data.go.kr 요청을 대신 만들어서 보내고, 결과만 돌려준다.
 */
app.get("/api/welfare/list", async (req, res) => {
  try {
    const scope = req.query.scope === "local" ? "local" : "central";
    const key = scope === "local" ? SERVICE_KEY_LOCAL : SERVICE_KEY;
    const base = scope === "local" ? BASE_URL_LOCAL : BASE_URL_CENTRAL;
    const opPath = OPERATIONS[scope].list;

    const url = new URL(base + opPath);
    url.searchParams.set("serviceKey", key); // Decoding 키 그대로 (URLSearchParams가 인코딩 처리)
    url.searchParams.set("callTp", "L"); // 목록조회
    url.searchParams.set("pageNo", req.query.pageNo || "1");
    url.searchParams.set("numOfRows", req.query.numOfRows || "10");
    url.searchParams.set("srchKeyCode", req.query.srchKeyCode || "001"); // ⚠️ 필수! (001=제목,002=내용,003=제목+내용) - 공식 가이드로 확인됨

    // ✅ 선택 조건 조회용 - 공식 가이드의 선택(옵션) 파라미터. 없으면 그냥 안 보낸다(=전체 조회).
    if (req.query.lifeArray) url.searchParams.set("lifeArray", req.query.lifeArray);
    if (req.query.trgterIndvdlArray) url.searchParams.set("trgterIndvdlArray", req.query.trgterIndvdlArray);
    if (req.query.intrsThemaArray) url.searchParams.set("intrsThemaArray", req.query.intrsThemaArray);

    const upstream = await fetch(url.toString());
    const text = await upstream.text();

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        status: upstream.status,
        message: "상위 API가 오류를 반환했습니다.",
        raw: text.slice(0, 2000),
      });
    }

    // XML 응답을 서버에서 JSON으로 변환해 앱에는 깔끔한 JSON만 전달한다.
    let json;
    try {
      json = xmlParser.parse(text);
    } catch (e) {
      // 혹시 이미 JSON으로 응답한 경우를 대비한 폴백
      try {
        json = JSON.parse(text);
      } catch {
        return res.status(502).json({ ok: false, message: "응답 파싱 실패", raw: text.slice(0, 1000) });
      }
    }

    res.json(json);
  } catch (err) {
    res.status(502).json({
      ok: false,
      message: "프록시 서버에서 상위 API 호출에 실패했습니다.",
      error: String(err),
    });
  }
});

app.get("/api/welfare/detail", async (req, res) => {
  try {
    const scope = req.query.scope === "local" ? "local" : "central";
    const key = scope === "local" ? SERVICE_KEY_LOCAL : SERVICE_KEY;
    const base = scope === "local" ? BASE_URL_LOCAL : BASE_URL_CENTRAL;
    const opPath = OPERATIONS[scope].detail;
    const servId = req.query.servId || req.query.wlfareInfoId;

    if (!servId) {
      return res.status(400).json({ ok: false, message: "servId 파라미터가 필요합니다." });
    }

    const url = new URL(base + opPath);
    url.searchParams.set("serviceKey", key);
    url.searchParams.set("callTp", "D"); // 상세조회 구분값 (목록의 'L'과 대응)
    url.searchParams.set("servId", servId); // ✅ 공식 가이드 문서로 확정됨

    const upstream = await fetch(url.toString());
    const text = await upstream.text();

    let json;
    try {
      json = xmlParser.parse(text);
    } catch {
      try {
        json = JSON.parse(text);
      } catch {
        return res.status(502).json({ ok: false, message: "응답 파싱 실패", raw: text.slice(0, 1000) });
      }
    }
    res.json(json);
  } catch (err) {
    res.status(502).json({ ok: false, message: "프록시 호출 실패", error: String(err) });
  }
});

// 한국주택금융공사 전세자금대출 금리 정보 (data.go.kr, 기관코드 B551408) - 개인 대출이 아니라
// 은행별 공개 금리 비교 데이터라 마이데이터 라이선스 문제 없이 바로 쓸 수 있다.
const HF_BASE_URL = process.env.HF_BASE_URL || "https://apis.data.go.kr/B551408/rent-loan-rate-info";
const HF_RATE_LIST_PATH = process.env.HF_RATE_LIST_PATH || "/rate-list";
const HF_SERVICE_KEY = normalizeServiceKey(process.env.HF_SERVICE_KEY || SERVICE_KEY);

// data.go.kr 게이트웨이는 에러가 나도 HTTP 200으로 응답하면서 본문에만 에러를 담는 경우가
// 있어서(OpenAPI_ServiceResponse/cmmMsgHeader 형태), status만으로는 실패를 못 잡는다.
// 한국주택금융공사 API가 간헐적으로 이런 응답을 주는 것이 확인되어, 짧게 재시도한다.
async function fetchWithRetry(url, maxRetries = 2, delayMs = 700) {
  let lastText = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const upstream = await fetch(url);
    const text = await upstream.text();
    lastText = text;
    const looksLikeGatewayError = text.includes("OpenAPI_ServiceResponse");
    if (upstream.ok && !looksLikeGatewayError) {
      return { ok: true, text };
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { ok: false, text: lastText };
}

app.get("/api/finance/jeonse-rate", async (req, res) => {
  try {
    const url = new URL(HF_BASE_URL + HF_RATE_LIST_PATH);
    url.searchParams.set("serviceKey", HF_SERVICE_KEY);
    url.searchParams.set("pageNo", req.query.pageNo || "1");
    url.searchParams.set("numOfRows", req.query.numOfRows || "20");
    // ⚠️ dataType=JSON을 보내면 게이트웨이가 HTTP_ERROR(04)를 반환하는 것으로 확인되어 제거함.
    //    파라미터 없이 요청하면 기본 XML로 응답이 오고, 아래에서 JSON 우선 시도 후 XML로 폴백해서 처리한다.

    const { ok, text } = await fetchWithRetry(url.toString());

    if (!ok) {
      return res.status(502).json({
        ok: false,
        message: "한국주택금융공사 API가 계속 오류를 반환하고 있습니다. 상대 기관 서버의 일시적 장애로 보이며, 잠시 후 다시 시도해 주세요.",
        raw: text.slice(0, 2000),
      });
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      try {
        json = xmlParser.parse(text);
      } catch {
        return res.status(502).json({ ok: false, message: "응답 파싱 실패", raw: text.slice(0, 1000) });
      }
    }
    res.json(json);
  } catch (err) {
    res.status(502).json({ ok: false, message: "프록시 서버에서 상위 API 호출에 실패했습니다.", error: String(err) });
  }
});

// 금융위원회_서민금융상품기본정보 (data.go.kr, 기관코드 1160100) - 상품 단위(금리/한도/대상/신청방법/문의처)
const FIN_PRODUCT_BASE_URL =
  process.env.FIN_PRODUCT_BASE_URL || "https://apis.data.go.kr/1160100/service/GetSmallLoanFinanceInstituteInfoService";
const FIN_PRODUCT_OP_PATH = process.env.FIN_PRODUCT_OP_PATH || "/getOrdinaryFinanceInfo";
const FIN_PRODUCT_SERVICE_KEY = normalizeServiceKey(process.env.FIN_PRODUCT_SERVICE_KEY || SERVICE_KEY);

app.get("/api/finance/loan-products", async (req, res) => {
  try {
    const url = new URL(FIN_PRODUCT_BASE_URL + FIN_PRODUCT_OP_PATH);
    url.searchParams.set("serviceKey", FIN_PRODUCT_SERVICE_KEY);
    url.searchParams.set("pageNo", req.query.pageNo || "1");
    url.searchParams.set("numOfRows", req.query.numOfRows || "20");
    // 선택 필터 - 공식 가이드에 있는 파라미터만 있을 때만 전달 (기본은 전체 조회)
    ["likeUsge", "likeTrgt", "irtCtg", "prdCtg", "likeFinPrdNm", "likeHdlInst", "prdExisYn"].forEach((k) => {
      if (req.query[k]) url.searchParams.set(k, req.query[k]);
    });

    const { ok, text } = await fetchWithRetry(url.toString());
    if (!ok) {
      return res.status(502).json({
        ok: false,
        message: "서민금융상품 API가 계속 오류를 반환하고 있습니다. 잠시 후 다시 시도해 주세요.",
        raw: text.slice(0, 2000),
      });
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      try {
        json = xmlParser.parse(text);
      } catch {
        return res.status(502).json({ ok: false, message: "응답 파싱 실패", raw: text.slice(0, 1000) });
      }
    }
    res.json(json);
  } catch (err) {
    res.status(502).json({ ok: false, message: "프록시 서버에서 상위 API 호출에 실패했습니다.", error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[welfare-proxy] http://localhost:${PORT} 에서 실행 중`);
  console.log(`[welfare-proxy] 데모 페이지: http://localhost:${PORT}/welfare_demo.html`);
});
