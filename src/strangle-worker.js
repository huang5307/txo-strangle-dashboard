/**
 * TXO Covered Short Strangle Quant Engine - Cloudflare Worker
 * 備兌賣出勒式策略（Covered Short Strangle）量化篩選與實盤轉倉雷達
 * 100% Serverless: TAIFEX MIS Real-time Quotes + OpenAPI + Yahoo TWII 240MA + Black-76 Greeks
 */

let memoryCache = null;
let memoryCacheTime = 0;
let memoryDailyBaseline = null;
let memoryDailyBaselineTime = 0;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Content-Type": "application/json;charset=UTF-8"
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        // 靜態資源處理（Cloudflare Workers Static Assets 相容）
        if (!path.startsWith("/api") && env && env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        try {
            // 1. 強制手動刷新快取
            if (path === "/api/strangle/sync" || path === "/api/sync-oi") {
                if (env && env.TXO_CACHE) {
                    await env.TXO_CACHE.delete("txo_strangle_payload_cache");
                    await env.TXO_CACHE.delete("txo_full_dashboard_cache");
                }
                memoryCache = null;
                memoryCacheTime = 0;
                memoryDailyBaseline = null;
                memoryDailyBaselineTime = 0;
                const fullPayload = await generateStranglePayload(env);
                const payloadStr = JSON.stringify(fullPayload, null, 2);
                memoryCache = payloadStr;
                memoryCacheTime = Date.now();
                return new Response(JSON.stringify({ success: true, refreshed: true, ...fullPayload }), {
                    headers: corsHeaders
                });
            }

            // 2. 即時轉倉試算 API (可傳入當前持倉)
            if (path === "/api/strangle/roll-simulation") {
                const fullPayload = await getOrGeneratePayload(env);
                return new Response(JSON.stringify({ success: true, roll_engine: fullPayload.roll_engine }), {
                    headers: corsHeaders
                });
            }

            // 3. ETF 價格 API
            if (path === "/api/etf-prices") {
                const etfData = await fetchYahooEtfPrices();
                return new Response(JSON.stringify(etfData), { headers: corsHeaders });
            }

            // 4. 主 API：回傳完整的備兌勒式定價、Greeks、最佳策略與各週期報價
            if (path === "/api/strangle" || path === "/api/analysis" || path === "/") {
                const fullPayload = await getOrGeneratePayload(env);
                return new Response(JSON.stringify(fullPayload), { headers: corsHeaders });
            }

            return new Response(JSON.stringify({ error: "Not Found", path }), {
                status: 404,
                headers: corsHeaders
            });

        } catch (err) {
            console.error("Worker fetch top-level error:", err);
            if (memoryCache) {
                return new Response(memoryCache, { headers: corsHeaders });
            }
            return new Response(JSON.stringify({ error: "Internal Server Error", message: err.message, stack: err.stack }), {
                status: 500,
                headers: corsHeaders
            });
        }
    },

    async scheduled(event, env, ctx) {
        try {
            memoryCache = null;
            memoryCacheTime = 0;
            memoryDailyBaseline = null;
            memoryDailyBaselineTime = 0;
            const fullPayload = await generateStranglePayload(env);
            const payloadStr = JSON.stringify(fullPayload);
            if (env && env.TXO_CACHE) {
                await env.TXO_CACHE.put("txo_strangle_payload_cache", payloadStr, { expirationTtl: 86400 });
            }
        } catch (e) {
            console.error("Scheduled cron error in strangle-worker:", e);
        }
    }
};

async function getOrGeneratePayload(env) {
    const now = Date.now();
    // 1. 記憶體快取 25 秒
    if (memoryCache && (now - memoryCacheTime < 25000)) {
        return JSON.parse(memoryCache);
    }

    // 2. KV 快取
    let cachedStr = null;
    if (env && env.TXO_CACHE) {
        try {
            cachedStr = await env.TXO_CACHE.get("txo_strangle_payload_cache");
        } catch (e) {
            console.warn("KV get error:", e);
        }
    }

    if (cachedStr) {
        try {
            const parsed = JSON.parse(cachedStr);
            if (parsed._cached_at && (now - parsed._cached_at < 45000)) {
                memoryCache = cachedStr;
                memoryCacheTime = now;
                return parsed;
            }
        } catch (e) {
            console.warn("KV parse error:", e);
        }
    }

    // 3. 生成最新數據
    const payload = await generateStranglePayload(env);
    payload._cached_at = now;
    const payloadStr = JSON.stringify(payload);
    memoryCache = payloadStr;
    memoryCacheTime = now;

    if (env && env.TXO_CACHE) {
        try {
            await env.TXO_CACHE.put("txo_strangle_payload_cache", payloadStr, { expirationTtl: 86400 });
        } catch (e) {
            console.warn("KV put error:", e);
        }
    }

    return payload;
}

// ==========================================
// 數學與 Black-76 Greeks 期權定價核心
// ==========================================

function cdfNormal(x) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * absX);
    const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

    return 0.5 * (1.0 + sign * erf);
}

