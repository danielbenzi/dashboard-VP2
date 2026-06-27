import { NextResponse } from "next/server";

// Sempre buscar dados frescos (sem cache da Vercel)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WINDSOR_BASE = "https://connectors.windsor.ai/google_ads";
const ABACATE_V2 = "https://api.abacatepay.com/v2";
const ABACATE_V1 = "https://api.abacatepay.com/v1";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function firstOfMonthISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
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

// ---------- AbacatePay ----------
async function abFetch(url, apiKey) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
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

// transforma um item (v2 ou v1) em { amount: reais, date: 'YYYY-MM-DD' }
function normalizeTx(it) {
  const date = String(it.paidAt || it.createdAt || it.created_at || it.updatedAt || "").slice(
    0,
    10
  );
  return { amount: num(it.amount) / 100, date };
}

// lista paginada de um recurso v2 já filtrando pelo status pago
async function listV2(path, paidStatus, apiKey) {
  const out = [];
  let after = null;
  for (let page = 0; page < 50; page++) {
    const u = new URL(`${ABACATE_V2}${path}`);
    u.searchParams.set("limit", "100");
    u.searchParams.set("status", paidStatus);
    if (after) u.searchParams.set("after", after);

    const { res, json, text } = await abFetch(u.toString(), apiKey);
    if (!res.ok) {
      const err = new Error(text.slice(0, 200));
      err.status = res.status;
      err.body = text;
      throw err;
    }
    const items = (json && json.data) || [];
    for (const it of items) out.push(it);

    if (items.length < 100) break;

    // descobre o cursor da próxima página
    const pg = (json && json.pagination) || {};
    let next =
      pg.after || pg.nextCursor || pg.cursor || pg.next || null;
    if (!next && items[items.length - 1]) next = items[items.length - 1].id;
    if (!next || next === after) break;
    after = next;
  }
  return out;
}

// v1 (chaves antigas): /billing/list devolve tudo; filtramos PAID
async function listV1Billings(apiKey) {
  const { res, json, text } = await abFetch(`${ABACATE_V1}/billing/list`, apiKey);
  if (!res.ok) {
    const err = new Error(text.slice(0, 200));
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const items = (json && json.data) || [];
  return items.filter((b) => String(b.status).toUpperCase() === "PAID");
}

// Busca as transações pagas de uma marca. Tenta v2; se a chave for v1, cai para v1.
// Retorna array normalizado [{ amount: reais, date }].
async function fetchAbacateTransactions(apiKey) {
  if (!apiKey) return [];

  // ---- tentativa v2 ----
  try {
    const [checkouts, transparents, pix] = await Promise.all([
      listV2("/checkouts/list", "PAID", apiKey),
      listV2("/transparents/list", "PAID", apiKey).catch(() => []),
      listV2("/pix/list", "COMPLETE", apiKey).catch(() => []),
    ]);

    // junta tudo, deduplica por id (um pagamento vive em um só recurso)
    const seen = new Set();
    const all = [];
    for (const it of [...checkouts, ...transparents, ...pix]) {
      const id = it.id || JSON.stringify(it);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(normalizeTx(it));
    }
    return all;
  } catch (e) {
    const isVersionMismatch =
      /version mismatch/i.test(e.body || e.message || "") || e.status === 401;
    if (!isVersionMismatch) throw e;
    // ---- fallback v1 ----
    const billings = await listV1Billings(apiKey);
    return billings.map(normalizeTx);
  }
}

// agrega uma marca: junta gasto (Google) + receita/transações (Abacate)
function buildBrand(name, gadsRows, abacateTx, from, to) {
  const daily = {}; // date -> { spend, revenue, transactions }
  let spend = 0,
    clicks = 0,
    impressions = 0,
    gadsConversions = 0,
    gadsConvValue = 0;

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

  let revenue = 0,
    transactions = 0;
  for (const t of abacateTx) {
    if (!inRange(t.date, from, to)) continue;
    revenue += t.amount;
    transactions += 1;
    if (!daily[t.date])
      daily[t.date] = { date: t.date, spend: 0, revenue: 0, transactions: 0 };
    daily[t.date].revenue += t.amount;
    daily[t.date].transactions += 1;
  }

  const series = Object.values(daily).sort((a, b) => (a.date < b.date ? -1 : 1));

  const cpa = transactions > 0 ? spend / transactions : null;
  const roas = spend > 0 ? revenue / spend : null;
  const ticket = transactions > 0 ? revenue / transactions : null;

  return {
    name,
    spend,
    revenue,
    transactions,
    cpa,
    roas,
    ticket,
    clicks,
    impressions,
    gadsConversions,
    gadsConvValue,
    series,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") || firstOfMonthISO();
  const to = searchParams.get("to") || todayISO();

  const nameProcesso = process.env.GADS_ACCOUNT_PROCESSO || "Verifica Processo";
  const namePlaca = process.env.GADS_ACCOUNT_PLACA || "Verifica Placa";

  const errors = [];
  let gadsRows = [];
  let txProcesso = [];
  let txPlaca = [];

  const results = await Promise.allSettled([
    fetchGoogleAds(from, to),
    fetchAbacateTransactions(process.env.ABACATE_KEY_PROCESSO),
    fetchAbacateTransactions(process.env.ABACATE_KEY_PLACA),
  ]);

  if (results[0].status === "fulfilled") gadsRows = results[0].value;
  else errors.push(`Google Ads: ${results[0].reason.message}`);

  if (results[1].status === "fulfilled") txProcesso = results[1].value;
  else errors.push(`Abacate (Processo): ${results[1].reason.message}`);

  if (results[2].status === "fulfilled") txPlaca = results[2].value;
  else errors.push(`Abacate (Placa): ${results[2].reason.message}`);

  const brands = [
    buildBrand(nameProcesso, gadsRows, txProcesso, from, to),
    buildBrand(namePlaca, gadsRows, txPlaca, from, to),
  ];

  // total consolidado
  const merged = {};
  for (const br of brands) {
    for (const p of br.series) {
      if (!merged[p.date])
        merged[p.date] = { date: p.date, spend: 0, revenue: 0, transactions: 0 };
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
