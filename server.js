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
// 기본값(100KB)으로는 사진 첨부(base64로 변환하면 용량이 꽤 커짐) 요청이 거부되어 늘렸다.
app.use(express.json({ limit: "15mb" }));

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
    // ⚠️ 001(제목만)이 아니라 003(제목+내용)으로 검색한다. "어르신"처럼 제목엔 없어도
    // 설명 내용에는 있는 단어가 많아서, 동의어를 일일이 등록하는 대신 검색 범위 자체를 넓혔다.
    url.searchParams.set("srchKeyCode", "003");
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

function decodeEntitiesPlain(s) {
  if (typeof s !== "string") return undefined;
  const t = s
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\r\n|\r/g, "\n")
    .trim();
  return t || undefined;
}

// 상세조회 원본 응답(central: wantedDtl, local: wantedList.servList)을 사람이 읽을 텍스트로 변환.
// 클라이언트(WelfareTaxService.formatDetail)와 같은 필드 매핑을 서버에서도 그대로 쓴다.
function formatWelfareDetailPlain(raw, scope) {
  const envelope = raw?.wantedDtl ?? raw?.wantedList ?? raw;
  const row = Array.isArray(envelope?.servList) ? envelope.servList[0] : envelope?.servList ?? envelope;
  if (!row) return "상세 정보를 찾지 못했습니다.";

  const lines = [];
  if (scope === "central") {
    const target = decodeEntitiesPlain(row.tgtrDtlCn);
    if (target) lines.push(`대상: ${target}`);
    const criteria = decodeEntitiesPlain(row.slctCritCn);
    if (criteria) lines.push(`선정기준: ${criteria}`);
    const benefit = decodeEntitiesPlain(row.alwServCn);
    if (benefit) lines.push(`지원내용: ${benefit}`);
    const agency = decodeEntitiesPlain(row.jurMnofNm);
    if (agency) lines.push(`담당기관: ${agency}`);
  } else {
    const digest = decodeEntitiesPlain(row.servDgst);
    if (digest) lines.push(digest);
    const target = decodeEntitiesPlain(row.trgterIndvdlNmArray);
    if (target) lines.push(`대상: ${target}`);
    const method = decodeEntitiesPlain(row.aplyMtdNm);
    if (method) lines.push(`신청방법: ${method}`);
    const agency = decodeEntitiesPlain(row.bizChrDeptNm);
    if (agency) lines.push(`담당기관: ${agency}`);
    const region = [decodeEntitiesPlain(row.ctpvNm), decodeEntitiesPlain(row.sggNm)].filter(Boolean).join(" ");
    if (region) lines.push(`지역: ${region}`);
  }
  return lines.length > 0 ? lines.join("\n") : "상세 정보를 찾았지만 표시할 내용이 없습니다.";
}

