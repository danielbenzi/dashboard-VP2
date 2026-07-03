import { NextResponse } from "next/server";

// Sempre buscar dados frescos (sem cache da Vercel)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60; // paginação faz várias chamadas — dá folga

// Cache em memória do último resultado BOM (sem erro de PIX), por ~90s.
// Estabiliza o dashboard: atualizações seguidas mostram o mesmo número
// em vez de oscilar quando o AbacatePay falha em alguma requisição.
const CACHE_TTL_MS = 90 * 1000;
const CACHE = globalThis.__vpDashCache || (globalThis.__vpDashCache = new Map());

const WINDSOR_BASE = "https://connectors.windsor.ai/google_ads";
const ABACATE_V2 = "https://api.abacatepay.com/v2";

function todayISO() {
  // "hoje" em horário de Brasília
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
function firstOfMonthISO() {
  return todayISO().slice(0, 8) + "01"; // YYYY-MM-01 (Brasília)
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  return dateStr >= from && dateStr <= to;
}

// ---------- Google Ads (via Windsor.ai) ----------
async function fetchGoogleAds(from, to) {
  const key = process.env.WINDSOR_API_KEY;
  if (!key) throw new Error("WINDSOR_API_KEY não configurada");

  const fields = [
    "account_name",
    "date",
    "spend",
    "clicks",
    "impressions",
    "conversions",
    "conversion_value",
  ].join(",");

  const url =
    `${WINDSOR_BASE}?api_key=${encodeURIComponent(key)}` +
    `&date_from=${from}&date_to=${to}` +
    `&fields=${fields}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "chave WINDSOR_API_KEY inválida ou sem acesso à API de dados do Windsor."
      );
    }
    const t = await res.text();
    throw new Error(`Windsor ${res.status}: ${t.slice(0, 160)}`);
  }
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json.data || [];
  return rows;
}

// ================= AbacatePay (API v2) =================
// Base: https://api.abacatepay.com/v2 · valores em CENTAVOS · envelope { data, success, error, pagination }
// Receita = /checkouts/list (cartão) + /transparents/list (PIX QR Code).
// Considera PAGO apenas status "PAID". REFUNDED (estornado), CANCELLED, EXPIRED,
// PENDING não entram. /pix/list é transferência de saída — não é receita.

// GET simples com Bearer. Sem Content-Type (é GET, não tem corpo) — alguns
// endpoints (transparents) recusam GET com Content-Type: application/json.
async function abFetch(path, apiKey) {
  const res = await fetch(`${ABACATE_V2}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* resposta não-JSON */
  }
  return { res, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET com retry: o AbacatePay às vezes devolve 400/429/5xx de forma intermitente
// (limite de requisições). Tentamos algumas vezes antes de desistir.
async function abFetchRetry(path, apiKey, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await abFetch(path, apiKey);
    if (r.res.ok) return r;
    last = r;
    // 400/429/5xx costumam ser transitórios aqui — espera e tenta de novo
    await sleep(400 + i * 400);
  }
  return last;
}

// Lista paginada por cursor, com retry e throttle. Continua enquanto a página
// vier cheia (== limit), usando o cursor da paginação ou, na falta dele, o id
// do último item (o AbacatePay aceita o id como cursor "after").
const LIMIT = 100;
async function listAll(basePath, apiKey, debugPages) {
  const out = [];
  let after = null;
  for (let page = 0; page < 500; page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    let path = `${basePath}${sep}limit=${LIMIT}`;
    if (after) path += `&after=${encodeURIComponent(after)}`;

    const { res, json, text } = await abFetchRetry(path, apiKey);
    if (!res.ok) {
      const err = new Error(`AbacatePay ${res.status}: ${text.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    const items = (json && Array.isArray(json.data) && json.data) || [];
    for (const it of items) out.push(it);

    const pg = (json && (json.pagination || (json.data && json.data.pagination))) || {};
    if (debugPages) debugPages.push({ page, got: items.length, pagination: pg });

    if (items.length < LIMIT) break; // última página
    let next = pg.next || pg.after || (items[items.length - 1] && items[items.length - 1].id);
    if (!next || next === after) break;
    after = next;
    await sleep(150); // throttle entre páginas para não tomar 400
  }
  return out;
}

function isPaid(status) {
  return String(status || "").toUpperCase() === "PAID";
}

// valor pago em CENTAVOS -> reais
function amountReais(it) {
  const cands = [it.paidAmount, it.amount, it.value, it.total];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n / 100;
  }
  const list = Array.isArray(it.products)
    ? it.products
    : Array.isArray(it.items)
    ? it.items
    : [];
  const sum = list.reduce(
    (s, p) => s + num(p.price ?? p.amount) * (num(p.quantity) || 1),
    0
  );
  return sum / 100;
}

// Data do pagamento no fuso de Brasília (America/Sao_Paulo), para bater com o
// painel do AbacatePay. Os timestamps da API vêm em UTC; agrupar por UTC jogava
// as transações da madrugada para o dia seguinte.
function paidDate(it) {
  const raw =
    it.paidAt ||
    it.paid_at ||
    it.completedAt ||
    it.updatedAt ||
    it.updated_at ||
    it.createdAt ||
    it.created_at ||
    "";
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return String(raw).slice(0, 10);
  // en-CA => "YYYY-MM-DD"
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

// Busca a receita paga (checkouts + PIX QR) de uma conta.
async function fetchAbacate(apiKey) {
  if (!apiKey) return { checkouts: [], transparents: [], tx: [], fontes: {}, warn: null };

  const fontes = { paginas: { checkouts: [], transparents: [] } };
  let checkouts = [];
  let transparents = [];
  let warn = null;

  try {
    checkouts = await listAll("/checkouts/list", apiKey, fontes.paginas.checkouts);
    fontes.checkouts = { total: checkouts.length, pagos: checkouts.filter((x) => isPaid(x.status)).length };
  } catch (e) {
    fontes.checkouts = { erro: e.message };
    warn = `cartão não respondeu (${e.message})`;
  }

  await sleep(150);

  try {
    transparents = await listAll("/transparents/list", apiKey, fontes.paginas.transparents);
    fontes.transparents = { total: transparents.length, pagos: transparents.filter((x) => isPaid(x.status)).length };
  } catch (e) {
    fontes.transparents = { erro: e.message };
    // PIX QR é a maior parte da receita: se falhar, avisamos em vez de mostrar número baixo.
    warn = `PIX QR não respondeu (${e.message}) — receita pode estar incompleta`;
  }

  const seen = new Set();
  const tx = [];
  for (const it of [...checkouts, ...transparents]) {
    if (!isPaid(it.status)) continue;
    const id = it.id || JSON.stringify(it);
    if (seen.has(id)) continue;
    seen.add(id);
    tx.push({ amount: amountReais(it), date: paidDate(it) });
  }
  return { checkouts, transparents, tx, fontes, warn };
}

// ---------- Agregação por marca ----------
function buildBrand(name, gadsRows, abacateTx, from, to) {
  const daily = {};
  let spend = 0, clicks = 0, impressions = 0, gadsConversions = 0, gadsConvValue = 0;

  for (const r of gadsRows) {
    if (String(r.account_name).trim() !== name) continue;
    const d = String(r.date).slice(0, 10);
    if (!inRange(d, from, to)) continue;
    const s = num(r.spend);
    spend += s;
    clicks += num(r.clicks);
    impressions += num(r.impressions);
    gadsConversions += num(r.conversions);
    gadsConvValue += num(r.conversion_value);
    if (!daily[d]) daily[d] = { date: d, spend: 0, revenue: 0, transactions: 0 };
    daily[d].spend += s;
  }

  let revenue = 0, transactions = 0;
  for (const t of abacateTx) {
    if (!inRange(t.date, from, to)) continue;
    revenue += t.amount;
    transactions += 1;
    if (!daily[t.date]) daily[t.date] = { date: t.date, spend: 0, revenue: 0, transactions: 0 };
    daily[t.date].revenue += t.amount;
    daily[t.date].transactions += 1;
  }

  const series = Object.values(daily).sort((a, b) => (a.date < b.date ? -1 : 1));
  const cpa = transactions > 0 ? spend / transactions : null;
  const roas = spend > 0 ? revenue / spend : null;
  const ticket = transactions > 0 ? revenue / transactions : null;

  return {
    name, spend, revenue, transactions, cpa, roas, ticket,
    clicks, impressions, gadsConversions, gadsConvValue, series,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") || firstOfMonthISO();
  const to = searchParams.get("to") || todayISO();
  const debug = searchParams.get("debug");

  // Serve o último resultado bom em cache (evita oscilação em refreshes seguidos)
  const cacheKey = `${from}|${to}`;
  if (!debug) {
    const hit = CACHE.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return NextResponse.json({ ...hit.payload, cached: true });
    }
  }

  const nameProcesso = process.env.GADS_ACCOUNT_PROCESSO || "Verifica Processo";
  const namePlaca = process.env.GADS_ACCOUNT_PLACA || "Verifica Placa";

  const errors = [];
  let gadsRows = [];
  let abProcesso = { tx: [], fontes: {} };
  let abPlaca = { tx: [], fontes: {} };

  // Google Ads em paralelo; AbacatePay das duas marcas em SÉRIE (uma de cada vez)
  // para não estourar o limite de requisições concorrentes do AbacatePay.
  const gadsPromise = fetchGoogleAds(from, to).catch((e) => {
    errors.push(`Google Ads: ${e.message}`);
    return [];
  });

  try {
    abProcesso = await fetchAbacate(process.env.ABACATE_KEY_PROCESSO);
    if (abProcesso.warn) errors.push(`AbacatePay Processo: ${abProcesso.warn}`);
  } catch (e) {
    errors.push(`Abacate (Processo): ${e.message}`);
  }

  await sleep(200);

  try {
    abPlaca = await fetchAbacate(process.env.ABACATE_KEY_PLACA);
    if (abPlaca.warn) errors.push(`AbacatePay Placa: ${abPlaca.warn}`);
  } catch (e) {
    errors.push(`Abacate (Placa): ${e.message}`);
  }

  gadsRows = await gadsPromise;

  if (debug === "abacate") {
    return NextResponse.json({
      period: { from, to },
      processo: {
        fontes: abProcesso.fontes,
        total_tx: abProcesso.tx.length,
        amostra_tx: abProcesso.tx.slice(0, 8),
      },
      placa: {
        fontes: abPlaca.fontes,
        total_tx: abPlaca.tx.length,
        amostra_tx: abPlaca.tx.slice(0, 8),
      },
      errors,
    });
  }

  const brands = [
    buildBrand(nameProcesso, gadsRows, abProcesso.tx, from, to),
    buildBrand(namePlaca, gadsRows, abPlaca.tx, from, to),
  ];

  const merged = {};
  for (const br of brands) {
    for (const p of br.series) {
      if (!merged[p.date]) merged[p.date] = { date: p.date, spend: 0, revenue: 0, transactions: 0 };
      merged[p.date].spend += p.spend;
      merged[p.date].revenue += p.revenue;
      merged[p.date].transactions += p.transactions;
    }
  }
  const totalSpend = brands.reduce((a, b) => a + b.spend, 0);
  const totalRevenue = brands.reduce((a, b) => a + b.revenue, 0);
  const totalTx = brands.reduce((a, b) => a + b.transactions, 0);

  const total = {
    name: "Total",
    spend: totalSpend,
    revenue: totalRevenue,
    transactions: totalTx,
    cpa: totalTx > 0 ? totalSpend / totalTx : null,
    roas: totalSpend > 0 ? totalRevenue / totalSpend : null,
    ticket: totalTx > 0 ? totalRevenue / totalTx : null,
    series: Object.values(merged).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };

  const payload = {
    period: { from, to },
    updatedAt: new Date().toISOString(),
    total,
    brands,
    errors,
  };

  // Só cacheia se o AbacatePay respondeu direito (sem erro/aviso de PIX).
  const abacateFalhou = errors.some((e) => /abacate|abacatepay/i.test(e));
  if (!abacateFalhou) CACHE.set(cacheKey, { at: Date.now(), payload });

  return NextResponse.json(payload);
}
