import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const WINDSOR_BASE = "https://connectors.windsor.ai/google_ads";
const ABACATE_V2 = "https://api.abacatepay.com/v2";
const ABACATE_V1 = "https://api.abacatepay.com/v1";

// Timeout por chamada externa: falha rápido em vez de derrubar a rota inteira (504)
const FETCH_TIMEOUT_MS = 15000;
// Cache em memória (por instância warm da função): evita rebuscar tudo a cada load
const CACHE_TTL_MS = 2 * 60 * 1000;
const memCache = new Map(); // key -> { at, payload }
// último resultado COMPLETO (sem erros) por janela de datas — usado como
// fallback quando o Abacate falha, para os números não "desabarem"
const lastGood = new Map(); // key -> payload
// última listagem boa POR FONTE (marca+endpoint+janela): se uma fonte falhar,
// usa os dados salvos dela em vez de zerar a receita
const srcCache = new Map(); // key -> { at, items }

const TZ = "America/Sao_Paulo";

// ---------- datas (sempre em America/Sao_Paulo, igual ao frontend) ----------
function todayISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}
function firstOfMonthISO() {
  const [y, m] = todayISO().split("-");
  return `${y}-${m}-01`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  return dateStr >= from && dateStr <= to;
}

// fetch com timeout
function tFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
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

  const res = await tFetch(url);
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
// A API do Abacate falha de forma intermitente ({"success":false,"data":null}).
// Retry com backoff: até 3 tentativas antes de desistir.
async function abFetch(url, apiKey) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
    try {
      const res = await tFetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* resposta não-JSON */
      }
      const failed = !res.ok || (json && json.success === false);
      if (!failed) return { res, json, text };
      last = { res, json, text };
      // erro de autenticação não se resolve com retry
      if (res.status === 401 || res.status === 403) break;
    } catch (e) {
      last = {
        res: { ok: false, status: 0 },
        json: null,
        text: e?.name === "TimeoutError" ? "timeout na chamada" : String(e?.message || e),
      };
    }
  }
  return last;
}