// search_welfare 도구 결과(원본 central/local 응답)에서 화면에 탭 가능한 버튼으로 보여줄
// {id, title, scope} 목록을 뽑는다. 최대 8개까지만.
function extractWelfareItemsFromSearchResult(result) {
  const items = [];
  for (const scope of ["central", "local"]) {
    const envelope = result?.[scope];
    if (!envelope || envelope.error) continue;
    const wanted = envelope?.wantedList ?? envelope;
    const list = wanted?.servList;
    const rows = Array.isArray(list) ? list : list ? [list] : [];
    for (const row of rows) {
      const title = decodeEntitiesPlain(row.servNm);
      if (row.servId && title) items.push({ domain: "welfare", id: row.servId, title, scope });
    }
  }
  return items.slice(0, 8);
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

// search_finance_products 결과에서 항목을 뽑는다. 이 API는 목록 조회 하나에 이미
// 상세정보(대상/금리/한도/신청방법/문의처)가 다 들어있어서, 복지처럼 별도 상세조회가 필요 없다.
// 그래서 원본 행(row)을 meta로 통째로 같이 보내, 클라이언트가 서버를 다시 안 거치고
// 그 자리에서 바로 포맷해서 보여줄 수 있게 한다.
function extractFinanceItemsFromSearchResult(result) {
  const envelope = result?.response ?? result;
  const body = envelope?.body ?? envelope;
  const rows = body?.items?.item ?? body?.items ?? [];
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.slice(0, 8).map((row, idx) => ({
    domain: "finance",
    id: `${decodeEntitiesPlain(row.finPrdNm) ?? "product"}_${idx}`,
    title: decodeEntitiesPlain(row.finPrdNm) ?? "(상품명 확인 필요)",
    meta: row,
  }));
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

// =====================================================================
// 앱 자체 고정 정보 DB - "65세 이상 지하철 무임승차"처럼 개별 신청 프로그램이
// 아니라 오래전부터 시행 중인 보편적 제도라, 복지서비스 API 카탈로그에는 잘 안
// 잡히지만 실생활에서 자주 물어보는 정보들. 여기 내용은 우리가 직접 확인해서
// 넣은 것이라(Claude의 즉석 기억이 아님) 더 신뢰할 수 있다. 그래도 세부 조건은
// 계속 바뀔 수 있어 "최종 확인일"을 꼭 표시하고, 정확한 확인은 관할 기관에 안내한다.
// =====================================================================
const FIXED_FACTS = [
  {
    id: "free-school-meal",
    keywords: ["급식비", "무상급식", "학교급식", "급식 지원", "교육청 급식"],
    title: "초·중·고 무상급식",
    content:
      "초등학교·중학교·고등학교 학생 급식은 서울시를 포함해 전국 대부분 지역에서 이미 전면 무상으로 " +
      "시행되고 있어서, 일반적으로 학부모가 별도로 신청하지 않아도 학교를 통해 자동으로 제공됩니다. " +
      "다만 일부 사립학교나 방학 중 급식, 조·석식 추가 지원 등은 지역·학교마다 조건이 다를 수 있고, " +
      "저소득층 자녀는 교육급여 등 별도 지원이 추가로 있을 수 있습니다. " +
      "정확한 시행 여부와 세부 조건은 다니는 학교나 관할 교육청(예: 서울시교육청 국번없이 120)에 " +
      "확인하시는 것이 가장 정확합니다.",
    lastVerified: "2026-01",
  },
  {
    id: "jeonse-renewal-right",
    keywords: ["계약갱신", "전세 갱신", "묵시적 갱신", "계약갱신요구권", "임차권등기", "전세 연장"],
    title: "전세(임대차) 계약갱신요구권과 묵시적 갱신",
    content:
      "주택임대차보호법에 따르면, 세입자는 계약이 끝나기 6개월 전부터 2개월 전 사이에 집주인에게 계약갱신을 " +
      "요구할 수 있고, 집주인은 정당한 사유 없이 이를 거절할 수 없습니다(계약갱신요구권은 1회만 사용 가능하며, " +
      "갱신되면 계약기간은 2년으로 봅니다). 만약 이 기간 안에 집주인이 갱신 거절이나 조건 변경을 알리지 않으면, " +
      "이전과 같은 조건으로 자동 연장된 것으로 봅니다(묵시적 갱신). 이 경우에도 세입자는 언제든지 계약해지를 " +
      "통지할 수 있고, 집주인이 통지를 받은 날부터 3개월이 지나면 효력이 발생해서 보증금을 돌려받을 권리가 " +
      "생깁니다. 계약이 끝났는데도 보증금을 못 돌려받았다면, 이사 가기 전에 법원에 임차권등기명령을 신청해서 " +
      "권리를 지킬 수 있습니다. 구체적인 사안은 대한법률구조공단(국번없이 132) 등에서 상담받아 보시는 것이 좋습니다.",
    lastVerified: "2026-01",
  },
  {
    id: "subway-senior-free",
    keywords: ["지하철", "전철", "도시철도", "경로우대", "노인 교통", "65세 교통", "노인 지하철"],
    title: "65세 이상 지하철(도시철도) 무임승차",
    content:
      "만 65세 이상 어르신은 노인복지법상 경로우대 제도에 따라 전국 대부분의 지하철·도시철도를 무료로 이용할 수 있습니다. " +
      "역 창구에서 신분증(주민등록증 등)을 제시하면 바로 무임 승차권을 받을 수 있고, 자주 이용하신다면 관할 구청·주민센터에서 " +
      "우대용 교통카드(예: 어르신 교통카드)를 발급받아 편하게 쓰실 수도 있습니다. " +
      "코레일 일반열차(무궁화호 등)도 일부 할인이 있습니다. " +
      "다만 신분당선처럼 민자로 운영되는 일부 노선은 무임 적용이 안 되거나 조건이 다를 수 있어, 이용 전 해당 노선에 확인하는 것이 좋습니다.",
    lastVerified: "2026-01",
  },
  {
    id: "disabled-transport-discount",
    keywords: ["장애인 교통", "장애인 지하철", "장애인 버스 할인", "장애인 통행료", "장애인 고속도로"],
    title: "장애인등록증(복지카드) 소지자 교통 할인·면제",
    content:
      "장애인등록증(복지카드)이 있으면 지하철·도시철도 무임승차, 철도(KTX·새마을·무궁화 등) 할인, 고속도로 통행료 할인 등 " +
      "다양한 교통 혜택을 받을 수 있습니다. 장애 정도(심한 장애/심하지 않은 장애)나 지역에 따라 적용 범위와 할인율이 다를 수 있어, " +
      "정확한 내용은 관할 구청 장애인복지 담당 부서나 한국장애인복지관에 문의하시는 것이 가장 정확합니다.",
    lastVerified: "2026-01",
  },
  {
    id: "senior-culture-discount",
    keywords: ["경로우대 할인", "고궁 무료", "박물관 무료 노인", "노인 문화시설"],
    title: "경로우대(65세 이상) 문화시설 할인·무료입장",
    content:
      "만 65세 이상이면 고궁(경복궁 등), 능원, 국공립박물관·미술관 등 국가에서 운영하는 문화시설 대부분을 무료 또는 할인된 " +
      "요금으로 이용할 수 있습니다. 입장 시 신분증을 제시하면 됩니다. 시설마다 세부 기준이 다를 수 있어, 방문 전 해당 시설 " +
      "홈페이지에서 한 번 확인하시는 것을 권해드립니다.",
    lastVerified: "2026-01",
  },
  {
    id: "jeonse-guarantor-comparison",
    keywords: ["HUG", "SGI", "서울보증", "주택도시보증", "보증기관", "전세보증 비교", "전세보증보험"],
    title: "전세자금보증 3개 기관(HF·HUG·SGI) 비교",
    content:
      "전세자금대출에는 보증기관이 필요한데, 대표적으로 HF(한국주택금융공사)·HUG(주택도시보증공사)·SGI(서울보증보험) 세 곳이 있습니다. " +
      "이 앱은 HF만 실제로 연동되어 있고, HUG·SGI는 API가 없어 직접 조회는 안 됩니다. 일반적으로: " +
      "HF는 공공기관으로 보증료가 저렴한 편이지만 소득증빙이 필수라 학생·프리랜서는 이용이 어려울 수 있습니다. " +
      "HUG도 공공기관이며 소득증빙 부담이 적어 사회초년생·프리랜서에게 상대적으로 유리하고, 소득보다 집의 안전성 위주로 심사합니다(hug.or.kr). " +
      "SGI는 민간 보증회사로 가입조건이 관대한 편이지만 보증료가 가장 비싸고, HF·HUG의 한도를 넘는 고액 전세나 법인 명의 계약의 대안으로 자주 쓰입니다(sgic.co.kr). " +
      "정확한 보증한도·보증료율은 기관과 시기마다 달라, 반드시 해당 기관 홈페이지나 은행 창구에서 확인하세요.",
    lastVerified: "2026-09",
  },
  {
    id: "veteran-transport",
    keywords: ["국가유공자 교통", "보훈대상자 교통", "국가유공자 지하철"],
    title: "국가유공자(보훈대상자) 교통 지원",
    content:
      "국가유공자로 등록되어 있으면 지하철 무임승차, 철도 할인 등 대중교통 관련 혜택을 받을 수 있습니다. 정확한 대상과 " +
      "할인율은 보훈 등급에 따라 다르므로, 관할 보훈(지)청이나 국가보훈부(1577-0606)에 문의하시는 것이 정확합니다.",
    lastVerified: "2026-01",
  },
];

function searchFixedFacts(query) {
  const q = (query || "").toLowerCase();
  return FIXED_FACTS.filter((f) => f.keywords.some((k) => q.includes(k.toLowerCase())));
}


// =====================================================================
// 복지 ↔ 금융 연결 DB (이 앱의 기본 사상)
// 복지 정보를 조회하면 관련 금융 정보를, 금융 정보를 조회하면 관련 복지 정보를
// "서버가 직접" 붙인다. AI가 프롬프트 지시를 놓쳐도 빠지지 않게 하기 위함.
// - tool: 앱 안의 바로가기(property-calc=대출한도 계산기, jeonse-recommend=전세보증 추천)
// - question: 누르면 AI에게 그대로 질문하는 문장(정부 DB를 다시 조회하게 됨)
// 수치는 일부러 넣지 않는다(바뀔 수 있고, 수치는 정부 DB 조회 결과로만 안내).
// =====================================================================
const CROSS_LINKS = [
  // ---------- 복지 → 금융 ----------
  {
    id: "w2f-jeonse",
    direction: "welfare->finance",
    keywords: ["전세", "월세", "보증금", "임대주택", "행복주택", "주거급여", "주거 지원", "주거지원", "청년 주거", "신혼부부 주거", "주거안정", "임차"],
    title: "전세자금대출·보증기관 비교",
    reason: "주거 관련 복지는 보증금 마련과 함께 보는 경우가 많습니다. 전세자금대출 금리와 보증기관(HF·HUG·SGI)을 비교해 볼 수 있습니다.",
    tool: "jeonse-recommend",
    question: "전세자금대출 금리와 보증기관을 비교해서 알려줘",
  },
  {
    id: "w2f-home-buy",
    direction: "welfare->finance",
    keywords: ["내집마련", "내 집 마련", "주택구입", "주택 구입", "생애최초", "신혼부부", "디딤돌", "분양", "매매"],
    title: "대출한도 계산기(LTV·DSR)와 디딤돌 대출 금리",
    reason: "주택 구입 지원은 대출 한도(LTV·DTI·DSR 규제)에 따라 실제 가능 금액이 달라집니다.",
    tool: "property-calc",
    question: "디딤돌대출 금리와 대출 조건을 알려줘",
  },
  {
    id: "w2f-low-income-loan",
    direction: "welfare->finance",
    keywords: ["저소득", "기초생활", "차상위", "긴급복지", "위기가구", "생계", "자립", "대여", "생활자금", "기초수급", "한부모", "장애인 자립", "자립금"],
    title: "서민금융 상품(햇살론·소액생계대출 등)",
    reason: "복지 지원만으로 부족할 때 쓸 수 있는 서민금융 상품이 있습니다. 대상과 조건은 정부 DB에서 다시 조회해 드립니다.",
    question: "저소득층이 이용할 수 있는 서민금융 대출 상품을 알려줘",
  },
  {
    id: "w2f-youth",
    direction: "welfare->finance",
    keywords: ["청년", "사회초년생", "취업준비", "구직", "대학생"],
    title: "청년 예·적금과 저축 상품",
    reason: "청년 지원 제도와 함께 이용하면 좋은 청년 대상 예·적금 상품을 비교해 볼 수 있습니다.",
    question: "청년이 가입할 수 있는 적금 상품을 알려줘",
  },
  {
    id: "w2f-senior",
    direction: "welfare->finance",
    keywords: ["어르신", "노인", "기초연금", "노령", "경로", "65세", "독거", "치매", "요양"],
    title: "주택연금과 어르신 예·적금",
    reason: "연금·노후 복지와 함께 집을 담보로 매달 연금을 받는 주택연금, 어르신 우대 예금을 같이 살펴볼 수 있습니다.",
    question: "주택연금이 무엇이고 누가 받을 수 있는지 알려줘",
  },
  {
    id: "w2f-student",
    direction: "welfare->finance",
    keywords: ["학자금", "장학", "등록금", "교육비", "교육급여", "교육복지"],
    title: "학자금대출 안내",
    reason: "장학·교육비 지원을 받아도 부족한 부분은 학자금대출로 채우는 경우가 있습니다.",
    question: "학자금대출 종류와 조건을 알려줘",
  },
  {
    id: "w2f-business",
    direction: "welfare->finance",
    keywords: ["창업", "소상공인", "자영업", "폐업", "사업자"],
    title: "소상공인·창업 정책 대출",
    reason: "창업·소상공인 지원은 정책자금 대출과 함께 안내되는 경우가 많습니다.",
    question: "소상공인이나 창업자가 쓸 수 있는 정책자금 대출을 알려줘",
  },
  {
    id: "w2f-family",
    direction: "welfare->finance",
    keywords: ["출산", "다자녀", "육아", "보육", "아동수당", "양육", "임산부", "신생아"],
    title: "자녀 가구 주택·생활 대출 우대",
    reason: "출산·다자녀 가구는 주택자금 대출에서 우대 조건이 있을 수 있습니다. 현재 조건은 정부 DB로 확인해 드립니다.",
    tool: "property-calc",
    question: "자녀가 있는 가구가 받을 수 있는 주택자금 대출 우대 조건을 알려줘",
  },
  {
    id: "w2f-debt",
    direction: "welfare->finance",
    keywords: ["빚", "채무", "연체", "신용회복", "파산", "회생", "압류"],
    title: "채무조정·신용회복 제도",
    reason: "상환이 어려울 때 신용회복위원회 채무조정, 법원 개인회생 등 공적 제도가 있습니다. 대한법률구조공단(132) 상담도 가능합니다.",
    question: "빚을 갚기 어려울 때 이용할 수 있는 신용회복 제도를 알려줘",
  },
  // ---------- 금융 → 복지 ----------
  {
    id: "f2w-housing",
    direction: "finance->welfare",
    keywords: ["전세", "월세", "버팀목", "디딤돌", "주택담보", "주택 구입", "LTV", "DSR", "보증료"],
    title: "주거 관련 복지 지원",
    reason: "대출 전에 받을 수 있는 주거급여·청년 월세 지원·임대주택 같은 복지 혜택이 있는지 먼저 확인해 보세요.",
    question: "주거급여나 월세 지원 같은 주거 관련 복지 서비스를 알려줘",
  },
  {
    id: "f2w-lowincome",
    direction: "finance->welfare",
    keywords: ["햇살론", "서민금융", "소액생계", "생계자금", "신용회복", "채무", "연체"],
    title: "긴급복지·생계 지원",
    reason: "대출보다 먼저 받을 수 있는 긴급복지지원, 생계·의료 지원 같은 복지 제도가 있는지 확인해 보세요.",
    question: "긴급복지지원이나 생계 지원 같은 복지 서비스를 알려줘",
  },
  {
    id: "f2w-senior",
    direction: "finance->welfare",
    keywords: ["주택연금", "연금", "노후", "어르신", "예금 우대"],
    title: "어르신 복지 서비스",
    reason: "기초연금, 노인 일자리, 돌봄 서비스 같은 어르신 복지를 함께 확인해 보세요.",
    question: "어르신이 받을 수 있는 복지 서비스를 알려줘",
  },
  {
    id: "f2w-youth",
    direction: "finance->welfare",
    keywords: ["청년", "적금", "사회초년생", "학자금"],
    title: "청년·학생 복지 지원",
    reason: "청년 지원 정책과 학생 지원(장학·교육비) 복지를 함께 확인해 보세요.",
    question: "청년이 받을 수 있는 복지 서비스를 알려줘",
  },
  {
    id: "f2w-business",
    direction: "finance->welfare",
    keywords: ["소상공인", "창업", "정책자금", "사업자"],
    title: "소상공인·창업 지원사업",
    reason: "대출 외에 정부가 지원하는 소상공인·창업 지원사업이 있는지 확인해 보세요.",
    question: "소상공인이나 창업을 지원하는 정부 서비스를 알려줘",
  },
];

// texts: 매칭에 쓸 문자열 배열(질문, 조회 항목 제목, 답변 등). 키워드 적중이 많은 순으로 최대 limit개.
// 같은 도구/질문이 중복되지 않게 걸러내고, exclude에는 이미 질문 자체가 그 주제면 빼기 위한 id를 넣는다.
function findCrossLinks(direction, texts, limit = 3) {
  const hay = (texts || []).join(" ").toLowerCase();
  const scored = CROSS_LINKS.filter((l) => l.direction === direction)
    .map((l) => ({ l, score: l.keywords.filter((k) => hay.includes(k.toLowerCase())).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ id: x.l.id, title: x.l.title, reason: x.l.reason, tool: x.l.tool || null, question: x.l.question }));
  return scored;
}

// 응답 본문 끝에 붙일 안내문(앱 버전이 달라 버튼이 안 보여도 글로는 항상 나간다).
function buildCrossLinkText(direction, links) {
  if (!links || links.length === 0) return "";
  const head =
    direction === "welfare->finance"
      ? "함께 보면 좋은 금융 정보 (이 앱이 확인한 연결 정보)"
      : "함께 보면 좋은 복지 정보 (이 앱이 확인한 연결 정보)";
  return "\n\n" + head + "\n" + links.map((l, i) => `${i + 1}. ${l.title}: ${l.reason}`).join("\n");
}

const TOOLS = [
  {
    name: "search_welfare",
    description:
      "실제 정부 복지 서비스 목록을 조회한다(중앙부처+지자체). " +
      "⚠️ 중요: keyword(제목/내용 텍스트 검색)는 그 단어가 프로그램 제목이나 설명에 '그대로' 들어있을 때만 찾아진다. " +
      "'어르신', '아이', '장애인' 같은 대상을 물어보는 질문이면, keyword만 쓰지 말고 반드시 아래 lifeArray/trgterIndvdlArray " +
      "코드도 같이 넣어라 (예: '강남구 어르신 복지' → keyword='강남구', lifeArray='006'). " +
      "지역명(강남구 등)은 keyword로 넣고, 대상 계층은 코드로 넣는 식으로 같이 쓰는 게 가장 잘 찾아진다. " +
      "결과의 servId를 get_welfare_detail에 넘기면 더 자세한 정보를 볼 수 있다.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "복지 서비스 이름/지역명 검색어 (예: 문화누리카드, 강남구, 아이돌봄)" },
        lifeArray: {
          type: "string",
          description:
            "생애주기 코드 하나. 001영유아 002아동 003청소년 004청년 005중장년 006노년(=어르신,노인,고령자) 007임신출산(=임산부)",
        },
        trgterIndvdlArray: {
          type: "string",
          description:
            "가구상황 코드(콤마로 여러개 가능). 010다문화탈북민 020다자녀 030보훈대상자(=국가유공자) 040장애인 050저소득(=기초생활수급자,차상위) 060한부모조손",
        },
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
    description:
      "서민금융 대출/저축 상품(금융위원회_서민금융상품기본정보)을 조회한다. 상품명/금리/한도/대상/신청방법이 나온다. " +
      "⚠️ 이 도구와 다른 금융 도구들은 정부·공공기관(HF 등) 상품만 다루며, SGI서울보증보험 같은 민간회사 상품이나 " +
      "개별 은행이 자체적으로 파는 일반 주택담보대출은 포함하지 않는다. 그런 걸 물어보면, 이 앱은 공공데이터만 다뤄서 " +
      "확인할 수 없다고 솔직히 말하고, SGI서울보증(sgic.co.kr)이나 해당 은행에 직접 확인해보라고 안내하라.",
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
    description:
      "주택구입자금 대출(디딤돌대출, 무주택 서민 대상 정책 대출) 최신 금리를 소득구간(2천/4천/6천만원 이하)별, " +
      "대출기간(10/15/20/30년)별로 조회한다. ⚠️ 디딤돌대출은 '주택담보대출'의 한 종류(정책성 저리 상품)이며, " +
      "전세자금대출·생계자금·창업자금·학자금과 나란한 별개의 대출 목적이 아니다. 사용자가 '주택구입자금' " +
      "또는 '주택담보대출'을 물어보면 이 도구로 답하되, 일반 시중은행 자체 주택담보대출 금리는 공공데이터가 " +
      "없어 이 도구로 조회 안 됨을 함께 밝혀라.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_jeonse_bank_rate",
    description: "전세자금대출의 은행별 평균 적용금리를 조회한다 (은행 전체 평균값, 특정 상품 금리 아님).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_public_benefits",
    description:
      "행정안전부_정부24의 '공공서비스(혜택 알리미)' 정보를 조회한다. search_welfare(보건복지부 복지서비스, " +
      "중앙부처+지자체)와는 다른 별도 카탈로그이며, 여기서는 주로 '교육청'이나 '공공기관'이 제공하는 혜택을 " +
      "찾을 때 쓴다(교육급여, 급식비 지원, 공단 자체 지원사업 등 search_welfare에 안 잡히는 것들). " +
      "중앙부처·지자체 복지는 이미 search_welfare로 찾을 수 있으니 중복 조회하지 마라.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "서비스명 검색어" },
        orgType: {
          type: "string",
          enum: ["교육청", "공공기관"],
          description: "소관기관 유형. 기본은 교육청이며, 공공기관 혜택이 필요하면 '공공기관'으로 지정",
        },
      },
    },
  },
  {
    name: "search_fixed_facts",
    description:
      "이 앱이 직접 확인해서 등록해둔 고정 정보 DB를 검색한다. '65세 이상 지하철 무임승차'처럼 개별 신청 " +
      "프로그램이 아니라 오래전부터 시행 중인 보편적 제도라 search_welfare로는 안 잡히는 정보들이 여기 있다. " +
      "search_welfare에서 결과가 없거나 부족했다면, 바로 배경지식으로 넘어가지 말고 반드시 이 도구를 먼저 시도하라.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "사용자 질문 원문 또는 핵심 키워드" } },
      required: ["query"],
    },
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
    case "search_public_benefits":
      return toolSearchPublicBenefits(input || {});
    case "search_fixed_facts": {
      const matches = searchFixedFacts((input && input.query) || "");
      return matches.length > 0
        ? { found: true, facts: matches.map(({ title, content, lastVerified }) => ({ title, content, lastVerified })) }
        : { found: false };
    }
    default:
      return { error: `알 수 없는 도구: ${name}` };
  }
}

