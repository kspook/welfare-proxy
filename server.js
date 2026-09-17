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

// ⚠️ 이 모듈이 설치 안 됐거나 문제가 있어도 서버 전체(복지/금융 조회 등)가
//    죽지 않도록 방어적으로 로드한다. 실패하면 AI 질의응답 기능만 비활성화된다.
let Anthropic = null;
let anthropicLoadError = null;
try {
  Anthropic = require("@anthropic-ai/sdk");
} catch (err) {
  anthropicLoadError = err;
  console.error("⚠️ @anthropic-ai/sdk 로드 실패 - AI 질의응답 기능이 비활성화됩니다:", err.message);
}

const anthropic =
  Anthropic && process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

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
    if (req.query.searchWrd) url.searchParams.set("searchWrd", req.query.searchWrd); // 자유 검색어 (예: "문화누리카드")

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

// 한국주택금융공사_디딤돌대출금리정보, 적격대출(보금자리론)금리 정보
const DIDIMDOL_BASE_URL = process.env.DIDIMDOL_BASE_URL || "https://apis.data.go.kr/B551408/didimdol-loan-rate";
const DIDIMDOL_OP_PATH = process.env.DIDIMDOL_OP_PATH || "/didimdol-info";
const CONFORMING_BASE_URL = process.env.CONFORMING_BASE_URL || "https://apis.data.go.kr/B551408/conforming-loan-rate";
const CONFORMING_OP_PATH = process.env.CONFORMING_OP_PATH || "/conforming-list";
// 이 두 API도 B551408(한국주택금융공사) 소속이라 같은 인증키를 쓰되, data.go.kr에서
// 데이터셋별로 별도 활용신청이 필요하다.
const HF_LOAN_SERVICE_KEY = normalizeServiceKey(process.env.HF_LOAN_SERVICE_KEY || HF_SERVICE_KEY);