// converte timestamp (UTC) para a data em America/Sao_Paulo —
// venda das 22h BRT não pode cair no dia seguinte.
// Preferência: paidAt > updatedAt > createdAt. Como filtramos status=PAID,
// o updatedAt é quando o pagamento foi confirmado — o createdAt é a criação
// do QR Code, que pode ser no dia anterior ao pagamento.
function txDate(it) {
  const raw = it.paidAt || it.updatedAt || it.createdAt || it.created_at || "";
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

// transforma um item (v2 ou v1) em { amount: reais, date: 'YYYY-MM-DD' }
// paidAmount (quando existe) é o valor efetivamente pago
function normalizeTx(it) {
  const cents = it.paidAmount != null ? it.paidAmount : it.amount;
  return { amount: num(cents) / 100, date: txDate(it) };
}

// lista paginada de um recurso v2, com parada antecipada quando as páginas
// já são todas anteriores a `from` (evita varrer o histórico inteiro).
// Se a API rejeitar o filtro ?status= com HTTP 400 (acontece de forma
// intermitente), refaz a listagem SEM o filtro e filtra aqui no código.
async function listV2(path, paidStatus, apiKey, from, useStatusParam = true) {
  const out = [];
  let after = null;
  for (let page = 0; page < 50; page++) {
    const u = new URL(`${ABACATE_V2}${path}`);
    u.searchParams.set("limit", "100");
    if (useStatusParam) u.searchParams.set("status", paidStatus);
    if (after) u.searchParams.set("after", after);

    const { res, json, text } = await abFetch(u.toString(), apiKey);
    if (!res.ok || (json && json.success === false)) {
      if (res.status === 400 && useStatusParam) {
        // plano B: lista sem o filtro de status e filtra client-side
        return listV2(path, paidStatus, apiKey, from, false);
      }
      const err = new Error(
        `HTTP ${res.status} (página ${page + 1}): ${text.slice(0, 200)}`
      );
      err.status = res.status;
      err.body = text;
      throw err;
    }
    const raw = (json && json.data) || [];
    const items = useStatusParam
      ? raw
      : raw.filter((it) => String(it.status).toUpperCase() === paidStatus);
    for (const it of items) out.push(it);

    // Paginação: a doc promete pagination: { hasMore, next }, mas na prática
    // a API nem sempre devolve esses campos. Regra: se a página veio CHEIA
    // (100 itens), assume que há mais; cursor = pagination.next ou, na falta
    // dele, o id do último item.
    const pg = (json && json.pagination) || {};
    const fullPage = raw.length >= 100;
    if (!fullPage && pg.hasMore !== true) break;

    // parada antecipada: se a lista vem em ordem decrescente de data e a página
    // inteira já é mais antiga que `from`, as próximas também serão
    if (from && raw.length > 1) {
      const dFirst = txDate(raw[0]);
      const dLast = txDate(raw[raw.length - 1]);
      const descending = dFirst >= dLast;
      if (descending && dFirst && dFirst < from) break;
    }

    let next = pg.next || pg.after || null;
    if (!next && raw.length > 0) next = raw[raw.length - 1].id;
    if (!next || next === after) break;
    after = next;
  }
  return out;
}

// v1 (chaves antigas): /billing/list devolve tudo; filtramos PAID
async function listV1Billings(apiKey) {
  const { res, json, text } = await abFetch(`${ABACATE_V1}/billing/list`, apiKey);
  if (!res.ok || (json && json.success === false)) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const items = (json && json.data) || [];
  return items.filter((b) => String(b.status).toUpperCase() === "PAID");
}

// Busca as transações pagas de uma marca. Tenta v2; se a chave for v1, cai para v1.
// Erros parciais (transparents/pix) NÃO são engolidos: vão para `warnings`,
// para o dashboard nunca mostrar receita menor silenciosamente.
async function fetchAbacateTransactions(apiKey, from, warnings, brandLabel) {
  if (!apiKey) return [];

  try {
    // Obs.: /pix/list NÃO entra aqui — na API do Abacate ele lista
    // transferências PIX ENVIADAS (dinheiro saindo), não pagamentos recebidos.
    // Fontes de receita: checkouts, transparents (PIX/Boleto embutido),
    // links de pagamento e assinaturas.
    // Chamadas SEQUENCIAIS (não paralelas) para não estourar o rate limit
    // do Abacate — as falhas HTTP 400 intermitentes acontecem sob rajada.
    const paths = [
      "/checkouts/list",
      "/transparents/list",
      "/payment-links/list",
      "/subscriptions/list",
    ];
    const settled = [];
    for (const p of paths) {
      const cacheKey = `${apiKey.slice(0, 12)}:${p}:${from}`;
      try {
        const value = await listV2(p, "PAID", apiKey, from);
        srcCache.set(cacheKey, { at: Date.now(), items: value });
        settled.push({ status: "fulfilled", value });
      } catch (reason) {
        const saved = srcCache.get(cacheKey);
        if (saved) {
          const hora = new Date(saved.at).toLocaleTimeString("pt-BR", {
            timeZone: TZ,
            hour: "2-digit",
            minute: "2-digit",
          });
          warnings.push(
            `Abacate (${brandLabel}${p}): falhou agora — usando dados salvos das ${hora}`
          );
          settled.push({ status: "fulfilled", value: saved.items });
        } else {
          settled.push({ status: "rejected", reason });
        }
      }
    }

    // checkouts é obrigatório; se falhar, propaga (pode ser chave v1)
    if (settled[0].status === "rejected") throw settled[0].reason;

    const labels = ["checkouts", "transparents", "payment-links", "subscriptions"];
    const lists = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") lists.push(r.value);
      else
        warnings.push(
          `Abacate (${brandLabel}/${labels[i]}): ${r.reason?.message || r.reason}`
        );
    });

    const seen = new Set();
    const all = [];
    for (const it of lists.flat()) {
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
  // ?refresh=1 (botão Atualizar): ignora TODOS os caches e busca tudo na hora
  const force = searchParams.get("refresh") === "1";

  // cache em memória: mesma janela de datas dentro do TTL responde na hora
  // (pulado quando o usuário pede refresh explícito)
  const cacheKey = `${from}:${to}`;
  const hit = memCache.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS && hit.payload.errors.length === 0) {
    return NextResponse.json(
      { ...hit.payload, cached: true },
      { headers: { "Cache-Control": "s-maxage=120, stale-while-revalidate=120" } }
    );
  }

  const nameProcesso = process.env.GADS_ACCOUNT_PROCESSO || "Verifica Processo";
  const namePlaca = process.env.GADS_ACCOUNT_PLACA || "Verifica Placa";

  const errors = [];
  const warnings = [];
  let gadsRows = [];
  let txProcesso = [];
  let txPlaca = [];

  // Google Ads em paralelo; marcas do Abacate em SEQUÊNCIA (rate limit)
  const settle = (p) =>
    p.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    );
  const gadsPromise = settle(fetchGoogleAds(from, to));
  const rProcesso = await settle(
    fetchAbacateTransactions(process.env.ABACATE_KEY_PROCESSO, from, warnings, "Processo")
  );
  const rPlaca = await settle(
    fetchAbacateTransactions(process.env.ABACATE_KEY_PLACA, from, warnings, "Placa")
  );
  const results = [await gadsPromise, rProcesso, rPlaca];

  const label = (r) =>
    r.reason?.name === "TimeoutError"
      ? `demorou mais de ${FETCH_TIMEOUT_MS / 1000}s e foi cancelada`
      : r.reason?.message || String(r.reason);

  if (results[0].status === "fulfilled") gadsRows = results[0].value;
  else errors.push(`Google Ads: ${label(results[0])}`);

  if (results[1].status === "fulfilled") txProcesso = results[1].value;
  else errors.push(`Abacate (Processo): ${label(results[1])}`);

  if (results[2].status === "fulfilled") txPlaca = results[2].value;
  else errors.push(`Abacate (Placa): ${label(results[2])}`);

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

  const payload = {
    period: { from, to },
    updatedAt: new Date().toISOString(),
    total,
    brands,
    errors: [...errors, ...warnings],
  };

  const complete = errors.length === 0 && warnings.length === 0;

  // só guarda no cache quando tudo carregou (não congela dado incompleto)
  if (complete) {
    memCache.set(cacheKey, { at: Date.now(), payload });
    lastGood.set(cacheKey, payload);
    return NextResponse.json(payload, {
      headers: {
        // refresh explícito nunca é guardado na CDN — sempre dado fresco
        "Cache-Control": force
          ? "no-store"
          : "s-maxage=120, stale-while-revalidate=120",
      },
    });
  }

  // alguma fonte falhou (mesmo após retries): se temos um resultado completo
  // anterior desta janela, devolve ele em vez de números incompletos
  const good = lastGood.get(cacheKey);
  if (good) {
    const hora = new Date(good.updatedAt).toLocaleTimeString("pt-BR", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
    });
    return NextResponse.json(
      {
        ...good,
        stale: true,
        errors: [
          `Fontes instáveis agora — mostrando os últimos dados completos (${hora}).`,
          ...payload.errors,
        ],
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  // sem fallback disponível: devolve o que temos, com os avisos
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