const AGENT_SYSTEM_PROMPT = `당신은 시각장애인·고령자 등 취약계층을 위한 "배리어프리 생활 에이전트"입니다.

[핵심 규칙 - 반드시 지켜야 함]
1. "복지/대출/금리가 어떻게 되나요" 같이 실제 정부·금융 사실을 새로 찾아야 하는 질문이면,
   반드시 제공된 도구(tool)를 먼저 사용해서 조회하세요.
1-1. 반면 사용자가 문자메시지·사진·문서 내용을 주면서 "이게 뭐야, 설명해줘, 해석해줘"라고 묻는 경우는
   도구가 필요 없습니다. 그 내용을 그대로 읽고 이해하기 쉽게 설명하면 됩니다. 다만 그 내용 안에 특정
   복지·금융 상품 이름이 나와서 더 찾아볼 필요가 있으면 그때는 도구를 추가로 써도 됩니다.
1-2. 문자메시지·문서에 "링크를 눌러 서류를 제출하라", "개인정보를 입력하라", "인증번호를 알려달라" 같은
   내용이 있으면, 내용 설명과 함께 "문자 속 링크를 직접 누르기보다, 진짜인지 의심되면 카드 뒷면이나
   공식 홈페이지에 있는 번호로 그 기관에 직접 전화해서 확인해보라"는 주의사항을 반드시 같이 안내하세요.
   장애인·고령자가 이런 문자 사기(스미싱)의 표적이 되는 경우가 많습니다.
0. search_welfare를 쓸 때, 사용자가 특정 대상(어르신·아이·장애인·저소득 등)을 언급했다면 keyword 텍스트
   검색만으로는 못 찾는 경우가 많습니다. 반드시 도구 설명에 있는 lifeArray/trgterIndvdlArray 코드도 같이 넣어
   검색하세요. 첫 검색이 비어있거나 부족하면, 코드를 안 썼는지 확인하고 코드를 추가해서 한 번 더 검색해보세요.
   또한 이미 찾았던 특정 프로그램에 대해 사용자가 "그거 자세히 알려줘"처럼 후속 질문을 하면, 그 프로그램
   이름으로 keyword 검색을 다시 해서 servId를 찾은 다음 get_welfare_detail을 호출하세요.
0-1. 전세·주택 관련 대출을 물어보면, search_finance_products/get_jeonse_bank_rate 같은 금융 도구만 쓰지 말고
   search_welfare도 함께 시도하세요. 지자체마다 "신혼부부 전월세 대출이자 지원"처럼 금융 API에는 안 잡히는
   이자지원·전세보증금 대출 관련 복지사업이 따로 있는 경우가 많습니다. 둘 다 찾았으면 "대출 상품"과
   "복지 이자지원 사업"을 구분해서 같이 안내하세요.
0-2. 이 앱에는 대화형 AI 화면 외에, 화면 우측 상단 "찾아보기"로 들어가면 조건을 선택해서 직접 찾아보거나
   (복지), 전세보증 맞춤 추천/LTV·DTI·DSR 계산기 같은 것을 쓸 수 있는 화면(금융)이 따로 있습니다.
   복지 답변 끝에는 "찾아보기 화면에서 조건별로 더 자세히 검색할 수 있다"고 안내하세요.
   ⚠️ 특히 복지 검색 결과 제목이나 내용에 "대여", "융자", "대출", "이자지원"처럼 사실상 대출 성격이
   있는 사업이면(예: 장애인 자립자금 대여, 전세자금 이자지원 등 종류를 가리지 않음), 그냥 찾아보기
   화면 안내로 끝내지 말고 "이 복지사업과 별개로, 비슷한 목적의 서민금융 대출상품도 궁금하시면 이 앱의
   금융 메뉴(서민금융 상품 검색)에서 확인할 수 있다"처럼 구체적으로 연결해서 제안하세요. 가능하면
   search_finance_products도 실제로 호출해서 비슷한 용도의 실제 상품이 있는지 같이 찾아보고, 있으면
   답변에 포함하세요. 정부 복지 정보만으로는 알 수 없는(그 대여사업과 비슷한 목적의 시중 서민금융
   상품 금리·한도 비교 같은) 부분을 이 앱이 추가로 보완해준다는 게 이 앱의 핵심 가치입니다.
   ⚠️ 중요: "LTV·DTI·DSR 계산기"라는 문구는 사용자가 물어본 게 "주택구입/주택담보대출"이라고
   이미 명확한 경우에만 쓰세요. "대출한도 알려줘"처럼 용도가 아직 안 정해져서 먼저 "주택구입자금인지
   전세자금인지 생계자금인지" 같은 확인 질문을 하는 중이라면, 그 확인 질문 답변 안에서는 이 문구를
   절대 쓰지 마세요 (사용자가 주택담보대출이라고 답하면, 그 다음 답변에서만 쓰세요). 이 문구가 있으면
   화면에 "지금 바로 계산기 열기" 버튼이 뜨는데, 아직 용도가 안 정해진 상태에서 뜨면 사용자가 헷갈립니다.
   같은 이유로 "전세보증 맞춤 추천"이라는 문구도, 사용자가 전세자금 보증상품을 원한다는 게 확정된
   경우에만 쓰세요.
2. 답변의 구체적인 사실(정확한 금액, 소득/나이 기준, 신청기한, 연락처 등)은 원칙적으로 도구 결과 안에 있는
   내용이어야 합니다. 당신이 원래 알고 있던 배경지식으로 이런 구체적인 숫자·조건을 지어내지 마세요.
2-1. search_welfare/search_finance 같은 정부API 도구로 검색했는데 결과가 없다면, 곧바로 배경지식으로
   넘어가지 말고 반드시 먼저 search_fixed_facts(이 앱이 직접 확인해서 등록해둔 고정 정보 DB)를 시도하세요.
   거기서 찾으면 그 내용 그대로 답하고 "이 앱이 확인한 정보"라는 출처를 밝히세요(최종 확인일도 같이).
2-2. search_fixed_facts에서도 못 찾았고, 질문이 애초에 이 앱의 도구로 답하기 어려운 일반 상식/개념
   질문이라면, 그때만 당신이 원래 알고 있는 내용으로 답해도 됩니다. 단, 이 경우 반드시 "이 내용은 실제
   데이터베이스 조회 결과가 아니라 일반적으로 알려진 정보입니다"라고 답변 안에 명확히 구분해서 밝히세요.
2-3. 사용자가 특정 지역(예: 서울)을 물어봤는데 도구 결과에 그 지역은 없고 다른 지역(예: 대전, 경기) 결과만
   있다면, "서울은 못 찾았지만 정부24에서 확인한 결과 대전·경기는 이렇습니다"처럼 그 다른 지역 내용이
   실제 도구 조회 결과라는 것을 명확히 밝히세요. 만약 그 다른 지역 사례조차 도구 결과가 아니라 당신이
   원래 알던 일반적인 사업 설명이라면, 2-2처럼 "일반적으로 알려진 정보"라고 반드시 구분해서 밝히세요.
   실제 조회 결과와 일반 지식을 한 답변에 섞을 때는 각각 어느 쪽인지 헷갈리지 않게 구분해야 합니다.
   정확한 세부 조건(정확한 소득기준, 최신 금액 등)까지는 확신하지 말고, 관련 기관에 직접 확인하라고 안내하세요.
3. 도구 결과가 비어있거나 오류이면 (2-1의 일반 상식 답변이 아닌 이상) 지어내지 말고 실패했다고 말하세요.

[출력 형식 - 반드시 지켜야 함]
- 이 답변은 일반 텍스트 화면에 그대로 표시되고 음성으로도 읽힙니다.
- 마크다운 문법(별표 강조, 괄호 링크, 제목 기호, 표 등)을 절대 쓰지 마세요. 순수 텍스트 문장만 쓰세요.
- 링크가 필요하면 "예: mnuri.kr" 처럼 주소만 평범한 텍스트로 적으세요.
- 목록이 필요하면 "첫째, ... 둘째, ..." 처럼 자연스러운 문장으로 풀어 쓰거나, 줄바꿈과 "-" 정도만 쓰세요.
- 한국어로, 소리 내어 읽었을 때 자연스럽도록 짧고 명확한 문장으로 작성하고, 전문용어는 풀어서 설명하세요.
- 실제 신청은 이 앱이 대신해주지 않는다는 점을 필요하면 알려주세요.

[사진으로 물어보기]
사용자가 사진(은행 서류, 화면, 안내문 등)을 같이 보내는 경우가 있습니다. 이때는:
- 사진에 보이는 내용(문구, 숫자, 표, 버튼 등)을 있는 그대로 정확히 읽어서 설명하세요.
- 이해하기 어려운 서류나 화면이면, 그게 무엇에 관한 것인지, 어떤 절차로 보이는지 쉬운 말로 풀어서 설명하세요.
- 사진에 특정 복지/금융 상품 이름이 보이면, 도구로 실제 조회해서 정확한 정보를 추가로 안내해도 됩니다.
- 사진이 흐릿하거나 글자가 잘 안 보이면 억지로 추측하지 말고, 어떤 부분이 안 보이는지 솔직히 말하세요.
- 시각장애인이나 그 동행인이 은행 창구 등에서 보내는 사진일 수 있음을 감안해, 차분하고 친절하게 설명하세요.`;

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

