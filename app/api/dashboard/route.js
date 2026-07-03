import { NextResponse } from "next/server";

// Sempre buscar dados frescos (sem cache da Vercel)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

// Lista paginada por cursor (pagination.hasMore / pagination.next).
async function listAll(basePath, apiKey) {
  const out = [];
  let after = null;
  for (let page = 0; page < 200; page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    let path = `${basePath}${sep}limit=100`;
    if (after) path += `&after=${encodeURIComponent(after)}`;

    const { res, json, text } = await abFetch(path, apiKey);
    if (!res.ok) {
      const err = new Error(`AbacatePay ${res.status}: ${text.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    const items = (json && Array.isArray(json.data) && json.data) || [];
    for (const it of items) out.push(it);

    const pg = (json && json.pagination) || {};
    if (!pg.hasMore) break;
    const next = pg.next || pg.after || null;
    if (!next || next === after) break;
    after = next;
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
  if (!apiKey) return { checkouts: [], transparents: [], tx: [], fontes: {} };

  const fontes = {};
  let checkouts = [];
  let transparents = [];

  try {
    checkouts = await listAll("/checkouts/list", apiKey);
    fontes.checkouts = { total: checkouts.length, pagos: checkouts.filter((x) => isPaid(x.status)).length };
  } catch (e) {
    fontes.checkouts = { erro: e.message };
  }

  try {
    transparents = await listAll("/transparents/list", apiKey);
    fontes.transparents = { total: transparents.length, pagos: transparents.filter((x) => isPaid(x.status)).length };
  } catch (e) {
    fontes.transparents = { erro: e.message };
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
  return { checkouts, transparents, tx, fontes };
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

  const nameProcesso = process.env.GADS_ACCOUNT_PROCESSO || "Verifica Processo";
  const namePlaca = process.env.GADS_ACCOUNT_PLACA || "Verifica Placa";

  const errors = [];
  let gadsRows = [];
  let abProcesso = { tx: [], fontes: {} };
  let abPlaca = { tx: [], fontes: {} };

  const results = await Promise.allSettled([
    fetchGoogleAds(from, to),
    fetchAbacate(process.env.ABACATE_KEY_PROCESSO),
    fetchAbacate(process.env.ABACATE_KEY_PLACA),
  ]);

  if (results[0].status === "fulfilled") gadsRows = results[0].value;
  else errors.push(`Google Ads: ${results[0].reason.message}`);

  if (results[1].status === "fulfilled") abProcesso = results[1].value;
  else errors.push(`Abacate (Processo): ${results[1].reason.message}`);

  if (results[2].status === "fulfilled") abPlaca = results[2].value;
  else errors.push(`Abacate (Placa): ${results[2].reason.message}`);

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

  return NextResponse.json({
    period: { from, to },
    updatedAt: new Date().toISOString(),
    total,
    brands,
    errors,
  });
}