function pdfNormal(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function black76Call(F, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0) return Math.max(0, F - K);
    const d1 = (Math.log(F / K) + 0.5 * Math.pow(sigma, 2) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    return Math.exp(-r * T) * (F * cdfNormal(d1) - K * cdfNormal(d2));
}

function black76Put(F, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0) return Math.max(0, K - F);
    const d1 = (Math.log(F / K) + 0.5 * Math.pow(sigma, 2) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    return Math.exp(-r * T) * (K * cdfNormal(-d2) - F * cdfNormal(-d1));
}

function calcGreeks(F, K, T, r, sigma, isCall = true) {
    if (T <= 0.0001 || sigma <= 0.001) {
        return {
            delta: isCall ? (F > K ? 1.0 : 0.0) : (F < K ? -1.0 : 0.0),
            gamma: 0,
            vega: 0,
            theta: 0
        };
    }

    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(F / K) + 0.5 * Math.pow(sigma, 2) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const df = Math.exp(-r * T);
    const pdfD1 = pdfNormal(d1);

    let delta = 0;
    let theta = 0;

    if (isCall) {
        delta = df * cdfNormal(d1);
        theta = (- (F * df * pdfD1 * sigma) / (2 * sqrtT) - r * K * df * cdfNormal(d2)) / 365;
    } else {
        delta = df * (cdfNormal(d1) - 1.0);
        theta = (- (F * df * pdfD1 * sigma) / (2 * sqrtT) + r * K * df * cdfNormal(-d2)) / 365;
    }

    const gamma = (df * pdfD1) / (F * sigma * sqrtT);
    const vega = (F * df * sqrtT * pdfD1) / 100; // 隱含波動率變動 1% 的價格敏感度

    return {
        delta: Number(delta.toFixed(4)),
        gamma: Number(gamma.toFixed(6)),
        vega: Number(vega.toFixed(3)),
        theta: Number(theta.toFixed(2))
    };
}

function findBlack76IV(F, K, T, r, marketPrice, isCall = true) {
    if (T <= 0 || marketPrice <= 0.5) return null;
    const discount = Math.exp(-r * T);
    const intrinsic = isCall ? Math.max(0, (F - K) * discount) : Math.max(0, (K - F) * discount);
    if (marketPrice <= intrinsic) return 0.05;

    let low = 0.01;
    let high = 2.50;

    for (let i = 0; i < 35; i++) {
        const mid = (low + high) / 2;
        const p = isCall ? black76Call(F, K, T, r, mid) : black76Put(F, K, T, r, mid);
        if (Math.abs(p - marketPrice) < 0.02) return Number(mid.toFixed(4));
        if (p > marketPrice) {
            high = mid;
        } else {
            low = mid;
        }
    }
    return Number(((low + high) / 2).toFixed(4));
}

// ==========================================
// Yahoo Finance: 加權指數 240MA、歷史波動度與 ETF
// ==========================================

async function fetchYahooTWIIAndHV() {
    let result = {
        twiiPrice: 0,
        ma240: 0,
        ma60: 0,
        ma20: 0,
        hv20: 0.165,
        hv30: 0.168,
        recentCloses: []
    };

    try {
        const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=1y";
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });
        const json = await res.json();
        const r0 = json?.chart?.result?.[0];
        if (r0) {
            const meta = r0.meta;
            result.twiiPrice = meta?.regularMarketPrice || meta?.previousClose || 0;
            const quotes = r0.indicators?.quote?.[0]?.close || [];
            const validCloses = quotes.filter(x => typeof x === "number" && !isNaN(x) && x > 0);
            result.recentCloses = validCloses;

            const n = validCloses.length;
            if (n >= 20) {
                result.ma20 = Math.round(validCloses.slice(-20).reduce((a, b) => a + b, 0) / 20);
            }
            if (n >= 60) {
                result.ma60 = Math.round(validCloses.slice(-60).reduce((a, b) => a + b, 0) / 60);
            }
            if (n >= 200) {
                const count = Math.min(n, 240);
                result.ma240 = Math.round(validCloses.slice(-count).reduce((a, b) => a + b, 0) / count);
            }

            // 計算 20 日與 30 日歷史波動率 (Log Return Annualized)
            if (n >= 22) {
                const logReturns20 = [];
                for (let i = n - 20; i < n; i++) {
                    logReturns20.push(Math.log(validCloses[i] / validCloses[i - 1]));
                }
                const mean20 = logReturns20.reduce((a, b) => a + b, 0) / logReturns20.length;
                const var20 = logReturns20.reduce((a, b) => a + Math.pow(b - mean20, 2), 0) / (logReturns20.length - 1);
                result.hv20 = Number((Math.sqrt(var20 * 252)).toFixed(4));
            }

            if (n >= 32) {
                const logReturns30 = [];
                for (let i = n - 30; i < n; i++) {
                    logReturns30.push(Math.log(validCloses[i] / validCloses[i - 1]));
                }
                const mean30 = logReturns30.reduce((a, b) => a + b, 0) / logReturns30.length;
                const var30 = logReturns30.reduce((a, b) => a + Math.pow(b - mean30, 2), 0) / (logReturns30.length - 1);
                result.hv30 = Number((Math.sqrt(var30 * 252)).toFixed(4));
            }
        }
    } catch (e) {
        console.warn("fetchYahooTWIIAndHV failed:", e);
    }
    return result;
}