// =====================================================================
// 데이터소스 사용 로그 - 앱이 말하는 "3가지 데이터"(정부DB / 자체DB / 일반지식)가 실제로
// 의도대로 쓰이는지 매일 확인하기 위한 것. Render 무료 플랜은 서버가 재시작되면 메모리가
// 초기화되므로 "서버가 켜져있는 동안의 기록"이다. 개인정보 보호를 위해 질문은 앞 60자만 남긴다.
// =====================================================================
function kstDateKey(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // 한국시간 기준 YYYY-MM-DD
}
const dataSourceLog = [];
const MAX_LOG_SIZE = 2000;

function logDataSourceUsage(entry) {
  const now = Date.now();
  dataSourceLog.push({
    ts: now,
    dateKey: kstDateKey(now),
    questionPreview: String(entry.question || "").slice(0, 60),
    govDbUsed: entry.govDbUsed,
    ownDbUsed: entry.ownDbUsed,
    generalKnowledgeUsed: entry.generalKnowledgeUsed,
    crossReferenced: entry.crossReferenced,
    toolsUsed: entry.toolsUsed,
    suggestedTool: entry.suggestedTool,
    crossLinkIds: entry.crossLinkIds || [],
  });
  if (dataSourceLog.length > MAX_LOG_SIZE) dataSourceLog.shift();
}

