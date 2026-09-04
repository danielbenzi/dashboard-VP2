import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const WINDSOR_BASE = "https://connectors.windsor.ai/google_ads";
const ABACATE_V2 = "https://api.abacatepay.com/v2";
const ABACATE_V1 = "https://api.abacatepay.com/v1";
const STRIPE_BASE = "https://api.stripe.com/v1";
const PUSHIN_BASE = process.env.PUSHIN_BASE || "https://api.pushinpay.com.br/api";

// O Windsor guarda a resposta de CADA URL de conector por 6 HORAS. Sem pedir
// refresh, um plano com atualização horária não adianta nada: a chamada volta
// do cache com dado velho. `refresh_interval` define de quanto em quanto tempo
// ele rebusca da origem e `refresh_since` a janela recente reprocessada.
// Ex.: ...&refresh_since=3d&refresh_interval=1h
const WINDSOR_REFRESH_INTERVAL = process.env.WINDSOR_REFRESH_INTERVAL || "1h";
const WINDSOR_REFRESH_SINCE = process.env.WINDSOR_REFRESH_SINCE || "3d";
const WINDSOR_REFRESH =
  `&refresh_since=${encodeURIComponent(WINDSOR_REFRESH_SINCE)}` +
  `&refresh_interval=${encodeURIComponent(WINDSOR_REFRESH_INTERVAL)}`;

// Timeout por chamada externa. O Abacate às vezes passa de 8s para responder;
// como o orçamento global já protege a rota do 504, dá para ser mais paciente
// aqui do que seria seguro sem ele.
const FETCH_TIMEOUT_MS = 12000;
// Orçamento GLOBAL da rota. Precisa ficar confortavelmente abaixo de maxDuration,
// senão o Vercel mata a função no meio e o gateway devolve 504.
const BUDGET_MS = Number(process.env.DASHBOARD_BUDGET_MS || 50000);
// Tentativas por chamada ao Abacate (a API falha de forma intermitente)
const MAX_ATTEMPTS = 3;
// Teto de páginas por listagem (caminho de fallback).
const MAX_PAGES = 120;
// Registros por página no fallback paginado. A API aceita até 100, mas página
// grande demora mais — com 100 até a PRIMEIRA página estourava o timeout.
const ABACATE_PAGE_LIMIT = String(
  Math.min(100, Math.max(1, Number(process.env.ABACATE_PAGE_LIMIT) || 50))
);
// startDate filtra por data de CRIAÇÃO, mas o dashboard conta pela data de
// PAGAMENTO: um checkout criado dia 30 e pago dia 2 precisa entrar.
const ABACATE_LOOKBACK_DAYS = Number(process.env.ABACATE_LOOKBACK_DAYS || 7);
// Endpoints de receita do Abacate (fallback), na ordem de prioridade.
const ABACATE_PATHS = (
  process.env.ABACATE_ENDPOINTS ||
  "/checkouts/list,/transparents/list,/payment-links/list,/subscriptions/list"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// ---------- PushinPay ----------
// A doc pública da PushinPay só descreve POST /pix/cashIn, GET /transaction/{id}
// e GET /cashOut — não há endpoint de listagem documentado. O painel tem a tela
// de transações, então o endpoint existe; como o caminho não é público, ele fica
// em variável de ambiente. Se a sua conta usar outro caminho/nomes de parâmetro,
// muda aqui pelo ambiente, sem tocar no código.
const PUSHIN_LIST_PATH = process.env.PUSHIN_LIST_PATH || "/transactions";
// nomes dos parâmetros de data aceitos pelo endpoint de listagem
const PUSHIN_PARAM_FROM = process.env.PUSHIN_PARAM_FROM || "start_date";
const PUSHIN_PARAM_TO = process.env.PUSHIN_PARAM_TO || "end_date";
// 100 (o teto da maioria dessas APIs) em vez de 50: sem o filtro de status a
// listagem traz também os PIX não pagos, então página pequena estoura o teto de
// páginas antes de terminar o mês.
const PUSHIN_PAGE_LIMIT = String(
  Math.min(100, Math.max(1, Number(process.env.PUSHIN_PAGE_LIMIT) || 100))
);
// Teto de páginas SÓ da PushinPay (o MAX_PAGES geral é do fallback do Abacate).
// Quem para de verdade é o orçamento da rota; isto é rede de segurança.
const PUSHIN_MAX_PAGES = Math.max(1, Number(process.env.PUSHIN_MAX_PAGES) || 300);
// A PushinPay é uma API Laravel: status vem minúsculo ('paid'), valores em centavos.
const PUSHIN_PAID = (process.env.PUSHIN_PAID_STATUS || "paid").toLowerCase();

// ---------- Recompra por e-mail (Postgres) ----------
// Mesma rota, ramo separado (?repeat=1): a consulta é pesada e o frontend a
// chama em paralelo, então ela não pode entrar no payload principal e atrasar
// a tela nem disputar o orçamento das APIs de pagamento.
const REPEAT_VIEW = process.env.REPEAT_VIEW || "public.vw_transactions_paid";
const REPEAT_JANELAS = (process.env.REPEAT_WINDOWS || "7,14,21,28,30,60,90")
  .split(",")
  .map((n) => parseInt(String(n).trim(), 10))
  .filter((n) => Number.isInteger(n) && n > 0 && n <= 3650)
  .sort((a, b) => a - b);
// Quanto histórico entra como ÂNCORA. Não segue o seletor de período do topo:
// com "mês atual" a janela de 90 dias ficaria sem nenhuma âncora elegível (ver
// censura abaixo) e a tabela viria vazia.
const REPEAT_LOOKBACK_DIAS = Math.max(
  1,
  Number(process.env.REPEAT_LOOKBACK_DAYS) || 365
);
// Intervalo MÍNIMO entre duas compras para a segunda contar como recompra.
// O fluxo pós-pagamento do VP (upsell, order bump, reload, retry) gera uma
// transação NOVA com o mesmo e-mail minutos depois da primeira — isso é a mesma
// venda, não alguém voltando. Padrão 0 = conta tudo, para o número não mudar
// sem você mandar. Suba para 60 (1h) ou 1440 (24h) depois de olhar a
// distribuição de "quando acontece a próxima compra".
const REPEAT_MIN_GAP_MIN = Math.max(
  0,
  Number(process.env.REPEAT_MIN_GAP_MINUTES) || 0
);
const REPEAT_CACHE_TTL_MS = 10 * 60 * 1000;
const repeatCache = new Map(); // lookback -> { at, payload }

// Cache em memória (por instância warm da função)
const CACHE_TTL_MS = 2 * 60 * 1000;
const memCache = new Map(); // key -> { at, payload }
// último resultado COMPLETO por janela de datas, usado como fallback
const lastGood = new Map(); // key -> payload
// última listagem boa POR FONTE
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

// desloca uma data YYYY-MM-DD em N dias (meio-dia evita borda de fuso)
function shiftDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00-03:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  return dateStr >= from && dateStr <= to;
}

// relógio global da requisição
function makeBudget(ms) {
  const end = Date.now() + ms;
  return {
    left: () => end - Date.now(),
    expired: () => Date.now() >= end,
  };
}