async function proxyHfRateApi(baseUrl, opPath, req, res) {
  try {
    const url = new URL(baseUrl + opPath);
    url.searchParams.set("serviceKey", HF_LOAN_SERVICE_KEY);
    url.searchParams.set("pageNo", req.query.pageNo || "1");
    url.searchParams.set("numOfRows", req.query.numOfRows || "20");

    const { ok, text } = await fetchWithRetry(url.toString());
    if (!ok) {
      return res.status(502).json({
        ok: false,
        message: "한국주택금융공사 API가 계속 오류를 반환하고 있습니다. 잠시 후 다시 시도해 주세요.",
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
}

app.get("/api/finance/didimdol-rate", (req, res) => proxyHfRateApi(DIDIMDOL_BASE_URL, DIDIMDOL_OP_PATH, req, res));
app.get("/api/finance/conforming-rate", (req, res) => proxyHfRateApi(CONFORMING_BASE_URL, CONFORMING_OP_PATH, req, res));

// 한국주택금융공사_전세자금보증상품 추천서비스 (고객특성별 추천/월별금리/상세정보/지역별한도)
const JEONSE_RCMD_BASE_URL = process.env.JEONSE_RCMD_BASE_URL || "https://apis.data.go.kr/B551408/jnse-rcmd-info-v2";
const JEONSE_RCMD_SERVICE_KEY = normalizeServiceKey(process.env.JEONSE_RCMD_SERVICE_KEY || HF_SERVICE_KEY);

async function proxyJeonseRcmdApi(opPath, extraParams, req, res) {
  try {
    const url = new URL(JEONSE_RCMD_BASE_URL + opPath);
    url.searchParams.set("serviceKey", JEONSE_RCMD_SERVICE_KEY);
    url.searchParams.set("dataType", "json"); // 공식 가이드에서 JSON 직접 지원 확인됨 (다른 API와 다르게 정상 동작)
    Object.entries(extraParams).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    });

    const { ok, text } = await fetchWithRetry(url.toString());
    if (!ok) {
      return res.status(502).json({
        ok: false,
        message: "전세자금보증상품 추천 API가 계속 오류를 반환하고 있습니다. 잠시 후 다시 시도해 주세요.",
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
}

// 1) 고객 특성별 전세자금보증상품 추천
app.get("/api/finance/jeonse-recommend", (req, res) => {
  const { rentGrntAmt, mmrtAmt, trgtLwdgCd, age, weddStcd, myIncmAmt, myTotDebtAmt, ownHsCnt, grntPrmeActnDvcdCont, numOfRows, pageNo } = req.query;
  proxyJeonseRcmdApi(
    "/jnse-rcmd-list-v2",
    { rentGrntAmt, mmrtAmt, trgtLwdgCd, age, weddStcd, myIncmAmt, myTotDebtAmt, ownHsCnt, grntPrmeActnDvcdCont, numOfRows: numOfRows || "20", pageNo: pageNo || "1" },
    req,
    res
  );
});

// 2) 전세자금보증상품 월별 평균금리 조회
app.get("/api/finance/jeonse-avg-rate", (req, res) => {
  proxyJeonseRcmdApi("/jnse-grtd-loan-rat-list-v2", { loanYm: req.query.loanYm }, req, res);
});

// 3) 전세자금보증상품 상세정보 조회
app.get("/api/finance/jeonse-product-detail", (req, res) => {
  proxyJeonseRcmdApi("/jnse-prod-dtl-info-v2", { grntDvcd: req.query.grntDvcd }, req, res);
});

// 4) 전세자금보증상품 지역별 최대임차보증금액 조회
app.get("/api/finance/jeonse-max-rent", (req, res) => {
  proxyJeonseRcmdApi("/jnse-max-rent-amt-list-v2", { grntDvcd: req.query.grntDvcd }, req, res);
});

// 전세자금대출 고객 특성별 금리 정보 (일 1회 갱신)
const JEONSE_DIM_BASE_URL = process.env.JEONSE_DIM_BASE_URL || "https://apis.data.go.kr/B551408/rent-loan-rate-multi-dimensional-info";
const JEONSE_DIM_SERVICE_KEY = normalizeServiceKey(process.env.JEONSE_DIM_SERVICE_KEY || HF_SERVICE_KEY);

app.get("/api/finance/jeonse-dim-rate", async (req, res) => {
  try {
    const url = new URL(JEONSE_DIM_BASE_URL + "/dimensional-list");
    url.searchParams.set("serviceKey", JEONSE_DIM_SERVICE_KEY);
    url.searchParams.set("numOfRows", req.query.numOfRows || "20");
    url.searchParams.set("pageNo", req.query.pageNo || "1");
    url.searchParams.set("loanYm", req.query.loanYm || "L3M");
    ["cbGrd", "jobCd", "houseTycd", "age", "income", "debt"].forEach((k) => {
      if (req.query[k]) url.searchParams.set(k, req.query[k]);
    });

    const { ok, text } = await fetchWithRetry(url.toString());
    if (!ok) {
      return res.status(502).json({
        ok: false,
        message: "전세자금대출 고객특성별 금리 API가 계속 오류를 반환하고 있습니다. 잠시 후 다시 시도해 주세요.",
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

// =====================================================================
// 자연어 질의응답 에이전트 (Claude API + Tool Use)
// ---------------------------------------------------------------------
// 핵심 원칙: Claude는 절대 숫자/사실을 지어내면 안 되고, 반드시 아래 도구로
// 실제 API를 호출해서 받은 결과만 근거로 답해야 한다. 도구는 원본 JSON을
// 그대로 돌려주고(가공 최소화), Claude가 그 안에서 필요한 내용을 골라 요약한다.
// =====================================================================

async function fetchJsonOrXml(urlString) {
  const { ok, text } = await fetchWithRetry(urlString);
  if (!ok) return { error: "상위 기관 API 호출에 실패했습니다.", raw: text.slice(0, 500) };
  try {
    return JSON.parse(text);
  } catch {
    try {
      return xmlParser.parse(text);
    } catch {
      return { error: "응답 파싱 실패", raw: text.slice(0, 500) };
    }
  }
}

async function toolSearchWelfare({ keyword, lifeArray, trgterIndvdlArray, scope }) {
  const scopes = scope === "central" || scope === "local" ? [scope] : ["central", "local"];
  const out = {};
  for (const s of scopes) {
    const base = s === "central" ? BASE_URL_CENTRAL : BASE_URL_LOCAL;
    const opPath = s === "central" ? OPERATIONS.central.list : OPERATIONS.local.list;
    const key = s === "central" ? SERVICE_KEY : SERVICE_KEY_LOCAL;
    const url = new URL(base + opPath);
    url.searchParams.set("serviceKey", key);
    url.searchParams.set("callTp", "L");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("numOfRows", "10");
    url.searchParams.set("srchKeyCode", "001");
    if (keyword) url.searchParams.set("searchWrd", keyword);
    if (lifeArray) url.searchParams.set("lifeArray", lifeArray);
    if (trgterIndvdlArray) url.searchParams.set("trgterIndvdlArray", trgterIndvdlArray);
    out[s] = await fetchJsonOrXml(url.toString());
  }
  return out;
}

async function toolGetWelfareDetail({ servId, scope }) {
  const base = scope === "local" ? BASE_URL_LOCAL : BASE_URL_CENTRAL;
  const opPath = scope === "local" ? OPERATIONS.local.detail : OPERATIONS.central.detail;
  const key = scope === "local" ? SERVICE_KEY_LOCAL : SERVICE_KEY;
  const url = new URL(base + opPath);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("callTp", "D");
  url.searchParams.set("servId", servId);
  return fetchJsonOrXml(url.toString());
}

async function toolSearchFinanceProducts({ usage, keyword }) {
  const url = new URL(FIN_PRODUCT_BASE_URL + FIN_PRODUCT_OP_PATH);
  url.searchParams.set("serviceKey", FIN_PRODUCT_SERVICE_KEY);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "10");
  if (usage) url.searchParams.set("likeUsge", usage);
  if (keyword) url.searchParams.set("likeFinPrdNm", keyword);
  return fetchJsonOrXml(url.toString());
}

async function toolGetDidimdolRate() {
  const url = new URL(DIDIMDOL_BASE_URL + DIDIMDOL_OP_PATH);
  url.searchParams.set("serviceKey", HF_LOAN_SERVICE_KEY);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "10");
  return fetchJsonOrXml(url.toString());
}

async function toolGetJeonseBankRate() {
  const url = new URL(HF_BASE_URL + HF_RATE_LIST_PATH);
  url.searchParams.set("serviceKey", HF_SERVICE_KEY);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "20");
  return fetchJsonOrXml(url.toString());
}

const TOOLS = [
  {
    name: "search_welfare",
    description:
      "실제 정부 복지 서비스 목록을 조회한다(중앙부처+지자체). 이름 검색어나 생애주기/가구상황 코드로 필터링할 수 있다. 결과의 servId를 get_welfare_detail에 넘기면 더 자세한 정보를 볼 수 있다.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "복지 서비스 이름 검색어 (예: 문화누리카드, 아이돌봄)" },
        lifeArray: { type: "string", description: "생애주기 코드 하나. 001영유아 002아동 003청소년 004청년 005중장년 006노년 007임신출산" },
        trgterIndvdlArray: { type: "string", description: "가구상황 코드(콤마로 여러개 가능). 010다문화탈북민 020다자녀 030보훈대상자 040장애인 050저소득 060한부모조손" },
        scope: { type: "string", enum: ["central", "local"], description: "중앙부처만/지자체만 보고 싶을 때만 지정, 없으면 둘 다 조회" },
      },
    },
  },
  {
    name: "get_welfare_detail",
    description: "search_welfare 결과에서 얻은 특정 복지 서비스 하나의 상세 정보(대상/선정기준/신청방법/문의처)를 조회한다.",
    input_schema: {
      type: "object",
      properties: {
        servId: { type: "string", description: "search_welfare 결과의 servId 값" },
        scope: { type: "string", enum: ["central", "local"] },
      },
      required: ["servId", "scope"],
    },
  },
  {
    name: "search_finance_products",
    description: "서민금융 대출/저축 상품(금융위원회_서민금융상품기본정보)을 조회한다. 상품명/금리/한도/대상/신청방법이 나온다.",
    input_schema: {
      type: "object",
      properties: {
        usage: { type: "string", description: "대출 용도: 생계, 창업, 운영, 주거(전세·주택자금 포함), 학자금" },
        keyword: { type: "string", description: "상품명 검색어 (예: 버팀목, 디딤돌)" },
      },
    },
  },
  {
    name: "get_didimdol_rate",
    description: "디딤돌대출(주택 구입자금) 최신 금리를 소득구간(2천/4천/6천만원 이하)별, 대출기간(10/15/20/30년)별로 조회한다.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_jeonse_bank_rate",
    description: "전세자금대출의 은행별 평균 적용금리를 조회한다 (은행 전체 평균값, 특정 상품 금리 아님).",
    input_schema: { type: "object", properties: {} },
  },
];

async function executeTool(name, input) {
  switch (name) {
    case "search_welfare":
      return toolSearchWelfare(input || {});
    case "get_welfare_detail":
      return toolGetWelfareDetail(input || {});
    case "search_finance_products":
      return toolSearchFinanceProducts(input || {});
    case "get_didimdol_rate":
      return toolGetDidimdolRate();
    case "get_jeonse_bank_rate":
      return toolGetJeonseBankRate();
    default:
      return { error: `알 수 없는 도구: ${name}` };
  }
}

const AGENT_SYSTEM_PROMPT = `당신은 시각장애인·고령자 등 취약계층을 위한 "배리어프리 생활 에이전트"입니다.

[핵심 규칙 - 반드시 지켜야 함]
1. 질문에 답하려면 반드시 제공된 도구(tool)를 먼저 사용해서 실제 정부·금융 데이터를 조회하세요.
2. 답변의 모든 구체적인 사실(나이 기준, 금액, 조건, 신청방법, 연락처 등)은 오직 도구 결과 안에 있는 내용이어야 합니다.
   당신이 원래 알고 있던 배경지식으로 구체적인 숫자나 조건을 채워넣지 마세요. 도구 결과에 없으면
   "정확한 조건은 도구 조회 결과에 없어 확인이 더 필요합니다"라고 솔직히 말하세요.
3. 도구 결과가 비어있거나 오류이면 지어내지 말고 실패했다고 말하세요.

[출력 형식 - 반드시 지켜야 함]
- 이 답변은 일반 텍스트 화면에 그대로 표시되고 음성으로도 읽힙니다.
- 마크다운 문법(별표 강조, 괄호 링크, 제목 기호, 표 등)을 절대 쓰지 마세요. 순수 텍스트 문장만 쓰세요.
- 링크가 필요하면 "예: mnuri.kr" 처럼 주소만 평범한 텍스트로 적으세요.
- 목록이 필요하면 "첫째, ... 둘째, ..." 처럼 자연스러운 문장으로 풀어 쓰거나, 줄바꿈과 "-" 정도만 쓰세요.
- 한국어로, 소리 내어 읽었을 때 자연스럽도록 짧고 명확한 문장으로 작성하고, 전문용어는 풀어서 설명하세요.
- 실제 신청은 이 앱이 대신해주지 않는다는 점을 필요하면 알려주세요.`;

// 시스템 프롬프트로 마크다운 금지를 지시해도 100% 지켜진다는 보장이 없어,
// 화면/음성 출력 직전에 한 번 더 방어적으로 제거한다.
function stripMarkdown(s) {
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => (text.trim() === url.trim() ? url : `${text} (${url})`))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

app.post("/api/agent/ask", async (req, res) => {
  if (!anthropic) {
    const reason = anthropicLoadError
      ? `SDK 로드 실패: ${anthropicLoadError.message}`
      : "ANTHROPIC_API_KEY가 설정되지 않았습니다.";
    return res.status(500).json({ ok: false, message: `AI 질의응답 기능을 쓸 수 없습니다 (${reason})` });
  }
  const question = req.body && req.body.question;
  if (!question || typeof question !== "string") {
    return res.status(400).json({ ok: false, message: "question(질문)이 필요합니다." });
  }

  try {
    const messages = [{ role: "user", content: question }];
    const model = process.env.AGENT_MODEL || "claude-sonnet-5";

    let response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: AGENT_SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // 도구 호출 루프 (최대 4회 왕복) - 한 응답에 tool_use가 여러 개 있을 수 있어 전부 처리해야 한다.
    for (let i = 0; i < 4; i++) {
      const toolUses = response.content.filter((c) => c.type === "tool_use");
      if (toolUses.length === 0) break;

      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const toolUse of toolUses) {
        const result = await executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result).slice(0, 8000),
        });
      }
      messages.push({ role: "user", content: toolResults });

      response = await anthropic.messages.create({
        model,
        max_tokens: 2048,
        system: AGENT_SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    }

    const finalText = response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    // 토큰 한도로 답변이 중간에 끊긴 경우, 사용자가 "왜 갑자기 끝났지"라고 오해하지 않도록 알려준다.
    const truncatedNote =
      response.stop_reason === "max_tokens" ? "\n\n(답변이 길어서 여기서 요약을 마칩니다. 더 필요하면 구체적으로 다시 물어봐 주세요.)" : "";

    res.json({
      ok: true,
      answer: (stripMarkdown(finalText) || "답변을 만들지 못했습니다. 다시 질문해 주세요.") + truncatedNote,
    });
  } catch (err) {
    console.error("에이전트 오류:", err);
    res.status(502).json({ ok: false, message: "AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.", error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[welfare-proxy] http://localhost:${PORT} 에서 실행 중`);
  console.log(`[welfare-proxy] 데모 페이지: http://localhost:${PORT}/welfare_demo.html`);
});