function buildDailyLogText(dateKey) {
  const day = dataSourceLog.filter((e) => e.dateKey === dateKey);
  const count = (fn) => day.filter(fn).length;
  const lines = [
    `=== 배리어프리 생활 에이전트 - 데이터소스 사용 로그 (${dateKey}, 한국시간) ===`,
    "",
    `총 질문 수: ${day.length}건`,
    `- 정부DB(실시간 API) 사용: ${count((e) => e.govDbUsed)}건`,
    `- 자체DB(고정정보·계산기·전세추천 연결) 사용: ${count((e) => e.ownDbUsed)}건`,
    `- 일반지식(Claude 배경지식) 사용: ${count((e) => e.generalKnowledgeUsed)}건`,
    `- 복지↔금융 교차연결 발생: ${count((e) => e.crossReferenced)}건`,
    "",
    "--- 상세 내역 ---",
  ];
  if (day.length === 0) lines.push("(이 날짜 기록이 없습니다. 서버가 재시작되어 이전 기록이 초기화됐을 수 있습니다.)");
  day.forEach((e, i) => {
    const time = new Date(e.ts).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" });
    const sources = [e.govDbUsed && "정부DB", e.ownDbUsed && "자체DB", e.generalKnowledgeUsed && "일반지식"].filter(Boolean).join("+");
    lines.push(
      `${i + 1}. [${time}] "${e.questionPreview}" → ${sources || "(분류없음)"}` +
        `${e.crossReferenced ? " · 교차연결O" : ""}${e.suggestedTool ? ` · 바로가기(${e.suggestedTool})` : ""}${e.crossLinkIds?.length ? ` · 연결제안:${e.crossLinkIds.join(",")}` : ""}` +
        `${e.toolsUsed?.length ? ` · 도구:${e.toolsUsed.join(",")}` : ""}`
    );
  });
  return lines.join("\n");
}