// sub-orçamento: limita quanto UMA etapa pode consumir, para um endpoint lento
// não deixar os seguintes sem tempo.
function sliceBudget(parent, ms) {
  const end = Date.now() + ms;
  return {
    left: () => Math.min(parent.left(), end - Date.now()),
    expired: () => parent.expired() || Date.now() >= end,
  };
}

function budgetError() {
  const e = new Error("tempo da requisição esgotado antes de terminar a busca");
  e.name = "BudgetError";
  return e;
}

// fetch com timeout, limitado ao que ainda resta do orçamento global
function tFetch(url, opts = {}, budget) {
  const left = budget ? budget.left() : FETCH_TIMEOUT_MS;
  const ms = Math.min(FETCH_TIMEOUT_MS, left);
  if (ms <= 0) throw budgetError();
  return fetch(url, {
    ...opts,
    cache: "no-store",
    signal: AbortSignal.timeout(ms),
  });
}

// ---------- Google Ads (via Windsor.ai) ----------
async function fetchGoogleAds(from, to, budget) {
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
    `&fields=${fields}` +
    WINDSOR_REFRESH;

  const res = await tFetch(url, {}, budget);
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

// Detalhe HORÁRIO do dia corrente. Só faz sentido para o gasto: o Google Ads
// entrega spend/clicks/conversions por hora, enquanto o resumo do Abacate
// agrega por dia.
async function fetchGoogleAdsHourly(day, budget) {
  const key = process.env.WINDSOR_API_KEY;
  if (!key) return [];

  const fields = ["account_name", "date", "hour", "spend", "clicks", "conversions"].join(",");
  const url =
    `${WINDSOR_BASE}?api_key=${encodeURIComponent(key)}` +
    `&date_from=${day}&date_to=${day}` +
    `&fields=${fields}` +
    WINDSOR_REFRESH;

  const res = await tFetch(url, {}, budget);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Windsor (hora a hora) ${res.status}: ${t.slice(0, 160)}`);
  }
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json.data || [];

  // agrega por marca + hora (o conector pode devolver mais de uma linha por hora)
  const byKey = new Map();
  for (const r of rows) {
    const name = String(r.account_name || "").trim();
    const hour = Number(r.hour);
    if (!name || !Number.isFinite(hour)) continue;
    const k = `${name}|${hour}`;
    const cur = byKey.get(k) || { name, hour, spend: 0, clicks: 0, conversions: 0 };
    cur.spend += num(r.spend);
    cur.clicks += num(r.clicks);
    cur.conversions += num(r.conversions);
    byKey.set(k, cur);
  }
  return [...byKey.values()].sort((a, b) => a.hour - b.hour);
}

// ---------- AbacatePay ----------
async function abFetch(url, apiKey, budget) {
  let last = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (budget.expired()) break;
    if (attempt > 0) {
      const wait = Math.min(600 * 2 ** (attempt - 1), budget.left() - 1000);
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const res = await tFetch(
        url,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        },
        budget
      );
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
      // autenticação e rota inexistente não se resolvem com retry — insistir só
      // gasta orçamento que as outras fontes precisam
      if (res.status === 401 || res.status === 403 || res.status === 404) break;
    } catch (e) {
      if (e?.name === "BudgetError") break;
      const isTimeout = e?.name === "TimeoutError";
      last = {
        res: { ok: false, status: 0 },
        json: null,
        text: isTimeout ? "timeout na chamada" : String(e?.message || e),
      };
      // Timeout NÃO se resolve com retry.
      if (isTimeout) break;
    }
  }
  return (
    last || {
      res: { ok: false, status: 0 },
      json: null,
      text: "tempo da requisição esgotado",
    }
  );
}

// converte timestamp (UTC) para a data em America/Sao_Paulo
function txDate(it) {
  const raw = it.paidAt || it.updatedAt || it.createdAt || it.created_at || "";
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

// Converte um timestamp na data YYYY-MM-DD do fuso do dashboard. Só converte de
// fuso quando a string DIZ o fuso ('Z' ou ±hh:mm); sem isso (formato do Laravel,
// "2026-09-01 14:23:11") assume que já está em horário de Brasília — converter
// jogaria a venda para o dia anterior.
function toLocalDate(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? s.slice(0, 10) : d.toLocaleDateString("en-CA", { timeZone: TZ });
}

// ---------- funil: cobranças CRIADAS x PAGAS ----------
// O funil é contado pela data de CRIAÇÃO, dos dois lados: "das cobranças criadas
// no dia X, quantas foram pagas". É um recorte de coorte, diferente do card
// "Transações" (que conta pela data do PAGAMENTO). Por isso os dois números
// podem divergir num mesmo dia — e é assim que tem que ser: cobrança criada dia
// 30 e paga dia 2 conta no funil do dia 30 e na receita do dia 2.
function bumpFunnel(funnel, source, createdRaw, paid) {
  if (!funnel) return;
  const date = toLocalDate(createdRaw);
  if (!date) return;
  const k = `${source}|${date}`;
  const cur = funnel.get(k) || { source, date, created: 0, paid: 0 };
  cur.created += 1;
  if (paid) cur.paid += 1;
  funnel.set(k, cur);
}

// { amount: reais, date: 'YYYY-MM-DD' } — a API devolve centavos
function normalizeTx(it) {
  const cents = it.paidAmount != null ? it.paidAmount : it.amount;
  return { amount: num(cents) / 100, date: txDate(it) };
}

// lista paginada de um recurso v2, com filtro de data no servidor (fallback).
async function listV2(path, paidStatus, apiKey, from, to, budget, onTruncate, useStatusParam = true) {
  const out = [];
  let after = null;
  let truncated = true;
  let truncReason = null;
  let page = 0;

  // Falha no MEIO da paginação não pode descartar o que já foi lido.
  const bail = (err) => {
    if (out.length > 0) {
      if (onTruncate) {
        onTruncate(
          path,
          out.length,
          `parou na página ${page + 1} (${err.message}) — resultado PARCIAL`
        );
      }
      return out;
    }
    throw err;
  };

  for (; page < MAX_PAGES; page++) {
    if (budget.expired()) return bail(budgetError());

    const u = new URL(`${ABACATE_V2}${path}`);
    u.searchParams.set("limit", ABACATE_PAGE_LIMIT);
    if (useStatusParam) u.searchParams.set("status", paidStatus);
    // Filtro de data NO SERVIDOR — sem ele a API varre o histórico inteiro.
    if (from) u.searchParams.set("startDate", shiftDays(from, -ABACATE_LOOKBACK_DAYS));
    if (to) u.searchParams.set("endDate", to);
    if (after) u.searchParams.set("after", after);

    const { res, json, text } = await abFetch(u.toString(), apiKey, budget);
    if (!res.ok || (json && json.success === false)) {
      // 400 nos checkouts, 422 em /subscriptions — em ambos o plano B é listar
      // sem o filtro de status.
      if ((res.status === 400 || res.status === 422) && useStatusParam) {
        return listV2(path, paidStatus, apiKey, from, to, budget, onTruncate, false);
      }
      const tried = useStatusParam ? "" : " (também sem o filtro de status)";
      const err = new Error(
        `HTTP ${res.status} (página ${page + 1})${tried}: ${text.slice(0, 200)}`
      );
      err.status = res.status;
      err.body = text;
      return bail(err);
    }
    const raw = (json && json.data) || [];
    const items = useStatusParam
      ? raw
      : raw.filter((it) => String(it.status).toUpperCase() === paidStatus);
    for (const it of items) out.push(it);

    // pagination.hasMore diz se há mais; pagination.next é o cursor (publicId).
    const pg = (json && json.pagination) || {};
    const fullPage = raw.length >= Number(ABACATE_PAGE_LIMIT);
    if (pg.hasMore === false || (pg.hasMore == null && !fullPage)) {
      truncated = false;
      break;
    }

    const next = pg.next || null;
    if (!next || next === after) {
      // Página CHEIA sem cursor é suspeito: provavelmente há dados fora de alcance.
      truncated = fullPage;
      if (fullPage) {
        truncReason =
          "a API devolveu uma página cheia sem cursor de próxima página (pagination.next)";
      }
      break;
    }
    after = next;
  }
  if (truncated && onTruncate) onTruncate(path, out.length, truncReason);
  return out;
}

// v1: /billing/list devolve TODAS as cobranças numa resposta só — a
// especificação v1 não aceita nenhum parâmetro de consulta. Filtramos PAID aqui.
async function listV1Billings(apiKey, budget, funnel) {
  const { res, json, text } = await abFetch(`${ABACATE_V1}/billing/list`, apiKey, budget);
  if (!res.ok || (json && json.success === false)) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const items = (json && json.data) || [];
  // Esta chamada já traz TODAS as cobranças, pagas ou não — é de graça registrar
  // o funil aqui antes de descartar as não pagas.
  for (const b of items) {
    const st = String(b.status).toUpperCase();
    // PENDING/PAID/EXPIRED/CANCELLED contam como criadas; REFUNDED foi paga e
    // depois estornada, então não é uma cobrança "não convertida".
    if (st === "REFUNDED") continue;
    bumpFunnel(funnel, "Abacate", b.createdAt || b.created_at, st === "PAID");
  }
  return items.filter((b) => String(b.status).toUpperCase() === "PAID");
}

// /public-mrr/revenue devolve receita total, total de transações e o detalhe
// por dia do período em UMA chamada, já agregado no servidor (cache de 1h).
async function fetchAbacateRevenueSummary(apiKey, from, to, budget, onMismatch) {
  const u = new URL(`${ABACATE_V2}/public-mrr/revenue`);
  u.searchParams.set("startDate", from);
  u.searchParams.set("endDate", to);

  const { res, json, text } = await abFetch(u.toString(), apiKey, budget);
  if (!res.ok || (json && json.success === false)) {
    const err = new Error(`HTTP ${res.status}: ${String(text).slice(0, 200)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const d = (json && json.data) || {};
  const perDay = d.transactionsPerDay || {};
  // um "balde" por dia: mesma forma das transações individuais, mas com
  // `count` para o total não sair como 1 por dia
  const out = [];
  for (const [date, v] of Object.entries(perDay)) {
    const amount = num(v && v.amount) / 100;
    const count = num(v && v.count);
    if (count <= 0 && amount <= 0) continue;
    out.push({ amount, count, date, source: "Abacate" });
  }

  // CONFERÊNCIA: usamos o detalhe por dia (para ter a série do gráfico), então
  // ele PRECISA bater com o total do período — senão a receita sairia menor
  // em silêncio.
  const somaDias = out.reduce((a, x) => a + x.amount, 0);
  const totalApi = num(d.totalRevenue) / 100;
  const txDias = out.reduce((a, x) => a + x.count, 0);
  const txApi = num(d.totalTransactions);
  const tolerancia = Math.max(0.01 * Math.max(out.length, 1), totalApi * 0.001);
  if (onMismatch && totalApi > 0 && Math.abs(somaDias - totalApi) > tolerancia) {
    onMismatch(
      `o detalhe por dia soma R$ ${somaDias.toFixed(2)}, mas a API informa ` +
        `R$ ${totalApi.toFixed(2)} no período (${txDias} vs ${txApi} transações) ` +
        `— usando o detalhe, pode haver receita fora da série diária.`
    );
  }
  return out;
}

// Listagem detalhada v2 — último recurso.
async function fetchAbacateByListing(apiKey, from, to, warnings, brandLabel, budget, funnel) {
  if (!apiKey) return [];

  try {
    // Obs.: /pix/list NÃO entra aqui — lista transferências PIX ENVIADAS.
    const paths = ABACATE_PATHS;
    // Fatias PONDERADAS: o primeiro endpoint é o obrigatório e concentra a receita.
    const MAIN_WEIGHT = 0.7;
    const weights = paths.map((_, i) =>
      i === 0 ? MAIN_WEIGHT : (1 - MAIN_WEIGHT) / Math.max(1, paths.length - 1)
    );
    const settled = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const restWeight = weights.slice(i).reduce((a, b) => a + b, 0);
      const share = Math.floor((budget.left() * weights[i]) / restWeight);
      const slice = sliceBudget(budget, share);
      const cacheKey = `${apiKey.slice(0, 12)}:${p}:${from}:${to}`;
      try {
        const onTruncate = (pth, n, reason) =>
          warnings.push(
            `Abacate (${brandLabel}${pth}): ` +
              `${reason || `atingiu o limite de ${MAX_PAGES} páginas`} — ` +
              `${n} transações contabilizadas, pode haver outras faltando.`
          );
        const value = await listV2(p, "PAID", apiKey, from, to, slice, onTruncate);
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

    if (settled[0].status === "rejected") throw settled[0].reason;

    const labels = paths.map((p) => p.split("/").filter(Boolean)[0] || p);
    const tagged = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        for (const it of r.value) tagged.push({ it, source: `Abacate/${labels[i]}` });
      } else
        warnings.push(
          `Abacate (${brandLabel}/${labels[i]}): ${r.reason?.message || r.reason}`
        );
    });

    const seen = new Set();
    const all = [];
    for (const { it, source } of tagged) {
      const id = it.id || JSON.stringify(it);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push({ ...normalizeTx(it), source });
    }
    return all;
  } catch (e) {
    const isVersionMismatch =
      /version mismatch/i.test(e.body || e.message || "") || e.status === 401;
    if (!isVersionMismatch) throw e;
    const billings = await listV1Billings(apiKey, budget, funnel);
    return billings.map(normalizeTx);
  }
}

