import { NextResponse } from "next/server";

// Sempre buscar dados frescos (sem cache da Vercel)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WINDSOR_BASE = "https://connectors.windsor.ai/google_ads";
const ABACATE_BASE = "https://api.abacatepay.com/v1/billing/list";

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
    `&fields=${fields}&force_refresh=true`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "chave WINDSOR_API_KEY inválida ou sem acesso (verifique a API key no painel do Windsor)."
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
async function fetchAbacate(apiKey) {
  if (!apiKey) return [];
  const res = await fetch(ABACATE_BASE, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    if (/version mismatch/i.test(t)) {
      throw new Error(
        "chave do Abacate é v2; este dashboard usa a API v1. Gere uma chave v1 no painel do AbacatePay."
      );
    }
    throw new Error(`Abacate ${res.status}: ${t.slice(0, 160)}`);
  }
  const json = await res.json();
  // resposta: { data: [ ...billings ], error: null }
  return Array.isArray(json) ? json : json.data || [];
}

function isPaid(b) {
  const s = String(b.status || "").toUpperCase();
  return s === "PAID";
}

// valor pago em reais (Abacate retorna em centavos)
function paidAmountReais(b) {
  return num(b.amount) / 100;
}

function billingDate(b) {
  const raw = b.paidAt || b.createdAt || b.created_at || b.updatedAt;
  if (!raw) return null;
  return String(raw).slice(0, 10);
}

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  return dateStr >= from && dateStr <= to;
}

// agrega uma marca: junta gasto (Google) + receita/transações (Abacate)
function buildBrand(name, gadsRows, abacateBillings, from, to) {
  // --- Google Ads ---
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

  // --- Abacate ---
  let revenue = 0,
    transactions = 0;
  for (const b of abacateBillings) {
    if (!isPaid(b)) continue;
    const d = billingDate(b);
    if (!inRange(d, from, to)) continue;
    const amt = paidAmountReais(b);
    revenue += amt;
    transactions += 1;
    if (!daily[d]) daily[d] = { date: d, spend: 0, revenue: 0, transactions: 0 };
    daily[d].revenue += amt;
    daily[d].transactions += 1;
  }

  const series = Object.values(daily).sort((a, b) =>
    a.date < b.date ? -1 : 1
  );

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
  let abProcesso = [];
  let abPlaca = [];

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

  const brands = [
    buildBrand(nameProcesso, gadsRows, abProcesso, from, to),
    buildBrand(namePlaca, gadsRows, abPlaca, from, to),
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