// 텍스트 파일로 내려받는다. 질문 앞부분이 들어있어 개인정보가 섞일 수 있으므로
// ADMIN_LOG_KEY 환경변수를 정하고 ?key=값 을 붙여야만 열린다 (환경변수가 없으면 닫혀 있음).
app.get("/api/admin/daily-log", (req, res) => {
  const adminKey = process.env.ADMIN_LOG_KEY;
  if (!adminKey || req.query.key !== adminKey) return res.status(403).send("접근할 수 없습니다.");
  const dateKey = req.query.date || kstDateKey(Date.now());
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="data-source-log-${dateKey}.txt"`);
  res.send(buildDailyLogText(dateKey));
});

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

  // "무엇이든 물어보기" 답변에 나온 항목을 탭했을 때 오는 특수 요청.
  // LLM에게 다시 물어서 재검색시키는 대신, 정확한 servId로 바로 상세조회한다
  // (더 빠르고, 재검색 실패 가능성이 없어 100% 정확하다).
  const detailMatch = question.match(/^__DETAIL__:(central|local):(.+)$/);
  if (detailMatch) {
    const [, scope, servId] = detailMatch;
    try {
      const raw = await toolGetWelfareDetail({ servId, scope });
      const detailText = formatWelfareDetailPlain(raw, scope);
      const detailLinks = findCrossLinks("welfare->finance", [detailText]);
      logDataSourceUsage({
        question: "(복지 상세조회) " + servId,
        govDbUsed: true,
        ownDbUsed: detailLinks.length > 0,
        generalKnowledgeUsed: false,
        crossReferenced: detailLinks.length > 0,
        toolsUsed: ["get_welfare_detail"],
        suggestedTool: null,
        crossLinkIds: detailLinks.map((l) => l.id),
      });
      return res.json({
        ok: true,
        answer: detailText + buildCrossLinkText("welfare->finance", detailLinks),
        followups: [],
        items: [],
        crossLinks: detailLinks,
      });
    } catch (err) {
      console.error("상세조회 단축 경로 오류:", err);
      return res.status(502).json({ ok: false, message: "상세 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
  }

  // 이전 대화 기록 (클라이언트가 매번 통째로 보내는 방식 - 서버는 세션을 따로 저장하지 않는다)
  const rawHistory = Array.isArray(req.body.history) ? req.body.history : [];
  const history = rawHistory
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string")
    .slice(-20) // 너무 길어지지 않게 최근 20턴까지만
    .map((h) => ({ role: h.role, content: h.text }));

  // 사진으로 물어보기 - 클라이언트가 base64 이미지를 같이 보내면 Claude의 비전 기능으로 함께 분석한다.
  const image = req.body.image; // { base64: string, mediaType: 'image/jpeg' 등 }
  const userContent =
    image && image.base64
      ? [
          { type: "image", source: { type: "base64", media_type: image.mediaType || "image/jpeg", data: image.base64 } },
          { type: "text", text: question },
        ]
      : question;

  try {
    const messages = [...history, { role: "user", content: userContent }];
    const model = process.env.AGENT_MODEL || "claude-sonnet-5";

    let response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: AGENT_SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // 도구 호출 루프 (최대 4회 왕복) - 한 응답에 tool_use가 여러 개 있을 수 있어 전부 처리해야 한다.
    let lastItems = []; // 가장 최근 검색 결과 - 화면에 탭 가능한 버튼으로 보여줄 목록 (복지/금융 공통)
    // 프롬프트로 "출처를 구분해서 밝히라"고 지시해도 100% 지켜진다는 보장이 없어, 실제로 도구가
    // 뭐라도 찾았는지(복지/금융/정부24/고정DB 중 하나라도) 서버가 직접 추적해서 방어적으로 검증한다.
    let govDbUsed = false; // 정부DB(실시간 API)
    let ownDbUsed = false; // 자체DB(고정정보/계산기·추천 연결)
    const usedToolNames = [];
    for (let i = 0; i < 4; i++) {
      const toolUses = response.content.filter((c) => c.type === "tool_use");
      if (toolUses.length === 0) break;

      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const toolUse of toolUses) {
        const result = await executeTool(toolUse.name, toolUse.input);
        usedToolNames.push(toolUse.name);
        if (toolUse.name === "search_welfare") {
          const found = extractWelfareItemsFromSearchResult(result);
          if (found.length > 0) {
            lastItems = found;
            govDbUsed = true;
          }
        } else if (toolUse.name === "search_finance_products") {
          const found = extractFinanceItemsFromSearchResult(result);
          if (found.length > 0) {
            lastItems = found;
            govDbUsed = true;
          }
        } else if (toolUse.name === "search_public_benefits") {
          if (Array.isArray(result?.data) && result.data.length > 0) govDbUsed = true;
        } else if (toolUse.name === "search_fixed_facts") {
          if (result?.found) ownDbUsed = true; // 자체DB(고정정보) 히트
        } else if (
          toolUse.name === "get_didimdol_rate" ||
          toolUse.name === "get_jeonse_bank_rate" ||
          toolUse.name === "get_welfare_detail"
        ) {
          govDbUsed = true; // 이 도구들은 결과가 오면 곧 실제 정부 데이터다
        }
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

    let bodyPart = response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    // 안전장치: 도구가 실제로 뭔가를 찾은 게 하나도 없는데(정부DB도 자체DB도 히트 안 함),
    // 답변 안에 출처 구분 문구("일반적으로 알려진 정보", "이 앱이 확인한", "정부24에서 확인" 등)가
    // 전혀 없다면 - 프롬프트 지시를 놓친 것으로 보고 방어적으로 주의문을 붙인다.
    const hasSourceLabel = /일반적으로 알려진|이 앱이 확인한|정부24에서 확인|찾지 못했|확인이 더 필요/.test(bodyPart);
    const generalKnowledgeUsed = !govDbUsed && !ownDbUsed;
    if (generalKnowledgeUsed && !hasSourceLabel && bodyPart.length > 30) {
      bodyPart +=
        "\n\n⚠️ 참고: 이 답변 중 구체적인 수치나 절차는 실제 조회 결과가 아니라 일반적으로 알려진 내용을 " +
        "바탕으로 한 것일 수 있습니다. 정확한 내용은 관할 기관에 직접 확인해 주세요.";
    }

    // ---- 복지↔금융 연결 강제 부착 (이 앱의 기본 사상) ----
    // 복지 조회가 있었으면 금융 제안을, 금융 조회가 있었으면 복지 제안을 서버가 직접 붙인다.
    // 질문 자체가 이미 그 주제(예: 전세 금리를 물었는데 전세 금융 제안)이면 중복이라 제외한다.
    const welfareUsed = ["search_welfare", "get_welfare_detail", "search_public_benefits", "search_fixed_facts"].some((t) => usedToolNames.includes(t));
    const financeUsedEarly = ["search_finance_products", "get_jeonse_bank_rate", "get_didimdol_rate"].some((t) => usedToolNames.includes(t));
    const matchTexts = [question, ...lastItems.map((it) => it.title || ""), bodyPart];
    let crossDirection = null;
    let crossLinks = [];
    if (welfareUsed) {
      crossDirection = "welfare->finance";
      crossLinks = findCrossLinks(crossDirection, matchTexts);
    }
    if (crossLinks.length === 0 && financeUsedEarly) {
      crossDirection = "finance->welfare";
      crossLinks = findCrossLinks(crossDirection, matchTexts);
    }
    // 답변에 이미 같은 제목의 안내가 있으면 중복이므로 제외
    crossLinks = crossLinks.filter((l) => !bodyPart.includes(l.title) && l.question !== question);
    if (crossLinks.length > 0) {
      bodyPart += buildCrossLinkText(crossDirection, crossLinks);
      ownDbUsed = true; // 연결 DB는 자체 DB다
    }

    // 추천 질문은 본문 생성과 같은 요청에 묶어서 지시하면(예: 특정 구분선 뒤에 붙이라는 식)
    // 다른 형식 지시(마크다운 금지 등)와 섞여서 가끔 빠뜨리는 것으로 확인되어, 아예 별도의
    // 짧고 단순한 요청으로 분리했다 - 이쪽이 훨씬 안정적으로 매번 나온다.
    // 추천 질문 + 5줄 요약을 각각 별도의 짧은 요청으로 만들되, 동시에 실행해서 대기시간을 늘리지 않는다.
    // (시각장애인이 먼저 짧은 요약만 듣고, 필요하면 전체를 펼쳐 보게 하기 위함)
    const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const [followupResult, summaryResult] = await Promise.allSettled([
      anthropic.messages.create({
        model,
        max_tokens: 200,
        system:
          "방금 나눈 대화의 마지막 질문과 답변을 보고, 사용자가 이어서 물어보면 좋을 완결된 질문 문장을 " +
          "정확히 2개 만들어라. 각 줄에 질문 하나씩만 쓰고, 번호·기호·설명·마크다운을 절대 붙이지 마라. " +
          "그 외에는 아무것도 쓰지 마라. " +
          "만약 이번 질문이 특정 시/군/구(예: 강남구, 수원시)에 관한 것이었다면, 두 질문 중 하나는 반드시 " +
          "그 상위 시/도(예: 서울특별시, 경기도) 전체의 관련 정보도 확인하겠냐는 질문으로 만들어라.",
        messages: [{ role: "user", content: `질문: ${question}\n\n답변: ${bodyPart}` }],
      }),
      bodyPart.length > 120 || lastItems.length > 0
        ? anthropic.messages.create({
            model,
            max_tokens: 400,
            system:
              "시각장애인이 가장 먼저 듣게 될 '핵심 요약'을 만들어라. 아래 형식을 반드시 지켜라.\n" +
              "1줄: 조회된 항목 수와 대표 항목이 주어졌으면 '조회된 N건 중 대표로 A, B 등이 있습니다.' 형태로 써라 " +
              "(대표 항목은 제목 그대로 최대 2개). 항목 정보가 없으면 질문에 대한 한 줄 결론을 써라.\n" +
              "2~3줄: 가장 중요한 핵심 결과 한두 가지만(대상, 금액·금리, 연락처 중 핵심). 한 줄은 한 문장, 40자 안팎으로 짧게.\n" +
              "4줄(해당될 때만): 원문에 '일반적으로 알려진 정보', '이 앱이 확인한', '확인이 필요하다' 같은 출처 구분이나 " +
              "주의가 있으면 그 취지를 한 줄로 남겨라.\n" +
              "원문에 없는 내용은 절대 추가하지 말고 숫자·조건은 원문 그대로 써라. '자세한 내용은 ~ 확인하세요' 같은 " +
              "안내 문장은 쓰지 마라(앱이 따로 붙인다). 마크다운·번호·이모지 없이 줄바꿈으로만 구분하고 그 외 말은 쓰지 마라.",
            messages: [
              {
                role: "user",
                content:
                  (lastItems.length > 0
                    ? `조회된 항목 수: ${lastItems.length}건\n대표 항목: ${lastItems
                        .slice(0, 3)
                        .map((it) => it.title)
                        .join(", ")}\n\n`
                    : "") + `답변:\n${bodyPart}`,
              },
            ],
          })
        : Promise.resolve(null),
    ]);

    let followups = [];
    if (followupResult.status === "fulfilled") {
      followups = textOf(followupResult.value)
        .split("\n")
        .map((x) => x.replace(/^[-•\d.\s]+/, "").trim())
        .filter(Boolean)
        .slice(0, 2);
    } else {
      console.warn("추천 질문 생성 실패(무시하고 진행):", followupResult.reason?.message);
    }

    // 요약이 실패하거나 짧은 답변이면 summary는 비워두고, 앱이 전체 답변을 그대로 보여준다.
    let summary = null;
    if (summaryResult.status === "fulfilled" && summaryResult.value) {
      // 모델이 안내 문장을 멋대로 붙여도 중복되지 않게 걸러내고, 마지막 안내 줄은 서버가 고정으로 붙인다.
      const lines = textOf(summaryResult.value)
        .split("\n")
        .map((x) => stripMarkdown(x).trim())
        .filter((x) => x && !/자세히 보기|아래 항목/.test(x)) // 앱이 붙이는 안내 문장만 걸러낸다(주의 문구는 남김)
        .slice(0, 4);
      if (lines.length > 0) {
        const closing =
          lastItems.length > 0
            ? "상세 내역은 아래 항목을 선택하거나 '자세히 보기'를 눌러 확인해 보세요."
            : "상세 내용은 '자세히 보기'를 눌러 확인해 보세요.";
        const crossLine =
          crossLinks.length > 0
            ? (crossDirection === "welfare->finance" ? "함께 볼 금융 정보: " : "함께 볼 복지 정보: ") + crossLinks.map((l) => l.title).join(", ")
            : null;
        summary = [...lines, ...(crossLine ? [crossLine] : []), closing].join("\n");
      }
    } else if (summaryResult.status === "rejected") {
      console.warn("요약 생성 실패(무시하고 진행):", summaryResult.reason?.message);
    }

    // 토큰 한도로 답변이 중간에 끊긴 경우, 사용자가 "왜 갑자기 끝났지"라고 오해하지 않도록 알려준다.
    const truncatedNote =
      response.stop_reason === "max_tokens" ? "\n\n(답변이 길어서 여기서 요약을 마칩니다. 더 필요하면 구체적으로 다시 물어봐 주세요.)" : "";

    const suggestedTool = (() => {
      // 프롬프트로 "용도 미확정 시엔 문구를 쓰지 말라"고 지시해도 100% 지켜진다는 보장이 없어,
      // 여러 대출 용도를 나열하며 "어떤 용도세요?"라고 되묻는 답변이면 방어적으로 버튼을 억제한다.
      const purposeCategories = [/주택구입자금|주택담보대출|디딤돌/, /전세자금대출/, /생계자금/, /창업자금/, /학자금/];
      if (purposeCategories.filter((re) => re.test(bodyPart)).length >= 2) return null;
      if (bodyPart.includes("계산기")) return "property-calc";
      if (bodyPart.includes("전세보증 맞춤 추천")) return "jeonse-recommend";
      return null;
    })();

    // 이 앱이 직접 만든 도구(계산기/전세추천)로 연결했으면 "자체DB" 활용으로 센다.
    if (suggestedTool) ownDbUsed = true;
    // 복지 도구와 금융 도구가 한 답변에서 같이 쓰였으면 "복지↔금융 교차연결"이 일어난 것으로 본다.
    const usedFinance = ["search_finance_products", "get_jeonse_bank_rate", "get_didimdol_rate"].some((t) => usedToolNames.includes(t));
    const crossReferenced = (usedToolNames.includes("search_welfare") && usedFinance) || crossLinks.length > 0;

    logDataSourceUsage({
      question,
      govDbUsed,
      ownDbUsed,
      generalKnowledgeUsed: !govDbUsed && !ownDbUsed,
      crossReferenced,
      toolsUsed: usedToolNames,
      suggestedTool,
      crossLinkIds: crossLinks.map((l) => l.id),
    });

    res.json({
      ok: true,
      answer: (stripMarkdown(bodyPart) || "답변을 만들지 못했습니다. 다시 질문해 주세요.") + truncatedNote,
      summary, // 5줄 이내 요약 (없으면 null)
      followups: followups.map(stripMarkdown),
      items: lastItems,
      suggestedTool,
      crossLinks,
    });
  } catch (err) {
    console.error("에이전트 오류:", err);
    res.status(502).json({ ok: false, message: "AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.", error: String(err) });
  }
});

// =====================================================================
// 국토교통부_아파트 매매 실거래가 (부동산 거래신고법에 따른 실제 신고가격)
// =====================================================================
const APT_TRADE_BASE_URL = process.env.APT_TRADE_BASE_URL || "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev";
const APT_TRADE_SERVICE_KEY = normalizeServiceKey(process.env.APT_TRADE_SERVICE_KEY || SERVICE_KEY);

app.get("/api/finance/apt-trade", async (req, res) => {
  try {
    if (!req.query.lawdCd || !req.query.dealYmd) {
      return res.status(400).json({ ok: false, message: "lawdCd(법정동코드 5자리)와 dealYmd(계약년월 6자리)가 필요합니다." });
    }
    const url = new URL(APT_TRADE_BASE_URL + "/getRTMSDataSvcAptTradeDev");
    url.searchParams.set("serviceKey", APT_TRADE_SERVICE_KEY);
    url.searchParams.set("LAWD_CD", req.query.lawdCd);
    url.searchParams.set("DEAL_YMD", req.query.dealYmd);
    url.searchParams.set("pageNo", req.query.pageNo || "1");
    url.searchParams.set("numOfRows", req.query.numOfRows || "20");

    const { ok, text } = await fetchWithRetry(url.toString());
    if (!ok) {
      return res.status(502).json({
        ok: false,
        message: "아파트 실거래가 API가 계속 오류를 반환하고 있습니다. 잠시 후 다시 시도해 주세요.",
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
// AI 리서치 캐시 - 공식 API가 없거나(SGI/HUG), 숫자가 너무 자주 바뀌어서(LTV·DSR 규제)
// 우리가 직접 고정값으로 넣기 위험한 주제를, Claude에게 실제 웹검색을 시켜서 조사하고
// 그 결과를 캐싱해둔다. 한 달에 한 번 자동 갱신하고(상황 보고 주기 단축 가능),
// "AI가 웹검색으로 조사한 참고 정보"라는 출처와 조사 시각을 항상 같이 보여준다.
// ⚠️ 여전히 "합격/불합격 판정"은 하지 않는다 - 매달 갱신해도 그 사이 정책이 바뀔 수
// 있어, 숫자 하나 잘못 판정하면 실질적 피해로 이어질 수 있기 때문이다.
// =====================================================================
const RESEARCH_REFRESH_DAYS = 30; // 상황 보고 주기를 줄이고 싶으면 이 숫자만 줄이면 된다.

const RESEARCH_TOPICS = {
  "mortgage-regulation": {
    label: "주택담보대출 LTV·DTI·DSR 규제 현황",
    prompt:
      "실제 웹검색을 통해 대한민국의 2026년 현재 주택담보대출 LTV·DTI·DSR 규제 현황을 조사해서 정리해줘. " +
      "규제지역/비규제지역별 LTV 비율, 무주택자/1주택자/다주택자별 차이, 최근 1년 내 정책 변경 이력, " +
      "주택가격 구간별 절대 한도(있다면)를 포함해서 알려줘. 정확한 출처와 발표일도 같이 밝혀줘. " +
      "마크다운 문법은 쓰지 말고 평범한 문장으로 답해줘.",
  },
  "jeonse-guarantee-alt": {
    label: "SGI서울보증·HUG 전세보증 상품 정보",
    prompt:
      "실제 웹검색을 통해 SGI서울보증의 전세금안심대출보증과 주택도시보증공사(HUG)의 전세보증금반환보증 " +
      "상품에 대해 조사해서 정리해줘. 각각의 대상, 보증한도, 보증료율, 신청방법, 문의처를 포함해줘. " +
      "정확한 출처도 같이 밝혀줘. 마크다운 문법은 쓰지 말고 평범한 문장으로 답해줘.",
  },
};

const researchCache = {}; // { [topicId]: { text, fetchedAt } }

async function refreshResearchTopic(topicId) {
  const topic = RESEARCH_TOPICS[topicId];
  if (!topic || !anthropic) return;
  try {
    const model = process.env.AGENT_MODEL || "claude-sonnet-5";
    const response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: topic.prompt }],
    });
    const text = response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    researchCache[topicId] = { text: stripMarkdown(text), fetchedAt: Date.now() };
    console.log(`[리서치 캐시] "${topic.label}" 갱신 완료`, new Date().toISOString());
  } catch (err) {
    console.warn(`[리서치 캐시] "${topic.label}" 갱신 실패:`, err.message);
  }
}

async function getResearchTopic(topicId) {
  const cache = researchCache[topicId];
  const stale = !cache || Date.now() - cache.fetchedAt > RESEARCH_REFRESH_DAYS * 24 * 60 * 60 * 1000;
  if (stale) await refreshResearchTopic(topicId);
  return researchCache[topicId];
}

app.get("/api/research/:topicId", async (req, res) => {
  const topicId = req.params.topicId;
  if (!RESEARCH_TOPICS[topicId]) {
    return res.status(404).json({ ok: false, message: "알 수 없는 주제입니다." });
  }
  const cache = await getResearchTopic(topicId);
  if (!cache || !cache.text) {
    return res.status(503).json({ ok: false, message: "지금은 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
  }
  res.json({
    ok: true,
    topic: RESEARCH_TOPICS[topicId].label,
    text: cache.text,
    fetchedAt: cache.fetchedAt,
    refreshDays: RESEARCH_REFRESH_DAYS,
  });
});

// 고정 정보 DB를 일반 REST로도 노출 - "찾아보기" 화면 등 AI 에이전트가 아닌
// 곳에서도 같은 데이터를 재사용할 수 있게 한다.
app.get("/api/facts/fixed", (req, res) => {
  const q = req.query.q;
  const list = q ? searchFixedFacts(q) : FIXED_FACTS;
  res.json({ ok: true, facts: list.map(({ id, title, content, lastVerified }) => ({ id, title, content, lastVerified })) });
});

// =====================================================================
// 행정안전부_대한민국 공공서비스(혜택) 정보 (정부24, data.go.kr 15113968)
// ⚠️ 다른 API들과 게이트웨이가 다르다 (apis.data.go.kr가 아니라 api.odcloud.kr).
// 중앙부처+지자체는 이미 기존 복지서비스 API로 다루고 있어서 겹치므로, 여기서는
// "소관기관유형"으로 교육청·공공기관만 걸러서 보완용으로만 쓴다.
// =====================================================================
const GOV24_BASE_URL = process.env.GOV24_BASE_URL || "https://api.odcloud.kr/api";
const GOV24_SERVICE_KEY = normalizeServiceKey(process.env.GOV24_SERVICE_KEY || SERVICE_KEY);

async function toolSearchPublicBenefits({ keyword, orgType }) {
  const url = new URL(GOV24_BASE_URL + "/gov24/v3/serviceList");
  url.searchParams.set("serviceKey", GOV24_SERVICE_KEY);
  url.searchParams.set("page", "1");
  url.searchParams.set("perPage", "10");
  if (keyword) url.searchParams.set("cond[서비스명::LIKE]", keyword);
  // 기본값: 교육청+공공기관만 (기존 복지 API와 중복 방지). 명시적으로 orgType이 오면 그걸 우선한다.
  url.searchParams.set("cond[소관기관유형::LIKE]", orgType || "교육청");
  return fetchJsonOrXml(url.toString());
}

async function toolGetPublicBenefitDetail({ servId }) {
  const url = new URL(GOV24_BASE_URL + "/gov24/v3/serviceDetail");
  url.searchParams.set("serviceKey", GOV24_SERVICE_KEY);
  url.searchParams.set("page", "1");
  url.searchParams.set("perPage", "1");
  url.searchParams.set("cond[서비스ID::EQ]", servId);
  return fetchJsonOrXml(url.toString());
}

app.get("/api/welfare/gov24-list", async (req, res) => {
  try {
    const result = await toolSearchPublicBenefits({
      keyword: req.query.keyword,
      orgType: req.query.orgType,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ ok: false, message: "정부24 공공서비스 API 호출에 실패했습니다.", error: String(err) });
  }
});

// 최근 1개월(기본값) 이내에 등록되었거나 수정된 정부24 공공서비스(교육청/공공기관 중심).
// ⚠️ 기존 복지로(중앙부처/지자체) API에 같은 날짜 필드가 있는지는 아직 확인 전이라, 우선
// 정부24 카탈로그만 대상으로 한다.
app.get("/api/welfare/gov24-detail", async (req, res) => {
  try {
    if (!req.query.servId) {
      return res.status(400).json({ ok: false, message: "servId가 필요합니다." });
    }
    const result = await toolGetPublicBenefitDetail({ servId: req.query.servId });
    res.json(result);
  } catch (err) {
    res.status(502).json({ ok: false, message: "정부24 공공서비스 상세조회에 실패했습니다.", error: String(err) });
  }
});

app.get("/api/welfare/gov24-recent", async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const url = new URL(GOV24_BASE_URL + "/gov24/v3/serviceList");
    url.searchParams.set("serviceKey", GOV24_SERVICE_KEY);
    url.searchParams.set("page", "1");
    url.searchParams.set("perPage", "20");
    url.searchParams.set(`cond[수정일시::GTE]`, since);
    if (req.query.orgType) url.searchParams.set("cond[소관기관유형::LIKE]", req.query.orgType);

    const result = await fetchJsonOrXml(url.toString());
    res.json(result);
  } catch (err) {
    res.status(502).json({ ok: false, message: "정부24 최근 갱신 서비스 조회에 실패했습니다.", error: String(err) });
  }
});

// =====================================================================
// 쉬운 설명 카드 - 복지 상세 내용을 "한 장씩 넘기는 쉬운 말 카드"로 풀어준다 (앱에서 애니메이션+음성으로 재생).
// 원문(상세 내용)에 있는 사실만 쓰게 하고, 서버가 한 번 더 검증한다:
//  - 카드에 들어간 숫자가 원문에 없으면 지어낸 것으로 보고 그 카드를 버린다.
//  - 마지막 "꼭 확인하세요" 카드는 AI가 아니라 서버가 고정 문구로 붙인다.
// =====================================================================
const explainCache = new Map(); // 같은 상세 내용은 다시 만들지 않는다 (비용·대기시간 절약)

function numberTokens(str) {
  return (String(str).replace(/,/g, "").match(/\d+(\.\d+)?/g) || []);
}

app.post("/api/explain", async (req, res) => {
  if (!anthropic) return res.status(500).json({ ok: false, message: "AI 기능을 쓸 수 없습니다." });
  const title = String(req.body?.title || "").slice(0, 200);
  const sourceText = String(req.body?.text || "").trim().slice(0, 6000);
  if (sourceText.length < 20) return res.status(400).json({ ok: false, message: "설명할 상세 내용이 부족합니다." });

  const kind = req.body?.kind === "finance" ? "finance" : "welfare";
  const key = require("crypto").createHash("sha1").update(kind + "\n" + title + "\n" + sourceText).digest("hex");
  if (explainCache.has(key)) return res.json({ ok: true, cards: explainCache.get(key), cached: true });

  try {
    const response = await anthropic.messages.create({
      model: process.env.AGENT_MODEL || "claude-sonnet-5",
      max_tokens: 1200,
      system:
        "너는 " + (kind === "finance" ? "금융 상품·금리 정보" : "복지 서비스 설명") +
        "을 시각장애인·고령자·지적장애인도 이해할 수 있게 '한 장씩 넘기는 카드'로 바꾸는 도우미다.\n" +
        "[원문]에 있는 내용만 사용하라. 원문에 없는 금액·기한·조건·전화번호·사이트는 절대 만들지 마라. " +
        "숫자·금액·날짜·전화번호는 원문 표기 그대로 써라. 단위를 바꾸거나 환산하지 마라" +
        "(예: 원문이 1억5천만원이면 1.5억원이라고 바꾸지 말고 1억5천만원 그대로).\n" +
        "출력은 JSON 하나만: {\"cards\":[{\"icon\":\"이모지 1개\",\"heading\":\"짧은 제목(10자 이내)\",\"text\":\"1~2문장, 쉬운 말\"}]}\n" +
        (kind === "finance"
          ? "카드는 3~6장이고 순서는 (1)이 상품은 무엇인가요 (2)누가 이용할 수 있나요 (3)금리와 한도는 어떻게 되나요 " +
            "(4)어떻게 신청하나요 (5)어디에 물어보나요. 원문이 금리 통계·평균처럼 상품 설명이 아니면, 원문이 말하는 " +
            "수치가 무엇인지(예: 은행별 평균, 소득구간별)를 쉬운 말로 풀어 카드를 구성하라. 통계나 평균 수치를 " +
            "'내가 받는 금리'처럼 단정해서 쓰지 마라. 원문에 '보장하지 않는다', '참고용', '평균', '변동' 같은 " +
            "주의가 있으면 반드시 카드 한 장에 쉬운 말로 남겨라.\n"
          : "카드는 3~6장이고 순서는 (1)이 서비스는 무엇인가요 (2)누가 받을 수 있나요 (3)무엇을 받나요 " +
            "(4)어떻게 신청하나요 (5)어디에 물어보나요.\n") +
        "원문에 해당 정보가 없으면 그 카드는 만들지 마라. 카드 하나의 text는 70자 안팎으로 짧게. " +
        "어려운 행정용어·금융용어·한자어는 뜻이 바뀌지 않게 쉬운 말로 풀어라. 마크다운 금지. JSON 외의 다른 글은 쓰지 마라.",
      messages: [{ role: "user", content: `${kind === "finance" ? "상품·항목 이름" : "서비스 이름"}: ${title}\n\n[원문]\n${sourceText}` }],
    });
    let raw = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    raw = raw.replace(/```json|```/g, "").trim();
    const i = raw.indexOf("{");
    const j = raw.lastIndexOf("}");
    const parsed = JSON.parse(raw.slice(i, j + 1));

    const sourceNumbers = new Set(numberTokens(sourceText + " " + title));
    let dropped = 0;
    const cards = (Array.isArray(parsed.cards) ? parsed.cards : [])
      .filter((c) => c && typeof c.heading === "string" && typeof c.text === "string")
      .map((c) => ({
        icon: typeof c.icon === "string" && c.icon.length <= 4 ? c.icon : "📌",
        heading: stripMarkdown(c.heading).slice(0, 20),
        text: stripMarkdown(c.text).slice(0, 220),
      }))
      .filter((c) => {
        const ok = numberTokens(c.heading + " " + c.text).every((n) => sourceNumbers.has(n));
        if (!ok) dropped++;
        return ok;
      })
      .slice(0, 6);
    if (dropped > 0) console.warn(`[쉬운설명] 원문에 없는 숫자가 있는 카드 ${dropped}장을 버렸습니다: ${title}`);

    if (cards.length < 2) {
      return res.status(502).json({ ok: false, message: "쉬운 설명을 안전하게 만들지 못했습니다. 상세 내용을 직접 확인해 주세요." });
    }
    cards.push({
      icon: "⚠️",
      heading: "꼭 확인하세요",
      text:
        kind === "finance"
          ? "금리와 한도는 사람마다, 때마다 달라질 수 있어요. 신청하기 전에 은행이나 해당 기관에서 꼭 확인해 주세요."
          : "조건과 금액은 바뀔 수 있어요. 신청하기 전에 담당 기관에 한 번 더 확인해 주세요.",
    });
    if (explainCache.size > 200) explainCache.delete(explainCache.keys().next().value);
    explainCache.set(key, cards);
    res.json({ ok: true, cards });
  } catch (err) {
    console.error("쉬운 설명 생성 오류:", err);
    res.status(502).json({ ok: false, message: "쉬운 설명을 만들지 못했습니다. 잠시 후 다시 시도해 주세요." });
  }
});

app.listen(PORT, () => {
  console.log(`[welfare-proxy] http://localhost:${PORT} 에서 실행 중`);
  console.log(`[welfare-proxy] 데모 페이지: http://localhost:${PORT}/welfare_demo.html`);
});