// DUAS fontes independentes para o mesmo número, buscadas em paralelo:
//   /v1/billing/list        cobranças uma a uma, sem paginação. Filtramos PAID
//                           e a janela aqui, então a semântica é auditável.
//   /v2/public-mrr/revenue  total já agregado pelo Abacate para o período.
// Usamos o v1 e conferimos contra o resumo.
async function fetchAbacateTransactions(apiKey, from, to, warnings, brandLabel, budget, funnel) {
  if (!apiKey) return [];

  const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
  const [v1r, sumr] = await Promise.all([
    settle(listV1Billings(apiKey, budget, funnel)),
    settle(
      fetchAbacateRevenueSummary(apiKey, from, to, budget, (msg) =>
        warnings.push(`Abacate (${brandLabel}/resumo): ${msg}`)
      )
    ),
  ]);

  const somaNaJanela = (txs) =>
    txs.filter((t) => inRange(t.date, from, to)).reduce((a, t) => a + t.amount, 0);
  const totalResumo = sumr.ok ? somaNaJanela(sumr.v) : null;

  // v1 só é a fonte se trouxe algo NA JANELA. Uma conta que use apenas a API
  // v2 pode responder 200 com lista vazia, e adotar esse vazio mostraria
  // R$ 0,00 enquanto o resumo tem a receita real.
  const txV1 = v1r.ok ? v1r.v.map((b) => ({ ...normalizeTx(b), source: "Abacate" })) : [];
  const v1TemDados = somaNaJanela(txV1) > 0;

  if (v1r.ok && v1TemDados) {
    const tx = txV1;
    const totalV1 = somaNaJanela(tx);
    if (totalResumo != null) {
      const dif = Math.abs(totalV1 - totalResumo);
      // 0,5% de folga cobre diferença de fuso na borda do período
      if (dif > Math.max(1, totalResumo * 0.005)) {
        warnings.push(
          `Abacate (${brandLabel}): as duas fontes discordam — ` +
            `/v1/billing/list soma R$ ${totalV1.toFixed(2)} e o resumo do período ` +
            `informa R$ ${totalResumo.toFixed(2)}. Mostrando o /v1 (detalhado).`
        );
      }
    } else {
      warnings.push(
        `Abacate (${brandLabel}/resumo): não respondeu (${sumr.e?.message || sumr.e}) — ` +
          `sem segunda fonte para conferir o total.`
      );
    }
    return tx;
  }

  // v1 falhou ou veio vazio: fica o resumo, se ele trouxe algo
  if (sumr.ok && sumr.v.length > 0) {
    const motivo = v1r.ok
      ? "não retornou cobranças no período"
      : `${v1r.e?.message || v1r.e}`;
    warnings.push(
      `Abacate (${brandLabel}/v1): ${motivo} — usando o resumo agregado do período.`
    );
    return sumr.v;
  }

  // as duas falharam: último recurso é a listagem paginada v2
  const motivoV1 = v1r.ok ? "sem cobranças no período" : `${v1r.e?.message || v1r.e}`;
  warnings.push(
    `Abacate (${brandLabel}): /v1 (${motivoV1}) e resumo ` +
      `(${sumr.ok ? "vazio" : sumr.e?.message || sumr.e}) não trouxeram dados — ` +
      `tentando a listagem paginada.`
  );
  return fetchAbacateByListing(apiKey, from, to, warnings, brandLabel, budget, funnel);
}

