import { NextResponse } from "next/server";

// Sempre buscar dados frescos (sem cache da Vercel)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WINDSOR_BASE = "https://connectors.windsor.ai/google_ads";
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

// ---------- AbacatePay (API oficial v1) ----------
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

// Valores no AbacatePay são em CENTAVOS (1000 = R$ 10,00).
// Preferimos o valor efetivamente pago (paidAmount) e caímos para amount.
function billingAmountCents(b) {
  if (Number.isFinite(Number(b.paidAmount)) && Number(b.paidAmount) > 0) {
    return Number(b.paidAmount);
  }
  if (Number.isFinite(Number(b.amount)) && Number(b.amount) > 0) {
    return Number(b.amount);
  }
  // fallback: soma dos produtos (price em centavos * quantity)
  if (Array.isArray(b.products)) {
    return b.products.reduce(
      (s, p) => s + num(p.price) * (num(p.quantity) || 1),
      0
    );
  }
  return 0;
}

// data em que a cobrança foi paga (para encaixar no período)
function billingPaidDate(b) {
  return String(
    b.paidAt || b.paid_at || b.updatedAt || b.updated_at || b.createdAt || b.created_at || ""
  ).slice(0, 10);
}

// Considera pago tanto "PAID" quanto "COMPLETE"/"COMPLETED" (PIX/transparent)
function isPaidStatus(status) {
  const s = String(status || "").toUpperCase();
  return s === "PAID" || s === "COMPLETE" || s === "COMPLETED";
}

// Busca TODAS as cobranças da conta via v1 /billing/list e mantém só as pagas.
// Retorna { rows: [...brutos pagos], tx: [{ amount: reais, date }] }
async function fetchAbacate(apiKey) {
  if (!apiKey) return { rows: [], tx: [] };

  const { res, json, text } = await abFetch(`${ABACATE_V1}/billing/list`, apiKey);
  if (!res.ok) {
    const err = new Error(`AbacatePay ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const items = (json && json.data) || [];
  const paid = items.filter((b) => isPaidStatus(b.status));
  const tx = paid.map((b) => ({
    amount: billingAmountCents(b) / 100,
    date: billingPaidDate(b),
  }));
  return { rows: paid, tx };
}

// ---------- Agregação por marca ----------
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
  const debug = searchParams.get("debug");

  const nameProcesso = process.env.GADS_ACCOUNT_PROCESSO || "Verifica Processo";
  const namePlaca = process.env.GADS_ACCOUNT_PLACA || "Verifica Placa";

  const errors = [];
  let gadsRows = [];
  let abProcesso = { rows: [], tx: [] };
  let abPlaca = { rows: [], tx: [] };

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

  // ---- Modo debug: expõe os registros brutos do AbacatePay para conferência ----
  // Acesse /api/dashboard?debug=abacate para ver os campos reais (status, amount,
  // paidAmount, frequency, datas) e confirmar de onde vem a receita.
  if (debug === "abacate") {
    return NextResponse.json({
      period: { from, to },
      processo: {
        totalPagas: abProcesso.rows.length,
        amostra: abProcesso.rows.slice(0, 5),
        tx: abProcesso.tx.slice(0, 10),
      },
      placa: {
        totalPagas: abPlaca.rows.length,
        amostra: abPlaca.rows.slice(0, 5),
        tx: abPlaca.tx.slice(0, 10),
      },
      errors,
    });
  }

  const brands = [
    buildBrand(nameProcesso, gadsRows, abProcesso.tx, from, to),
    buildBrand(namePlaca, gadsRows, abPlaca.tx, from, to),
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