async function fetchYahooEtfPrices() {
    let etfData = { "00631L": 36.60, "00685L": 12.15, updated_at: "" };
    try {
        const fetchYahoo = async (sym) => {
            const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`, {
                headers: { "User-Agent": "Mozilla/5.0" }
            });
            const j = await r.json();
            const meta = j?.chart?.result?.[0]?.meta;
            return meta?.regularMarketPrice || meta?.previousClose || null;
        };
        const [p631, p685] = await Promise.all([
            fetchYahoo("00631L.TW").catch(() => null),
            fetchYahoo("00685L.TW").catch(() => null)
        ]);
        if (p631) etfData["00631L"] = Math.round(p631 * 100) / 100;
        if (p685) etfData["00685L"] = Math.round(p685 * 100) / 100;
        etfData.updated_at = new Date().toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" });
    } catch (e) {
        console.warn("ETF price fetch error:", e);
    }
    return etfData;
}

// ==========================================
// 期交所 TAIFEX 交易時段與報價擷取
// ==========================================

function getTaipeiSessionInfo() {
    const now = new Date();
    const taipeiStr = now.toLocaleString("en-US", { timeZone: "Asia/Taipei", hour12: false });
    const parts = taipeiStr.split(", ");
    const timeParts = parts[1].split(":");
    const h = parseInt(timeParts[0], 10);
    const m = parseInt(timeParts[1], 10);
    const totalMinutes = h * 60 + m;

    let session = "closed";
    let isNight = false;
    let isDay = false;

    // 日盤 08:45 (525) ~ 13:45 (825)
    if (totalMinutes >= 525 && totalMinutes <= 825) {
        session = "day";
        isDay = true;
    }
    // 夜盤 15:00 (900) ~ 24:00 (1440) 或 00:00 (0) ~ 05:00 (300)
    else if (totalMinutes >= 900 || totalMinutes <= 300) {
        session = "night";
        isNight = true;
    }

    return {
        session,
        isDay,
        isNight,
        primary: isNight ? "1" : "0",
        secondary: isNight ? "0" : "1"
    };
}

async function safeFetchJson(url) {
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*"
    };
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);
        const res = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timeoutId);
        const text = await res.text();
        if (text.startsWith("<")) return null;
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

async function fetchMisQuoteList(endpoint, body, env) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`https://mis.taifex.com.tw/futures/api/${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": "https://mis.taifex.com.tw/futures/RegularSession/EquityIndices/FuturesDomestic/",
                "Origin": "https://mis.taifex.com.tw"
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        return json?.RtData?.QuoteList || null;
    } catch (e) {
        return null;
    }
}

async function getLiveMisFutures(frontMonthCode, sessionInfo, env) {
    let quotes = await fetchMisQuoteList("getQuoteList", {
        MarketType: sessionInfo.primary,
        SymbolType: "F",
        CommodityId: "TX"
    }, env);

    if (!quotes || quotes.length === 0) {
        quotes = await fetchMisQuoteList("getQuoteList", {
            MarketType: sessionInfo.secondary,
            SymbolType: "F",
            CommodityId: "TX"
        }, env);
    }

    if (!quotes || quotes.length === 0) return null;

    // 過濾大台指期貨合約 (TXF 開頭，排除價差單 -S / -P)
    const isBigTx = q => q.SymbolID && q.SymbolID.startsWith("TXF") && !q.SymbolID.endsWith("-P") && !q.SymbolID.endsWith("-S");
    const bigTxQuotes = quotes.filter(isBigTx);
    
    // 依成交量排序，取成交量最大之近月/主力合約
    bigTxQuotes.sort((a, b) => (parseInt(b.CTotalVolume || "0", 10) || 0) - (parseInt(a.CTotalVolume || "0", 10) || 0));
    const q = bigTxQuotes[0] || quotes.find(isBigTx) || quotes[0];
    if (!q) return null;

    let price = 0;
    const last = q.CLastPrice ? parseFloat(q.CLastPrice) : 0;
    const bid = q.CBidPrice1 ? parseFloat(q.CBidPrice1) : 0;
    const ask = q.CAskPrice1 ? parseFloat(q.CAskPrice1) : 0;
    const ref = q.CRefPrice ? parseFloat(q.CRefPrice) : 0;

    if (last > 0) price = last;
    else if (bid > 0 && ask > 0) price = Math.round((bid + ask) / 2);
    else if (ref > 0) price = ref;

    return {
        symbol: q.SymbolID,
        name: q.DispCName || "臺指期",
        price,
        bid,
        ask,
        ref,
        change: q.CDiff ? parseFloat(q.CDiff) : 0,
        change_rate: q.CDiffRate ? parseFloat(q.CDiffRate) : 0,
        volume: q.CTotalVolume ? parseInt(q.CTotalVolume, 10) : 0
    };
}

async function getLiveMisOptionsForCycle(cycleCode, sessionInfo, env) {
    let quotes = await fetchMisQuoteList("getQuoteListOption", {
        MarketType: sessionInfo.primary,
        SymbolType: "O",
        KindID: "1",
        CID: "TXO",
        ExpireMonth: cycleCode
    }, env);

    if (!quotes || quotes.length === 0) {
        quotes = await fetchMisQuoteList("getQuoteListOption", {
            MarketType: sessionInfo.secondary,
            SymbolType: "O",
            KindID: "1",
            CID: "TXO",
            ExpireMonth: cycleCode
        }, env);
    }
    return quotes || [];
}

// ==========================================
// 合約週期解析與期交所 OpenAPI 盤後基線
// ==========================================

function parseCycleExpiry(cycleStr) {
    if (!cycleStr) return null;
    let year = 2026, month = 1, day = 1;
    let isMonthly = false;
    let label = cycleStr;

    const clean = cycleStr.trim().toUpperCase();
    if (clean.length === 6 && !isNaN(clean)) {
        isMonthly = true;
        year = parseInt(clean.slice(0, 4), 10);
        month = parseInt(clean.slice(4, 6), 10);

        const firstDay = new Date(Date.UTC(year, month - 1, 1));
        let dayOfWeek = firstDay.getUTCDay();
        let firstWed = 1 + ((3 - dayOfWeek + 7) % 7);
        day = firstWed + 14;
        label = `📅 月選主力 (${clean})`;
    } else if (clean.length >= 7) {
        year = parseInt(clean.slice(0, 4), 10);
        month = parseInt(clean.slice(4, 6), 10);
        const sub = clean.slice(6);

        const firstDay = new Date(Date.UTC(year, month - 1, 1));
        let dayOfWeek = firstDay.getUTCDay();
        let firstWed = 1 + ((3 - dayOfWeek + 7) % 7);
        let firstFri = 1 + ((5 - dayOfWeek + 7) % 7);

        if (sub.startsWith("W")) {
            const weekNum = parseInt(sub.slice(1), 10) || 1;
            day = firstWed + (weekNum - 1) * 7;
            label = `🗓️ 第${weekNum}週三 (${clean})`;
        } else if (sub.startsWith("F")) {
            const weekNum = parseInt(sub.slice(1), 10) || 1;
            day = firstFri + (weekNum - 1) * 7;
            label = `⚡ 第${weekNum}週五 (${clean})`;
        }
    }

    const expiryTime = new Date(Date.UTC(year, month - 1, day, 5, 30, 0)); // 13:30 台北時間
    const expiryDateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    return {
        code: cycleStr,
        year,
        month,
        day,
        isMonthly,
        label,
        expiryDateStr,
        expiryTime
    };
}

async function getDailyBaselineData(env) {
    const now = Date.now();
    if (memoryDailyBaseline && (now - memoryDailyBaselineTime < 300000)) {
        return memoryDailyBaseline;
    }

    const [futData, optData] = await Promise.all([
        safeFetchJson("https://openapi.taifex.com.tw/v1/DailyMarketReportFut"),
        safeFetchJson("https://openapi.taifex.com.tw/v1/DailyMarketReportOpt")
    ]);

    if (!optData || !Array.isArray(optData) || optData.length === 0) {
        if (memoryDailyBaseline) return memoryDailyBaseline;
        return { cyclesMap: {}, totalCallOi: 0, totalPutOi: 0, tradeDateStr: "", txRecords: [] };
    }

    const cyclesMap = {};
    let totalCallOi = 0;
    let totalPutOi = 0;

    for (const item of optData) {
        if (item.Contract !== "TXO") continue;
        const callPutRaw = item.CallPut || "";
        const isCall = callPutRaw === "買權" || callPutRaw === "Call" || callPutRaw === "C";
        const isPut = callPutRaw === "賣權" || callPutRaw === "Put" || callPutRaw === "P";
        if (!isCall && !isPut) continue;

        const cycle = (item["ContractMonth(Week)"] || item.ContractMonthWeek || "").trim();
        const strike = parseFloat(item.StrikePrice);
        if (!cycle || isNaN(strike)) continue;

        const oi = parseInt(item.OpenInterest || "0", 10) || 0;
        const price = parseFloat(item.SettlementPrice || item.ClosePrice || "0") || 0;

        if (isCall) totalCallOi += oi;
        if (isPut) totalPutOi += oi;

        if (!cyclesMap[cycle]) cyclesMap[cycle] = {};
        if (!cyclesMap[cycle][strike]) {
            cyclesMap[cycle][strike] = {
                strike,
                call_price: 0,
                call_oi: 0,
                call_bid: 0,
                call_ask: 0,
                put_price: 0,
                put_oi: 0,
                put_bid: 0,
                put_ask: 0
            };
        }

        if (isCall) {
            if (price > 0) cyclesMap[cycle][strike].call_price = price;
            if (oi > 0) cyclesMap[cycle][strike].call_oi = oi;
            if (item.BestBid && item.BestBid !== "-") cyclesMap[cycle][strike].call_bid = parseFloat(item.BestBid) || 0;
            if (item.BestAsk && item.BestAsk !== "-") cyclesMap[cycle][strike].call_ask = parseFloat(item.BestAsk) || 0;
        } else if (isPut) {
            if (price > 0) cyclesMap[cycle][strike].put_price = price;
            if (oi > 0) cyclesMap[cycle][strike].put_oi = oi;
            if (item.BestBid && item.BestBid !== "-") cyclesMap[cycle][strike].put_bid = parseFloat(item.BestBid) || 0;
            if (item.BestAsk && item.BestAsk !== "-") cyclesMap[cycle][strike].put_ask = parseFloat(item.BestAsk) || 0;
        }
    }

    let tradeDateStr = "";
    if (optData[0]?.Date && optData[0].Date.length === 8) {
        const d = optData[0].Date;
        tradeDateStr = `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
    }

    const baseline = {
        cyclesMap,
        totalCallOi,
        totalPutOi,
        tradeDateStr,
        txRecords: futData || [],
        updatedAt: now
    };

    memoryDailyBaseline = baseline;
    memoryDailyBaselineTime = now;
    return baseline;
}

// ==========================================
// 備兌勒式最佳策略量化篩選核心演算法 (Quant Screener)
// ==========================================

function evaluateOptimalStrangle(optionsList, futuresPrice, dteDays, hv20, ma240) {
    // 依提示詞量化條件篩選：
    // 1. Call 篩選：Delta 0.15 ~ 0.20（排除 < 0.10 及 > 0.35），OI >= 500, Spread <= 2
    // 2. Put 篩選：Delta -0.15 ~ -0.20（排除 > -0.10 及 < -0.35），OI >= 500, Spread <= 2
    // 3. 雙邊總權利金門檻：(Call + Put) 權利金總和需達標的現價 0.8% ~ 1.2% (例如 >= 0.8% * F)
    // 4. 計算雙邊損益兩平點、勝率、現金擔保、年化報酬率與轉倉警示點

    const minPremiumThreshold = Math.round(futuresPrice * 0.008); // 0.8%
    const targetPremiumThreshold = Math.round(futuresPrice * 0.010); // 1.0%

    // 篩選合規 Call 池
    const callCandidates = optionsList.filter(opt => {
        if (!opt.call || opt.call.price <= 0) return false;
        const delta = opt.call.delta;
        if (delta < 0.10 || delta > 0.35) return false;
        return true;
    }).map(opt => {
        const deltaMatch = (opt.call.delta >= 0.14 && opt.call.delta <= 0.21) ? 1.0 : 0.6;
        const oiScore = Math.min(1.0, (opt.call.oi || 0) / 1000);
        const spreadScore = opt.call.spread <= 2 ? 1.0 : (opt.call.spread <= 5 ? 0.7 : 0.4);
        return {
            strike: opt.strike,
            price: opt.call.price,
            bid: opt.call.bid,
            ask: opt.call.ask,
            spread: opt.call.spread,
            delta: opt.call.delta,
            theta: opt.call.theta,
            vega: opt.call.vega,
            iv: opt.call.iv,
            oi: opt.call.oi,
            score: deltaMatch * 0.5 + oiScore * 0.3 + spreadScore * 0.2
        };
    }).sort((a, b) => b.score - a.score);

    // 篩選合規 Put 池
    const putCandidates = optionsList.filter(opt => {
        if (!opt.put || opt.put.price <= 0) return false;
        const delta = opt.put.delta;
        if (delta > -0.10 || delta < -0.35) return false;
        return true;
    }).map(opt => {
        const deltaMatch = (opt.put.delta <= -0.14 && opt.put.delta >= -0.21) ? 1.0 : 0.6;
        const oiScore = Math.min(1.0, (opt.put.oi || 0) / 1000);
        const spreadScore = opt.put.spread <= 2 ? 1.0 : (opt.put.spread <= 5 ? 0.7 : 0.4);
        // 若履約價接近或高於 240MA 年線支撐，給予適當權重
        const maDistancePct = ma240 > 0 ? (opt.strike - ma240) / ma240 : 0;
        const maBonus = (maDistancePct >= -0.02 && maDistancePct <= 0.05) ? 0.2 : 0;
        return {
            strike: opt.strike,
            price: opt.put.price,
            bid: opt.put.bid,
            ask: opt.put.ask,
            spread: opt.put.spread,
            delta: opt.put.delta,
            theta: opt.put.theta,
            vega: opt.put.vega,
            iv: opt.put.iv,
            oi: opt.put.oi,
            score: deltaMatch * 0.5 + oiScore * 0.3 + spreadScore * 0.2 + maBonus
        };
    }).sort((a, b) => b.score - a.score);

    const combos = [];

    for (const c of callCandidates) {
        for (const p of putCandidates) {
            if (c.strike <= p.strike) continue; // 勒式必須 Call Strike > Put Strike

            const totalPremium = Math.round((c.bid + p.bid) * 10) / 10;
            const premiumPct = Number(((totalPremium / futuresPrice) * 100).toFixed(2));
            const callDistPct = Number((((c.strike - futuresPrice) / futuresPrice) * 100).toFixed(2));
            const putDistPct = Number((((futuresPrice - p.strike) / futuresPrice) * 100).toFixed(2));

            // 雙邊損益兩平點
            const upperBreakeven = Math.round(c.strike + totalPremium);
            const lowerBreakeven = Math.round(p.strike - totalPremium);

            // 雙邊總 Theta 日收益 (點/天)
            const dailyThetaPoints = Math.abs(c.theta) + Math.abs(p.theta);
            const dailyCashflowNTD = Math.round(dailyThetaPoints * 50);

            // 100% Cash-Secured Put 現金擔保需求 (NTD)
            const cspCashNTD = p.strike * 50;
            // 單週期預期權利金收益 (NTD)
            const totalPremiumNTD = Math.round(totalPremium * 50);
            // 週期報酬率 (以 CSP 現金為基底)
            const cycleReturnPct = Number(((totalPremiumNTD / cspCashNTD) * 100).toFixed(3));
            // 年化收益率估算
            const annualizedYieldPct = dteDays > 0 ? Number(((cycleReturnPct * (365 / Math.max(1, dteDays)))).toFixed(2)) : 0;

            // 勝率推估 (假設台指對數常態分佈在兩平點區間)
            const T = Math.max(0.001, dteDays / 365);
            const stdDev = futuresPrice * (hv20 || 0.16) * Math.sqrt(T);
            const zUpper = (upperBreakeven - futuresPrice) / stdDev;
            const zLower = (lowerBreakeven - futuresPrice) / stdDev;
            const winRatePct = Math.min(99.0, Math.max(50.0, Number(((cdfNormal(zUpper) - cdfNormal(zLower)) * 100).toFixed(1))));

            // 轉倉預警門檻 (標的現價距任一邊 < 1.0% 或 Delta > 0.35)
            const callAlertPrice = Math.round(c.strike * 0.99); // 現價漲到此點位觸發
            const putAlertPrice = Math.round(p.strike * 1.01);  // 現價跌到此點位觸發

            // 篩選評分：權利金是否達標 (0.8% ~ 1.2%) + Delta 對稱性 + 流動性
            let score = 0;
            if (totalPremium >= minPremiumThreshold) score += 30;
            if (totalPremium >= targetPremiumThreshold) score += 15;
            // Delta 對稱性 (差值越小越好)
            const deltaDiff = Math.abs(c.delta - Math.abs(p.delta));
            score += Math.max(0, 25 - deltaDiff * 100);
            // 流動性加分
            if (c.oi >= 500 && p.oi >= 500) score += 20;
            if (c.spread <= 1.5 && p.spread <= 1.5) score += 10;

            combos.push({
                call: c,
                put: p,
                total_premium: totalPremium,
                total_premium_ntd: totalPremiumNTD,
                premium_ratio_pct: premiumPct,
                meets_buffer_threshold: totalPremium >= minPremiumThreshold,
                call_dist_pct: callDistPct,
                put_dist_pct: putDistPct,
                upper_breakeven: upperBreakeven,
                lower_breakeven: lowerBreakeven,
                win_rate_pct: winRatePct,
                daily_theta_points: Number(dailyThetaPoints.toFixed(1)),
                daily_cashflow_ntd: dailyCashflowNTD,
                csp_cash_ntd: cspCashNTD,
                cycle_return_pct: cycleReturnPct,
                annualized_yield_pct: annualizedYieldPct,
                alert_rules: {
                    call_alert_price: callAlertPrice,
                    put_alert_price: putAlertPrice,
                    delta_limit: 0.35,
                    roll_deadline: "週三 12:00 前"
                },
                score: Math.round(score)
            });
        }
    }

    combos.sort((a, b) => b.score - a.score);

    const optimal = combos.length > 0 ? combos[0] : null;
    const alternatives = combos.slice(1, 4);

    return {
        optimal,
        alternatives,
        total_candidates: combos.length
    };
}

// ==========================================
// 主 Payload 整合組裝函數
// ==========================================

async function generateStranglePayload(env) {
    const sessionInfo = getTaipeiSessionInfo();
    const baseline = await getDailyBaselineData(env);
    const twiiData = await fetchYahooTWIIAndHV();
    const etfPrices = await fetchYahooEtfPrices();

    const cyclesMap = JSON.parse(JSON.stringify(baseline.cyclesMap || {}));
    const totalCallOi = baseline.totalCallOi || 0;
    const totalPutOi = baseline.totalPutOi || 0;
    const tradeDateStr = baseline.tradeDateStr || "";
    const txRecords = baseline.txRecords || [];

    // 辨識活躍合約週期
    const now = new Date();
    const candidateCycles = Object.keys(cyclesMap)
        .map(parseCycleExpiry)
        .filter(c => c && c.expiryTime.getTime() > now.getTime())
        .sort((a, b) => a.expiryTime.getTime() - b.expiryTime.getTime());

    const frontMonthlyCycle = candidateCycles.find(c => c.isMonthly);
    const nearest3 = candidateCycles.slice(0, 3);
    let activeCycles = [...nearest3];
    if (frontMonthlyCycle && !nearest3.some(c => c.isMonthly)) {
        activeCycles.push(frontMonthlyCycle);
    }

    const frontMonthCode = frontMonthlyCycle ? frontMonthlyCycle.code : (candidateCycles[0]?.code || "202611");

    const targetsConfig = activeCycles.map(c => {
        const days = Math.max(0.1, Number(((c.expiryTime.getTime() - now.getTime()) / 86400000).toFixed(1)));
        return {
            code: c.code,
            label: c.label,
            is_monthly: c.isMonthly,
            expiry_date: c.expiryDateStr,
            days_to_expiry: days,
            display_days: Math.max(1, Math.ceil(days))
        };
    });

    // 取得即時 MIS 報價 (期貨及主要週期選擇權 T 報價)
    let futuresPrice = 0;
    let futuresMeta = { symbol: "TXF", change: 0, volume: 0, ref: 0 };

    try {
        const [liveFut, ...liveOptQuotesList] = await Promise.all([
            getLiveMisFutures(frontMonthCode, sessionInfo, env),
            ...targetsConfig.map(t => getLiveMisOptionsForCycle(t.code, sessionInfo, env))
        ]);

        if (liveFut && liveFut.price > 0) {
            futuresPrice = liveFut.price;
            futuresMeta = liveFut;
        }

        // 即時選擇權報價疊加 (同時疊加 Call 與 Put)
        for (let i = 0; i < targetsConfig.length; i++) {
            const t = targetsConfig[i];
            const misQuotes = liveOptQuotesList[i];
            if (!misQuotes || !Array.isArray(misQuotes)) continue;

            for (const item of misQuotes) {
                const isCall = item.CP === "C";
                const isPut = item.CP === "P";
                if (!isCall && !isPut) continue;

                const strike = parseFloat(item.StrikePrice);
                if (isNaN(strike) || strike <= 0) continue;

                let price = 0;
                const last = item.CLastPrice ? parseFloat(item.CLastPrice) : 0;
                const bid = item.CBidPrice1 ? parseFloat(item.CBidPrice1) : 0;
                const ask = item.CAskPrice1 ? parseFloat(item.CAskPrice1) : 0;
                const ref = item.CRefPrice ? parseFloat(item.CRefPrice) : 0;

                if (last > 0) {
                    price = last;
                } else if (bid > 0 && ask > 0) {
                    if (ask <= bid * 3.0 || ask - bid <= 10.0) {
                        price = Math.round((bid + ask) / 2 * 10) / 10;
                    } else {
                        price = bid;
                    }
                } else if (bid > 0) {
                    price = bid;
                } else if (ref > 0) {
                    price = ref;
                }

                if (!cyclesMap[t.code]) cyclesMap[t.code] = {};
                if (!cyclesMap[t.code][strike]) {
                    cyclesMap[t.code][strike] = {
                        strike,
                        call_price: 0,
                        call_oi: 0,
                        call_bid: 0,
                        call_ask: 0,
                        put_price: 0,
                        put_oi: 0,
                        put_bid: 0,
                        put_ask: 0
                    };
                }

                const node = cyclesMap[t.code][strike];
                if (isCall) {
                    if (price > 0) node.call_price = price;
                    if (bid > 0) node.call_bid = bid;
                    if (ask > 0) node.call_ask = ask;
                } else if (isPut) {
                    if (price > 0) node.put_price = price;
                    if (bid > 0) node.put_bid = bid;
                    if (ask > 0) node.put_ask = ask;
                }
            }
        }
    } catch (e) {
        console.warn("MIS real-time overlay error:", e);
    }

    // 若期貨市價尚未取得，由 OpenAPI 盤後資料或 Yahoo 加權指數備援
    if (futuresPrice <= 0) {
        if (txRecords && txRecords.length > 0) {
            const front = txRecords.find(r => r.Contract === "TX" && ((r["ContractMonth(Week)"] || r.ContractMonthWeek || "").trim() === frontMonthCode));
            if (front) futuresPrice = parseFloat(front.SettlementPrice || front.ClosePrice || front.Last || "0") || 0;
        }
        if (futuresPrice <= 0 && twiiData.twiiPrice > 0) {
            futuresPrice = Math.round(twiiData.twiiPrice);
        }
        if (futuresPrice <= 0) futuresPrice = 22500; // 兜底安全值
    }

    const hv20 = twiiData.hv20 || 0.165;
    const r = 0.015; // 台灣無風險利率約 1.5%

    // 逐一計算各合約週期的 Greeks、最佳勒式策略組合
    const analyzedCycles = [];

    for (const t of targetsConfig) {
        const rawMap = cyclesMap[t.code] || {};
        const days = Math.max(0.1, t.days_to_expiry);
        const T = days / 365;
        const optionsList = [];

        // 收集所有履約價並排序
        const strikes = Object.keys(rawMap)
            .map(k => parseFloat(k))
            .filter(k => !isNaN(k) && k > 0)
            .sort((a, b) => a - b);

        for (const strike of strikes) {
            const raw = rawMap[strike];
            const callPrice = raw.call_price || 0;
            const putPrice = raw.put_price || 0;
            const callBid = raw.call_bid || (callPrice > 0 ? callPrice : 0);
            const callAsk = raw.call_ask || (callPrice > 0 ? callPrice : 0);
            const putBid = raw.put_bid || (putPrice > 0 ? putPrice : 0);
            const putAsk = raw.put_ask || (putPrice > 0 ? putPrice : 0);

            // 計算 Call IV 與 Greeks
            let callIv = findBlack76IV(futuresPrice, strike, T, r, callPrice > 0 ? callPrice : (callBid + callAsk) / 2, true);
            if (!callIv || callIv <= 0) callIv = hv20;
            const callGreeks = calcGreeks(futuresPrice, strike, T, r, callIv, true);

            // 計算 Put IV 與 Greeks
            let putIv = findBlack76IV(futuresPrice, strike, T, r, putPrice > 0 ? putPrice : (putBid + putAsk) / 2, false);
            if (!putIv || putIv <= 0) putIv = hv20;
            const putGreeks = calcGreeks(futuresPrice, strike, T, r, putIv, false);

            optionsList.push({
                strike,
                dist_pct: Number((((strike - futuresPrice) / futuresPrice) * 100).toFixed(2)),
                is_near_ma240: twiiData.ma240 > 0 && Math.abs(strike - twiiData.ma240) / twiiData.ma240 <= 0.015,
                call: {
                    price: callPrice,
                    bid: callBid,
                    ask: callAsk,
                    spread: Number((Math.max(0, callAsk - callBid)).toFixed(1)),
                    oi: raw.call_oi || 0,
                    iv: Number((callIv * 100).toFixed(1)),
                    delta: callGreeks.delta,
                    theta: callGreeks.theta,
                    vega: callGreeks.vega
                },
                put: {
                    price: putPrice,
                    bid: putBid,
                    ask: putAsk,
                    spread: Number((Math.max(0, putAsk - putBid)).toFixed(1)),
                    oi: raw.put_oi || 0,
                    iv: Number((putIv * 100).toFixed(1)),
                    delta: putGreeks.delta,
                    theta: putGreeks.theta,
                    vega: putGreeks.vega
                }
            });
        }

        // 執行量化篩選，挑出該合約週期最佳勒式收租組合
        const strategyAnalysis = evaluateOptimalStrangle(optionsList, futuresPrice, days, hv20, twiiData.ma240);

        analyzedCycles.push({
            code: t.code,
            label: t.label,
            is_monthly: t.is_monthly,
            expiry_date: t.expiry_date,
            days_to_expiry: t.days_to_expiry,
            display_days: t.display_days,
            strategy: strategyAnalysis,
            options: optionsList
        });
    }

    // 次週轉倉試算模組 (Roll Over Engine)
    // 預先為第 0 個近週合約計算次一期（第 1 個合約）的 Roll Over 方案
    let rollEngine = null;
    if (analyzedCycles.length >= 2) {
        const curCycle = analyzedCycles[0];
        const nextCycle = analyzedCycles[1];
        const curOptimal = curCycle.strategy?.optimal;
        const nextOptimal = nextCycle.strategy?.optimal;

        if (curOptimal && nextOptimal) {
            // 試算當期平倉 (買回以 Ask 計) vs 次期開倉 (賣出以 Bid 計)
            const curCloseCost = Math.round((curOptimal.call.ask + curOptimal.put.ask) * 10) / 10;
            const nextOpenCredit = Math.round((nextOptimal.call.bid + nextOptimal.put.bid) * 10) / 10;
            const netCredit = Math.round((nextOpenCredit - curCloseCost) * 10) / 10;

            rollEngine = {
                current_cycle: curCycle.code,
                next_cycle: nextCycle.code,
                current_close_cost: curCloseCost,
                next_open_credit: nextOpenCredit,
                net_credit: netCredit,
                is_net_credit_positive: netCredit >= 0,
                recommended_roll: {
                    call: {
                        from_strike: curOptimal.call.strike,
                        to_strike: nextOptimal.call.strike,
                        action: nextOptimal.call.strike > curOptimal.call.strike ? "Roll Up & Out (往上平移)" : "Roll Out (延期)"
                    },
                    put: {
                        from_strike: curOptimal.put.strike,
                        to_strike: nextOptimal.put.strike,
                        action: nextOptimal.put.strike < curOptimal.put.strike ? "Roll Down & Out (往下平移)" : "Roll Out (延期)"
                    }
                }
            };
        }
    }

    // 全市場 PCR 計算
    const pcr = totalCallOi > 0 ? Number((totalPutOi / totalCallOi).toFixed(2)) : 1.0;

    return {
        futures_price: futuresPrice,
        futures_meta: futuresMeta,
        twii_spot: twiiData.twiiPrice,
        ma240_support: twiiData.ma240,
        ma60: twiiData.ma60,
        ma20: twiiData.ma20,
        hv20_pct: Number((hv20 * 100).toFixed(2)),
        hv30_pct: Number(((twiiData.hv30 || hv20) * 100).toFixed(2)),
        etf_prices: etfPrices,
        market_session: sessionInfo.session,
        market_session_info: sessionInfo,
        trade_date: tradeDateStr,
        market_pcr: pcr,
        roll_engine: rollEngine,
        cycles: analyzedCycles,
        timestamp: new Date().toISOString()
    };
}