// ---------- Stripe (pagamentos com cartão) ----------
// O Brasil não usa horário de verão desde 2019: offset fixo -03:00.
function brtToUnix(dateStr, endOfDay) {
  const t = endOfDay ? "23:59:59" : "00:00:00";
  return Math.floor(new Date(`${dateStr}T${t}-03:00`).getTime() / 1000);
}

async function fetchStripeTransactions(apiKey, from, to, warnings, brandLabel, budget, funnel) {
  if (!apiKey) return [];

  const out = [];
  let startingAfter = null;
  let truncated = true;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (budget.expired()) throw budgetError();

    const u = new URL(`${STRIPE_BASE}/charges`);
    u.searchParams.set("limit", "100");
    u.searchParams.set("created[gte]", String(brtToUnix(from, false)));
    u.searchParams.set("created[lte]", String(brtToUnix(to, true)));
    if (startingAfter) u.searchParams.set("starting_after", startingAfter);

    const res = await tFetch(
      u.toString(),
      { headers: { Authorization: `Bearer ${apiKey}` } },
      budget
    );
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* resposta não-JSON */
    }
    if (!res.ok) {
      const msg = json?.error?.message || text.slice(0, 200);
      const err = new Error(`HTTP ${res.status} (página ${page + 1}): ${msg}`);
      err.status = res.status;
      throw err;
    }

    const raw = (json && json.data) || [];
    for (const ch of raw) {
      // Funil do cartão: /charges devolve também as recusadas, então "criadas"
      // aqui são as TENTATIVAS de cobrança e "pagas" as aprovadas — é taxa de
      // aprovação, não abandono de PIX. Uma aprovada e depois estornada conta
      // como convertida (ela converteu; o estorno só abate a receita).
      bumpFunnel(
        funnel,
        "Stripe",
        new Date(num(ch.created) * 1000).toISOString(),
        ch.status === "succeeded" && !!ch.paid
      );
      // só cobrança efetivamente capturada; estorno abate do valor
      if (ch.status !== "succeeded" || !ch.paid) continue;
      const gross = num(ch.amount_captured != null ? ch.amount_captured : ch.amount);
      const net = gross - num(ch.amount_refunded);
      if (net <= 0) continue; // totalmente estornada
      out.push({
        amount: net / 100,
        date: new Date(num(ch.created) * 1000).toLocaleDateString("en-CA", {
          timeZone: TZ,
        }),
        source: "Stripe",
      });
    }

    if (!json?.has_more || raw.length === 0) {
      truncated = false;
      break;
    }
    const next = raw[raw.length - 1].id;
    if (!next || next === startingAfter) {
      truncated = false;
      break;
    }
    startingAfter = next;
  }

  if (truncated) {
    warnings.push(
      `Stripe (${brandLabel}): atingiu o limite de ${MAX_PAGES} páginas ` +
        `(${out.length} cobranças lidas) — pode haver pagamentos não contabilizados.`
    );
  }
  return out;
}

// ---------- PushinPay (PIX) ----------
// { amount: reais, date: 'YYYY-MM-DD' } — a API devolve centavos, igual ao Abacate.
function normalizePushinTx(it) {
  const cents = it.value != null ? it.value : it.amount;
  const raw =
    it.paid_at || it.paidAt || it.updated_at || it.created_at || it.createdAt || "";
  return { amount: num(cents) / 100, date: toLocalDate(raw), source: "PushinPay" };
}

async function fetchPushinTransactions(apiKey, from, to, warnings, brandLabel, budget, funnel) {
  if (!apiKey) return [];

  const out = [];
  const seen = new Set();
  let nextUrl = null;
  let truncated = true;
  let lidos = 0; // registros vistos, pagos ou não — o out só guarda os pagos

  for (let page = 1; page <= PUSHIN_MAX_PAGES; page++) {
    if (budget.expired()) throw budgetError();

    let url = nextUrl;
    if (!url) {
      const u = new URL(`${PUSHIN_BASE}${PUSHIN_LIST_PATH}`);
      u.searchParams.set("per_page", PUSHIN_PAGE_LIMIT);
      u.searchParams.set("page", String(page));
      // Sem filtro de status de propósito: a MESMA listagem alimenta a receita
      // (só as pagas) e o funil de conversão (criadas x pagas). Filtrar no
      // servidor daria a receita certa e um funil sempre 100%.
      if (from) u.searchParams.set(PUSHIN_PARAM_FROM, from);
      if (to) u.searchParams.set(PUSHIN_PARAM_TO, to);
      url = u.toString();
    }

    // mesmo helper do Abacate: Bearer + JSON, com retry e respeito ao orçamento
    const { res, json, text } = await abFetch(url, apiKey, budget);
    if (!res.ok) {
      const err = new Error(
        res.status === 404
          ? `HTTP 404 em ${PUSHIN_LIST_PATH} — não existe listagem nesse caminho. ` +
            `Confira o caminho certo no painel/doc da PushinPay e ajuste a variável ` +
            `PUSHIN_LIST_PATH (a doc pública só descreve /pix/cashIn e /transaction/{id}).`
          : `HTTP ${res.status} (página ${page}): ${String(text).slice(0, 200)}`
      );
      err.status = res.status;
      throw err;
    }

    // aceita array puro ou paginador do Laravel ({ data: [...] })
    const raw = Array.isArray(json) ? json : (json && (json.data || json.items)) || [];
    let novos = 0;
    lidos += raw.length;
    for (const it of raw) {
      const id = it.id || it.end_to_end_id || JSON.stringify(it);
      if (seen.has(id)) continue;
      seen.add(id);
      novos++;

      const pago = String(it.status || "").toLowerCase() === PUSHIN_PAID;
      bumpFunnel(funnel, "PushinPay", it.created_at || it.createdAt, pago);

      if (!pago) continue;
      const tx = normalizePushinTx(it);
      // Filtra a janela AQUI também: se a API ignorar os parâmetros de data, o
      // total continua certo — só custa mais páginas.
      if (!inRange(tx.date, from, to)) continue;
      out.push(tx);
    }

    const nxt = (json && (json.next_page_url || json.links?.next)) || null;
    const cur = num(json && json.current_page);
    const last = num(json && json.last_page);
    const fullPage = raw.length >= Number(PUSHIN_PAGE_LIMIT);

    if (novos === 0) {
      // página repetida ou vazia — a API ignorou o cursor; parar é o certo
      truncated = false;
      break;
    }
    if (nxt) {
      nextUrl = nxt;
      continue;
    }
    if ((cur && last && cur < last) || (!cur && fullPage)) {
      nextUrl = null; // segue pelo número da página
      continue;
    }
    truncated = false;
    break;
  }

  if (truncated) {
    warnings.push(
      `PushinPay (${brandLabel}): parou no limite de ${PUSHIN_MAX_PAGES} páginas — ` +
        `${lidos} registros lidos, ${out.length} pagos no período. Pode haver ` +
        `pagamentos não contabilizados. Rode /api/dashboard?debug=pushin para ver ` +
        `se os filtros de data e de status estão sendo respeitados pela API.`
    );
  }
  return out;
}

// agrega uma marca: junta gasto (Google) + receita/transações (pagamentos)
function buildBrand(name, gadsRows, abacateTx, funnel, from, to) {
  const daily = {};
  const dayOf = (d) => {
    if (!daily[d])
      daily[d] = { date: d, spend: 0, revenue: 0, transactions: 0, created: 0, convPaid: 0 };
    return daily[d];
  };
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
    dayOf(d).spend += s;
  }

  let revenue = 0,
    transactions = 0;
  // quanto cada fonte trouxe: revela se um número baixo é venda fraca ou
  // fonte faltando/desligada
  const bySource = {};
  const srcOf = (s) => {
    if (!bySource[s])
      bySource[s] = { source: s, revenue: 0, transactions: 0, created: 0, convPaid: 0 };
    return bySource[s];
  };
  for (const t of abacateTx) {
    if (!inRange(t.date, from, to)) continue;
    // `count` existe quando a linha é um agregado diário (resumo do Abacate);
    // uma cobrança individual vale 1.
    const n = num(t.count) || 1;
    revenue += t.amount;
    transactions += n;
    const src = srcOf(t.source || "desconhecido");
    src.revenue += t.amount;
    src.transactions += n;
    const day = dayOf(t.date);
    day.revenue += t.amount;
    day.transactions += n;
  }

  // funil de conversão — contado pela data de CRIAÇÃO da cobrança
  let created = 0;
  let convPaid = 0;
  for (const f of funnel || []) {
    if (!inRange(f.date, from, to)) continue;
    created += f.created;
    convPaid += f.paid;
    const src = srcOf(f.source);
    src.created += f.created;
    src.convPaid += f.paid;
    const day = dayOf(f.date);
    day.created += f.created;
    day.convPaid += f.paid;
  }

  const sources = Object.values(bySource).sort((a, b) => b.revenue - a.revenue);

  const series = Object.values(daily).sort((a, b) => (a.date < b.date ? -1 : 1));

  const cpa = transactions > 0 ? spend / transactions : null;
  const roas = spend > 0 ? revenue / spend : null;
  const ticket = transactions > 0 ? revenue / transactions : null;

  // null (e não 0) quando nenhuma fonte soube informar as criadas: o card mostra
  // "—" em vez de fingir 0% de conversão.
  const conversion = created > 0 ? convPaid / created : null;

  return {
    name,
    spend,
    revenue,
    transactions,
    created,
    convPaid,
    conversion,
    cpa,
    roas,
    ticket,
    clicks,
    impressions,
    gadsConversions,
    gadsConvValue,
    series,
    sources,
  };
}

// ---------- diagnóstico da listagem da PushinPay ----------
// A API não tem doc pública de listagem. Em vez de chutar de novo, este endpoint
// pergunta para a própria API o que ela respeita: 4 chamadas pequenas cujo
// resultado diz se `per_page`, o filtro de data e o de status funcionam.
async function debugPushin(apiKey, from, to, budget) {
  const call = async (params) => {
    const u = new URL(`${PUSHIN_BASE}${PUSHIN_LIST_PATH}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const { res, json, text } = await abFetch(u.toString(), apiKey, budget);
    if (!res.ok) return { status: res.status, erro: String(text).slice(0, 200) };
    const arr = Array.isArray(json) ? json : (json && (json.data || json.items)) || [];
    const datas = arr
      .map((r) => toLocalDate(r.created_at || r.createdAt))
      .filter(Boolean)
      .sort();
    return {
      status: res.status,
      respostaEhArrayPuro: Array.isArray(json),
      chavesDaResposta: Array.isArray(json) ? null : Object.keys(json || {}),
      paginacao: {
        total: json?.total ?? null,
        per_page: json?.per_page ?? null,
        current_page: json?.current_page ?? null,
        last_page: json?.last_page ?? null,
        next_page_url: json?.next_page_url ? "presente" : null,
      },
      registrosNaPagina: arr.length,
      camposDoRegistro: arr[0] ? Object.keys(arr[0]) : null,
      statusVistos: [...new Set(arr.map((r) => String(r.status || "").toLowerCase()))],
      criadoEmMin: datas[0] || null,
      criadoEmMax: datas[datas.length - 1] || null,
    };
  };

  const comData = { per_page: PUSHIN_PAGE_LIMIT, page: 1, [PUSHIN_PARAM_FROM]: from, [PUSHIN_PARAM_TO]: to };
  const [A, B, C, D] = await Promise.all([
    call(comData),
    call({ ...comData, status: PUSHIN_PAID }),
    call({ per_page: 1, page: 1, [PUSHIN_PARAM_FROM]: from, [PUSHIN_PARAM_TO]: to }),
    call({ per_page: 1, page: 1 }),
  ]);

  const totalJanela = C.paginacao?.total ?? null;
  const totalGeral = D.paginacao?.total ?? null;

  return {
    caminho: PUSHIN_LIST_PATH,
    periodo: { from, to },
    A_pagina_cheia_na_janela: A,
    B_mesma_coisa_pedindo_status_paid: B,
    C_contagem_da_janela: C,
    D_contagem_sem_filtro_de_data: D,
    conclusoes: {
      per_page_respeitado:
        A.registrosNaPagina == null
          ? null
          : A.paginacao?.per_page != null
          ? String(A.paginacao.per_page) === String(PUSHIN_PAGE_LIMIT)
            ? "sim"
            : `NÃO — pedi ${PUSHIN_PAGE_LIMIT}, a API usou ${A.paginacao.per_page}`
          : A.registrosNaPagina > 50
          ? "provavelmente sim"
          : `inconclusivo (voltaram ${A.registrosNaPagina} registros)`,
      filtro_de_data_funciona:
        totalJanela != null && totalGeral != null
          ? totalJanela < totalGeral
            ? `sim (${totalJanela} na janela x ${totalGeral} no total)`
            : "NÃO — mesma contagem com e sem filtro de data"
          : A.criadoEmMin && (A.criadoEmMin < from || A.criadoEmMax > to)
          ? `NÃO — a página trouxe datas de ${A.criadoEmMin} a ${A.criadoEmMax}, fora da janela`
          : "não dá para saber (a API não devolve 'total')",
      filtro_de_status_funciona:
        !B.statusVistos
          ? null
          : B.statusVistos.length === 1 && B.statusVistos[0] === PUSHIN_PAID
          ? "sim"
          : `NÃO — pedindo '${PUSHIN_PAID}' voltaram: ${B.statusVistos.join(", ")}`,
      quantas_paginas_para_a_janela:
        totalJanela != null
          ? Math.ceil(totalJanela / Number(PUSHIN_PAGE_LIMIT))
          : "não dá para saber sem 'total'",
    },
  };
}


// ---------- Recompra por e-mail ----------
const qIdent = (ident) => `"${String(ident).replace(/"/g, '""')}"`;
function splitView(v) {
  const partes = String(v).split(".");
  return partes.length > 1
    ? { schema: partes[0], table: partes.slice(1).join(".") }
    : { schema: "public", table: partes[0] };
}

// Em vez de chutar como a view se chama por dentro, pergunta ao
// information_schema e escolhe. Dá para forçar com REPEAT_EMAIL_COL /
// REPEAT_DATE_COL.
const PREF_DATA = [
  "paid_at", "paidat", "payment_date", "paymentdate", "paid_date", "paiddate",
  "data_pagamento", "pago_em", "created_at", "createdat", "data", "date",
];

function escolheColunas(cols) {
  const nomes = cols.map((c) => c.column_name);
  const acha = (pred) => nomes.find(pred);

  const emailForcado = process.env.REPEAT_EMAIL_COL;
  const dataForcada = process.env.REPEAT_DATE_COL;

  const email =
    (emailForcado && nomes.includes(emailForcado) && emailForcado) ||
    acha((n) => /^e?_?mail$/i.test(n)) ||
    acha((n) => /email/i.test(n)) ||
    acha((n) => /mail/i.test(n)) ||
    null;

  const temporais = new Set(
    cols.filter((c) => /timestamp|date/i.test(c.data_type)).map((c) => c.column_name)
  );
  let data = dataForcada && nomes.includes(dataForcada) ? dataForcada : null;
  if (!data) {
    for (const pref of PREF_DATA) {
      const achado = nomes.find((n) => n.toLowerCase() === pref && temporais.has(n));
      if (achado) {
        data = achado;
        break;
      }
    }
  }
  if (!data) data = nomes.find((n) => temporais.has(n)) || null;

  return { email, data, temporais: [...temporais] };
}

// Uma varredura só. O `pares` casa cada compra com as compras seguintes DO
// MESMO e-mail limitadas à maior janela — o join não explode porque a maioria
// dos e-mails tem 1 ou 2 compras.
//
// CENSURA: uma compra feita ontem não teve 90 dias para ser repetida. Contá-la
// como "não recomprou" derruba as janelas longas artificialmente. Por isso cada
// janela só considera âncoras com `ts + N dias <= última compra da base`.
function buildRepeatSql(janelas, view, emailCol, dataCol) {
  const { schema, table } = splitView(view);
  const alvo = `${qIdent(schema)}.${qIdent(table)}`;
  const E = qIdent(emailCol);
  const D = qIdent(dataCol);
  const maiorJanela = Math.max(...janelas);

  const contagens = janelas
    .map((n) => `         count(p.gap) FILTER (WHERE p.gap <= ${n}) AS n_${n}`)
    .join(",\n");

  const elegivel = (n) => `ts + interval '${n} days' <= (SELECT max_ts FROM lim)`;
  const agregados = janelas
    .map(
      (n) =>
        `  count(*) FILTER (WHERE ${elegivel(n)}) AS anc_${n},\n` +
        `  count(*) FILTER (WHERE ${elegivel(n)} AND n_${n} > 0) AS rep_${n},\n` +
        `  COALESCE(sum(n_${n}) FILTER (WHERE ${elegivel(n)}), 0) AS soma_${n}`
    )
    .join(",\n");

  return `
WITH base AS MATERIALIZED (
  SELECT row_number() OVER () AS rid,
         lower(btrim(${E})) AS email,
         ${D}::timestamptz AS ts
  FROM ${alvo}
  WHERE ${E} IS NOT NULL
    AND btrim(${E}) <> ''
    AND ${D} IS NOT NULL
    AND ${D}::timestamptz >= now() - make_interval(days => $1::int)
),
lim AS (SELECT max(ts) AS max_ts FROM base),
pares AS (
  SELECT a.rid, EXTRACT(EPOCH FROM (b.ts - a.ts)) / 86400.0 AS gap
  FROM base a
  JOIN base b
    ON b.email = a.email
   AND b.ts >= a.ts + make_interval(mins => $2::int)
   AND b.ts > a.ts
   AND b.ts <= a.ts + interval '${maiorJanela} days'
),
por_ancora AS (
  SELECT a.rid,
         a.ts,
${contagens}
  FROM base a
  LEFT JOIN pares p ON p.rid = a.rid
  GROUP BY a.rid, a.ts
),
-- Quando acontece a PRÓXIMA compra (a primeira depois da âncora). É isto que
-- mostra quanto do "recomprou" é upsell/order bump da mesma sessão e quanto é
-- gente voltando dias depois. Só âncoras que já completaram a maior janela,
-- para a distribuição não ficar truncada.
proxima AS (
  SELECT p.rid, min(p.gap) AS gap
  FROM pares p
  JOIN base b ON b.rid = p.rid
  WHERE b.ts + interval '${maiorJanela} days' <= (SELECT max_ts FROM lim)
  GROUP BY p.rid
),
dist AS (
  SELECT
    count(*) FILTER (WHERE gap * 1440 < 15) AS d_15min,
    count(*) FILTER (WHERE gap * 1440 >= 15 AND gap * 24 < 1) AS d_1h,
    count(*) FILTER (WHERE gap * 24 >= 1 AND gap * 24 < 6) AS d_6h,
    count(*) FILTER (WHERE gap * 24 >= 6 AND gap < 1) AS d_24h,
    count(*) FILTER (WHERE gap >= 1 AND gap < 7) AS d_7d,
    count(*) FILTER (WHERE gap >= 7 AND gap < 30) AS d_30d,
    count(*) FILTER (WHERE gap >= 30) AS d_mais,
    count(*) AS d_total
  FROM proxima
)
SELECT
  (SELECT max_ts FROM lim) AS max_ts,
  (SELECT count(*) FROM base) AS total_compras,
  (SELECT count(DISTINCT email) FROM base) AS total_emails,
  (SELECT d_15min FROM dist) AS d_15min,
  (SELECT d_1h FROM dist) AS d_1h,
  (SELECT d_6h FROM dist) AS d_6h,
  (SELECT d_24h FROM dist) AS d_24h,
  (SELECT d_7d FROM dist) AS d_7d,
  (SELECT d_30d FROM dist) AS d_30d,
  (SELECT d_mais FROM dist) AS d_mais,
  (SELECT d_total FROM dist) AS d_total,
${agregados}
FROM por_ancora;`;
}

function montaRepeatPayload(row, janelas, lookbackDias, colunas, minGapMin) {
  const n = (v) => (v == null ? 0 : Number(v));
  const distTotal = n(row.d_total);
  const balde = (rotulo, v) => ({
    rotulo,
    n: n(v),
    fatia: distTotal > 0 ? n(v) / distTotal : null,
  });
  return {
    view: REPEAT_VIEW,
    colunas,
    lookbackDias,
    minGapMinutos: minGapMin,
    // Distribuição do intervalo até a PRÓXIMA compra. Os dois primeiros baldes
    // são, quase certamente, upsell/order bump da mesma sessão.
    quandoVoltam: {
      total: distTotal,
      baldes: [
        balde("menos de 15 min", row.d_15min),
        balde("15 min a 1 h", row.d_1h),
        balde("1 h a 6 h", row.d_6h),
        balde("6 h a 24 h", row.d_24h),
        balde("1 a 7 dias", row.d_7d),
        balde("7 a 30 dias", row.d_30d),
        balde("mais de 30 dias", row.d_mais),
      ],
    },
    ultimaCompra: row.max_ts || null,
    totalCompras: n(row.total_compras),
    totalEmails: n(row.total_emails),
    janelas: janelas.map((d) => {
      const ancoras = n(row[`anc_${d}`]);
      const comRecompra = n(row[`rep_${d}`]);
      const soma = n(row[`soma_${d}`]);
      return {
        dias: d,
        ancoras,
        comRecompra,
        // null (não 0) quando a censura não deixou nenhuma âncora elegível:
        // é "não dá para saber ainda", não "ninguém recomprou".
        taxa: ancoras > 0 ? comRecompra / ancoras : null,
        recomprasPorAncora: ancoras > 0 ? soma / ancoras : null,
        // soma a própria âncora, para casar com o "média de compras" da régua
        comprasPorEmail: ancoras > 0 ? 1 + soma / ancoras : null,
      };
    }),
  };
}

async function comCliente(fn) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não configurada");
  // import dinâmico: sem DATABASE_URL o `pg` nem é carregado, e o resto do
  // dashboard continua de pé se o pacote faltar.
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: url,
    // Neon exige TLS; a URL costuma trazer ?sslmode=require, mas quem colar sem
    // isso não pode receber um erro obscuro de handshake.
    ssl: /sslmode=/.test(url) ? undefined : { rejectUnauthorized: true },
    statement_timeout: 45000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function lerColunas(client) {
  const { schema, table } = splitView(REPEAT_VIEW);
  const { rows } = await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table]
  );
  if (rows.length === 0) {
    throw new Error(
      `a view ${REPEAT_VIEW} não existe ou o usuário do DATABASE_URL não enxerga ela. ` +
        `Ajuste REPEAT_VIEW ou dê SELECT para o usuário.`
    );
  }
  return rows;
}

// GET /api/dashboard?repeat=1  (&dias=730, &debug=1, &refresh=1)
async function handleRepeat(searchParams) {
  const debug = searchParams.get("debug") === "1";
  const lookback = Math.max(1, Number(searchParams.get("dias")) || REPEAT_LOOKBACK_DIAS);
  // ?minGap=60 ignora recompras em menos de 60 min (upsell da mesma sessão)
  const minGapParam = searchParams.get("minGap");
  const minGap = Math.max(
    0,
    minGapParam != null ? Number(minGapParam) || 0 : REPEAT_MIN_GAP_MIN
  );
  const force = searchParams.get("refresh") === "1";

  const chave = `${lookback}:${minGap}`;
  const hit = repeatCache.get(chave);
  if (!debug && !force && hit && Date.now() - hit.at < REPEAT_CACHE_TTL_MS) {
    return NextResponse.json({ ...hit.payload, cached: true });
  }

  try {
    const payload = await comCliente(async (client) => {
      const cols = await lerColunas(client);
      const { email, data, temporais } = escolheColunas(cols);

      if (debug) {
        return {
          view: REPEAT_VIEW,
          colunasDaView: cols.map((c) => `${c.column_name} (${c.data_type})`),
          colunasDetectadas: { email, data },
          colunasDeDataDisponiveis: temporais,
          comoForcar: "REPEAT_EMAIL_COL / REPEAT_DATE_COL nas variáveis de ambiente",
          janelas: REPEAT_JANELAS,
          sqlQueSeriaExecutado:
            email && data
              ? buildRepeatSql(REPEAT_JANELAS, REPEAT_VIEW, email, data)
              : null,
        };
      }

      if (!email || !data) {
        throw new Error(
          `não achei coluna de ${!email ? "e-mail" : "data"} em ${REPEAT_VIEW}. ` +
            `Colunas: ${cols.map((c) => c.column_name).join(", ")}. ` +
            `Defina REPEAT_EMAIL_COL / REPEAT_DATE_COL.`
        );
      }

      const { rows } = await client.query(
        buildRepeatSql(REPEAT_JANELAS, REPEAT_VIEW, email, data),
        [lookback, minGap]
      );
      return montaRepeatPayload(
        rows[0] || {},
        REPEAT_JANELAS,
        lookback,
        { email, data },
        minGap
      );
    });

    if (!debug) repeatCache.set(chave, { at: Date.now(), payload });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { erro: String(e?.message || e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") || firstOfMonthISO();
  const to = searchParams.get("to") || todayISO();
  const force = searchParams.get("refresh") === "1";

  // /api/dashboard?repeat=1 — recompra por e-mail, lida do Postgres
  if (searchParams.get("repeat") === "1") return handleRepeat(searchParams);

  // /api/dashboard?debug=pushin — diagnóstico, não devolve dado de venda
  if (searchParams.get("debug") === "pushin") {
    const dbg = makeBudget(20000);
    const run = (k) =>
      k
        ? debugPushin(k, from, to, dbg).catch((e) => ({ erro: String(e?.message || e) }))
        : Promise.resolve({ erro: "chave não configurada" });
    const [proc, placa] = await Promise.all([
      run(process.env.PUSHIN_KEY_PROCESSO),
      run(process.env.PUSHIN_KEY_PLACA),
    ]);
    return NextResponse.json(
      { Processo: proc, Placa: placa },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

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

  const budget = makeBudget(BUDGET_MS);

  // Funil por marca: Map 'fonte|data' -> { source, date, created, paid }.
  // Cada fetcher registra aqui o que já viu, sem chamada extra a API nenhuma.
  const funnelProcesso = new Map();
  const funnelPlaca = new Map();

  const settle = (p) =>
    p.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    );
  const results = await Promise.all([
    settle(fetchGoogleAds(from, to, budget)),
    settle(
      fetchAbacateTransactions(
        process.env.ABACATE_KEY_PROCESSO,
        from,
        to,
        warnings,
        "Processo",
        budget,
        funnelProcesso
      )
    ),
    settle(
      fetchAbacateTransactions(
        process.env.ABACATE_KEY_PLACA,
        from,
        to,
        warnings,
        "Placa",
        budget,
        funnelPlaca
      )
    ),
    settle(
      fetchStripeTransactions(
        process.env.STRIPE_KEY_PROCESSO,
        from,
        to,
        warnings,
        "Processo",
        budget,
        funnelProcesso
      )
    ),
    settle(
      fetchStripeTransactions(
        process.env.STRIPE_KEY_PLACA,
        from,
        to,
        warnings,
        "Placa",
        budget,
        funnelPlaca
      )
    ),
    // hora a hora do último dia da janela — no FIM para não deslocar os
    // índices de results usados abaixo
    settle(fetchGoogleAdsHourly(to, budget)),
    settle(
      fetchPushinTransactions(
        process.env.PUSHIN_KEY_PROCESSO,
        from,
        to,
        warnings,
        "Processo",
        budget,
        funnelProcesso
      )
    ),
    settle(
      fetchPushinTransactions(
        process.env.PUSHIN_KEY_PLACA,
        from,
        to,
        warnings,
        "Placa",
        budget,
        funnelPlaca
      )
    ),
  ]);

  const label = (r) =>
    r.reason?.name === "TimeoutError"
      ? `demorou mais de ${FETCH_TIMEOUT_MS / 1000}s e foi cancelada`
      : r.reason?.name === "BudgetError"
      ? `não terminou dentro do limite de ${Math.round(BUDGET_MS / 1000)}s da rota`
      : r.reason?.message || String(r.reason);

  if (results[0].status === "fulfilled") gadsRows = results[0].value;
  else errors.push(`Google Ads: ${label(results[0])}`);

  if (results[1].status === "fulfilled") txProcesso = results[1].value;
  else errors.push(`Abacate (Processo): ${label(results[1])}`);

  if (results[2].status === "fulfilled") txPlaca = results[2].value;
  else errors.push(`Abacate (Placa): ${label(results[2])}`);

  // Stripe soma às transações da marca. Falha dela é aviso, não erro fatal.
  if (results[3].status === "fulfilled") txProcesso = txProcesso.concat(results[3].value);
  else warnings.push(`Stripe (Processo): ${label(results[3])}`);

  if (results[4].status === "fulfilled") txPlaca = txPlaca.concat(results[4].value);
  else warnings.push(`Stripe (Placa): ${label(results[4])}`);

  let hourlyRows = [];
  if (results[5].status === "fulfilled") hourlyRows = results[5].value;
  else warnings.push(`Google Ads (hora a hora): ${label(results[5])}`);

  // PushinPay soma às transações da marca, igual à Stripe. Falha é aviso, não
  // erro fatal — o resto do dashboard continua de pé.
  if (results[6].status === "fulfilled") txProcesso = txProcesso.concat(results[6].value);
  else warnings.push(`PushinPay (Processo): ${label(results[6])}`);

  if (results[7].status === "fulfilled") txPlaca = txPlaca.concat(results[7].value);
  else warnings.push(`PushinPay (Placa): ${label(results[7])}`);

  const brands = [
    buildBrand(nameProcesso, gadsRows, txProcesso, [...funnelProcesso.values()], from, to),
    buildBrand(namePlaca, gadsRows, txPlaca, [...funnelPlaca.values()], from, to),
  ];

  // total consolidado
  const merged = {};
  const mergedSources = {};
  for (const br of brands) {
    for (const s of br.sources || []) {
      if (!mergedSources[s.source])
        mergedSources[s.source] = {
          source: s.source,
          revenue: 0,
          transactions: 0,
          created: 0,
          convPaid: 0,
        };
      mergedSources[s.source].revenue += s.revenue;
      mergedSources[s.source].transactions += s.transactions;
      mergedSources[s.source].created += s.created || 0;
      mergedSources[s.source].convPaid += s.convPaid || 0;
    }
    for (const p of br.series) {
      if (!merged[p.date])
        merged[p.date] = {
          date: p.date,
          spend: 0,
          revenue: 0,
          transactions: 0,
          created: 0,
          convPaid: 0,
        };
      merged[p.date].spend += p.spend;
      merged[p.date].revenue += p.revenue;
      merged[p.date].transactions += p.transactions;
      merged[p.date].created += p.created || 0;
      merged[p.date].convPaid += p.convPaid || 0;
    }
  }
  const totalSpend = brands.reduce((a, b) => a + b.spend, 0);
  const totalRevenue = brands.reduce((a, b) => a + b.revenue, 0);
  const totalTx = brands.reduce((a, b) => a + b.transactions, 0);
  const totalGadsConv = brands.reduce((a, b) => a + (b.gadsConversions || 0), 0);
  const totalGadsValue = brands.reduce((a, b) => a + (b.gadsConvValue || 0), 0);
  const totalCreated = brands.reduce((a, b) => a + (b.created || 0), 0);
  const totalConvPaid = brands.reduce((a, b) => a + (b.convPaid || 0), 0);

  const total = {
    name: "Total",
    spend: totalSpend,
    revenue: totalRevenue,
    transactions: totalTx,
    created: totalCreated,
    convPaid: totalConvPaid,
    conversion: totalCreated > 0 ? totalConvPaid / totalCreated : null,
    cpa: totalTx > 0 ? totalSpend / totalTx : null,
    roas: totalSpend > 0 ? totalRevenue / totalSpend : null,
    ticket: totalTx > 0 ? totalRevenue / totalTx : null,
    gadsConversions: totalGadsConv,
    gadsConvValue: totalGadsValue,
    series: Object.values(merged).sort((a, b) => (a.date < b.date ? -1 : 1)),
    sources: Object.values(mergedSources).sort((a, b) => b.revenue - a.revenue),
  };

  const payload = {
    period: { from, to },
    updatedAt: new Date().toISOString(),
    total,
    brands,
    hourly: { day: to, rows: hourlyRows },
    errors: [...errors, ...warnings],
  };

  const complete = errors.length === 0 && warnings.length === 0;

  if (complete) {
    memCache.set(cacheKey, { at: Date.now(), payload });
    lastGood.set(cacheKey, payload);
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": force
          ? "no-store"
          : "s-maxage=120, stale-while-revalidate=120",
      },
    });
  }

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

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
