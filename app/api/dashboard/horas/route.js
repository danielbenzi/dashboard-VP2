// app/api/dashboard/horas/route.js
//
// Conversão hora a hora + custo, take rate e ROAS por hora.
// Rota independente: não encosta no app/api/dashboard/route.js.
//
// DUAS FONTES, cruzadas por (dia, hora) em horário de Brasília:
//   Postgres  -> criadas, pagas, receita   (tabela base, por data de CRIAÇÃO)
//   Windsor   -> gasto do Google Ads       (date + hour_of_day)
//
// TRÊS DECISÕES QUE DEFINEM O NÚMERO:
//
// 1) A hora é a da CRIAÇÃO da cobrança, não a do pagamento. Criada 14h50 e
//    paga 15h10 conta inteira nas 14h. É o que responde "qual hora converte":
//    pela data de pagamento, a hora que recebeu o PIX roubaria o crédito da
//    hora que gerou a intenção. O gasto do anúncio também acontece na hora da
//    intenção, então ROAS e take rate só fecham nessa base.
//
// 2) `amount` na tabela base está em CENTAVOS. Conferido contra a produção em
//    22/11/2026: a soma crua deu 818539 e o dashboard principal R$ 8.215,29.
//    Divisor configurável em DB_AMOUNT_DIVISOR caso isso mude.
//
// 3) O gasto por hora do Windsor vem uma linha por campanha, e algumas horas
//    chegam com menos campanhas que outras. A rota soma as horas e compara com
//    o gasto do dia inteiro na MESMA consulta; se faltar mais que o tolerado,
//    marca `custoIncompleto` e a tela esconde ROAS em vez de inflar.
//
// Env (todas opcionais menos DATABASE_URL e WINDSOR_API_KEY, que você já tem):
//   DB_TX_TABLE          = public.transactions
//   DB_STATUS_PAGOS      = paid,approved
//   DB_STATUS_IGNORA     = refunded,chargeback
//   DB_AMOUNT_DIVISOR    = 100
//   HORAS_DIAS_PADRAO    = 28
//   GADS_ACCOUNT_PROCESSO / GADS_ACCOUNT_PLACA
//   HORAS_TOLERANCIA_CUSTO = 0.05

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TZ = "America/Sao_Paulo";
const DOW_NOMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const DOW_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

const listaEnv = (n, p) =>
  (process.env[n] || p).split(",").map((s) => s.trim()).filter(Boolean);

const STATUS_PAGOS = listaEnv("DB_STATUS_PAGOS", "paid,approved");
const STATUS_IGNORA = listaEnv("DB_STATUS_IGNORA", "refunded,chargeback");
const DIVISOR = Number(process.env.DB_AMOUNT_DIVISOR || 100) || 1;
const TOLERANCIA = Number(process.env.HORAS_TOLERANCIA_CUSTO || 0.05);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (v) => Number(v.toFixed(2));

// ---------------------------------------------------------------- Postgres

async function detectaColunas(client, tabela) {
  const [schema, nome] = tabela.includes(".") ? tabela.split(".") : ["public", tabela];
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    [schema.replace(/"/g, ""), nome.replace(/"/g, "")]
  );
  if (!rows.length) throw new Error(`tabela ${tabela} não encontrada`);
  const acha = (c) =>
    c.map((x) => rows.find((r) => r.column_name.toLowerCase() === x.toLowerCase())).find(Boolean);

  const data = acha(["createdAtBr", "createdAt", "created_at", "criadoEm"]);
  const status = acha(["status", "paymentStatus", "situacao"]);
  const valor = acha(["amount", "value", "valor", "total"]);
  if (!data) throw new Error(`nenhuma coluna de criação em ${tabela}`);
  if (!status) throw new Error(`nenhuma coluna de status em ${tabela}`);
  return {
    data: data.column_name,
    dataTipo: data.data_type,
    status: status.column_name,
    valor: valor ? valor.column_name : null,
  };
}

// Hora LOCAL de Brasília respeitando o TIPO da coluna:
//  - nome terminando em "Br": já é BRT
//  - timestamptz: converte direto
//  - timestamp cru (padrão do Prisma, guarda UTC): marca UTC e converte
export function exprHoraLocal(col, tipo) {
  const q = `"${col}"`;
  if (/Br$/.test(col)) return q;
  if (/with time zone/i.test(tipo)) return `(${q} AT TIME ZONE '${TZ}')`;
  return `((${q} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;
}

export function buildHorasSql(tabela, cols, divisor = DIVISOR) {
  const ts = exprHoraLocal(cols.data, cols.dataTipo);
  const valor = cols.valor
    ? `(COALESCE("${cols.valor}", 0)::numeric / ${divisor})`
    : `0::numeric`;
  const st = `"${cols.status}"`;
  return `
    WITH base AS (
      SELECT ${ts} AS ts, ${st} AS status, ${valor} AS valor
        FROM ${tabela}
       WHERE ${ts} >= $1::timestamp
         AND ${ts} <  ($2::timestamp + interval '1 day')
    )
    SELECT
      to_char(ts, 'YYYY-MM-DD')                              AS dia,
      EXTRACT(dow  FROM ts)::int                             AS dow,
      EXTRACT(hour FROM ts)::int                             AS hora,
      count(*) FILTER (WHERE NOT (status = ANY($3::text[]))) AS criadas,
      count(*) FILTER (WHERE status = ANY($4::text[]))       AS pagas,
      COALESCE(sum(valor) FILTER (WHERE status = ANY($4::text[])), 0) AS receita
    FROM base
    GROUP BY 1, 2, 3
    ORDER BY 1, 3`;
}

// ---------------------------------------------------------------- Windsor

// O gasto por hora vem UMA LINHA POR CAMPANHA. A rota agrega aqui; e puxa
// também o gasto por DIA para saber se a soma das horas está completa.
export async function fetchGastoPorHora(from, to, sinal) {
  const key = process.env.WINDSOR_API_KEY;
  if (!key) return { porHora: new Map(), porDia: new Map(), erro: "WINDSOR_API_KEY ausente" };

  const contas = [
    process.env.GADS_ACCOUNT_PROCESSO || "Verifica Processo",
    process.env.GADS_ACCOUNT_PLACA || "Verifica Placa",
  ];
  const base = "https://connectors.windsor.ai/google_ads";
  const url =
    `${base}?api_key=${encodeURIComponent(key)}` +
    `&date_from=${from}&date_to=${to}` +
    `&fields=date,hour_of_day,account_name,spend` +
    `&_renderer=json`;

  let json;
  try {
    const res = await fetch(url, { signal: sinal, cache: "no-store" });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return {
        porHora: new Map(),
        porDia: new Map(),
        erro:
          res.status === 401 || res.status === 403
            ? "WINDSOR_API_KEY inválida ou sem acesso."
            : `Windsor ${res.status}: ${t.slice(0, 160)}`,
      };
    }
    json = JSON.parse(await res.text());
  } catch (e) {
    return {
      porHora: new Map(),
      porDia: new Map(),
      erro: e?.name === "AbortError" ? "Windsor não respondeu a tempo." : String(e?.message || e),
    };
  }

  const linhas = Array.isArray(json) ? json : json?.data || [];
  const porHora = new Map(); // "dia|hora" -> gasto
  const porDia = new Map(); // "dia" -> gasto (soma das MESMAS linhas)
  let semHora = 0;

  for (const l of linhas) {
    const nome = String(l.account_name ?? "").trim();
    if (contas.length && nome && !contas.includes(nome)) continue;
    const dia = String(l.date ?? "").slice(0, 10);
    if (!dia) continue;
    const g = num(l.spend);
    porDia.set(dia, (porDia.get(dia) || 0) + g);

    const h = l.hour_of_day ?? l.hour;
    if (h === null || h === undefined || h === "") {
      semHora += g;
      continue;
    }
    const hora = Number(h);
    if (!Number.isInteger(hora) || hora < 0 || hora > 23) {
      semHora += g;
      continue;
    }
    const k = `${dia}|${hora}`;
    porHora.set(k, (porHora.get(k) || 0) + g);
  }

  return { porHora, porDia, semHora, linhas: linhas.length };
}

// ---------------------------------------------------------------- agregação

const zero = () => ({ criadas: 0, pagas: 0, receita: 0, custo: 0 });
const soma = (a, b) => {
  a.criadas += b.criadas;
  a.pagas += b.pagas;
  a.receita += b.receita;
  a.custo += b.custo;
  return a;
};

// `custoConfiavel` falso => ROAS e take rate saem como null em vez de número
// inflado. Zero de gasto numa hora que teve venda é quase sempre leitura
// incompleta, não hora de graça.
const comTaxas = (o, custoConfiavel = true) => {
  const temCusto = custoConfiavel && o.custo > 0;
  return {
    criadas: o.criadas,
    pagas: o.pagas,
    receita: r2(o.receita),
    custo: custoConfiavel ? r2(o.custo) : null,
    conversao: o.criadas > 0 ? o.pagas / o.criadas : null,
    ticket: o.pagas > 0 ? r2(o.receita / o.pagas) : null,
    takeRate: temCusto ? r2(o.receita - o.custo) : null,
    roas: temCusto ? o.receita / o.custo : null,
    cpa: temCusto && o.pagas > 0 ? r2(o.custo / o.pagas) : null,
  };
};

export function montaPayload(linhas, gasto, hojeISO, dias, custoOk) {
  const hojeHoras = Array.from({ length: 24 }, () => zero());
  const matriz = new Map();
  const porDow = new Map();
  const porHora = Array.from({ length: 24 }, () => zero());
  const porDia = new Map();
  const diasPorDow = new Map();

  // tudo que o banco devolveu
  const chaves = new Set();
  for (const r of linhas) chaves.add(`${r.dia}|${Number(r.hora)}`);
  // horas que só tiveram gasto, sem nenhuma cobrança: também são informação
  for (const k of gasto.porHora.keys()) chaves.add(k);

  const doBanco = new Map();
  for (const r of linhas) {
    doBanco.set(`${r.dia}|${Number(r.hora)}`, {
      criadas: Number(r.criadas),
      pagas: Number(r.pagas),
      receita: Number(r.receita),
    });
  }

  for (const k of chaves) {
    const [dia, horaStr] = k.split("|");
    const hora = Number(horaStr);
    const b = doBanco.get(k) || { criadas: 0, pagas: 0, receita: 0 };
    const v = { ...b, custo: gasto.porHora.get(k) || 0 };
    const dow = new Date(`${dia}T12:00:00Z`).getUTCDay();

    if (dia === hojeISO) {
      soma(hojeHoras[hora], v);
      continue; // hoje está incompleto: fora da média histórica
    }
    const mk = `${dow}|${hora}`;
    soma(matriz.get(mk) || matriz.set(mk, zero()).get(mk), v);
    soma(porDow.get(dow) || porDow.set(dow, zero()).get(dow), v);
    soma(porHora[hora], v);
    soma(porDia.get(dia) || porDia.set(dia, zero()).get(dia), v);
    if (!diasPorDow.has(dow)) diasPorDow.set(dow, new Set());
    diasPorDow.get(dow).add(dia);
  }

  const hoje = {
    date: hojeISO,
    horas: hojeHoras.map((h, i) => ({ hora: i, ...comTaxas(h, custoOk) })),
    total: comTaxas(hojeHoras.reduce((a, h) => soma(a, h), zero()), custoOk),
  };

  const totalHist = [...porDow.values()].reduce((a, v) => soma(a, { ...v }), zero());

  return {
    tz: TZ,
    hoje,
    historico: {
      dias,
      matriz: Array.from({ length: 7 }, (_, dow) =>
        Array.from({ length: 24 }, (_, hora) => ({
          dow,
          hora,
          ...comTaxas(matriz.get(`${dow}|${hora}`) || zero(), custoOk),
        }))
      ),
      porDiaSemana: Array.from({ length: 7 }, (_, dow) => ({
        dow,
        nome: DOW_NOMES[dow],
        curto: DOW_CURTO[dow],
        diasNaBase: diasPorDow.get(dow)?.size || 0,
        ...comTaxas(porDow.get(dow) || zero(), custoOk),
      })),
      porHora: porHora.map((h, i) => ({ hora: i, ...comTaxas(h, custoOk) })),
      porDia: [...porDia.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([dia, v]) => ({
          dia,
          dow: new Date(`${dia}T12:00:00Z`).getUTCDay(),
          ...comTaxas(v, custoOk),
        })),
      total: comTaxas(totalHist, custoOk),
    },
  };
}

// Soma das horas x gasto do dia, na MESMA consulta. Se as horas perderam mais
// que a tolerância, o ROAS por hora seria mentira para cima.
export function conferecusto(gasto, tolerancia = TOLERANCIA) {
  let somaHoras = 0;
  for (const v of gasto.porHora.values()) somaHoras += v;
  let somaDias = 0;
  for (const v of gasto.porDia.values()) somaDias += v;
  if (somaDias <= 0) return { ok: false, somaHoras, somaDias, falta: 0, motivo: "sem gasto" };
  const falta = (somaDias - somaHoras) / somaDias;
  return {
    ok: falta <= tolerancia,
    somaHoras: r2(somaHoras),
    somaDias: r2(somaDias),
    falta,
    motivo: falta > tolerancia ? "horas incompletas" : null,
  };
}

// ---------------------------------------------------------------- handler

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { erro: "DATABASE_URL não configurada." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const tabela = process.env.DB_TX_TABLE || "public.transactions";
  const dias = Math.min(
    180,
    Math.max(7, Number(searchParams.get("dias") || process.env.HORAS_DIAS_PADRAO || 28))
  );
  const hojeISO =
    searchParams.get("hoje") || new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const de = new Date(`${hojeISO}T12:00:00Z`);
  de.setUTCDate(de.getUTCDate() - dias);
  const deISO = de.toISOString().slice(0, 10);

  const avisos = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);

  const { Client } = await import("pg");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /sslmode=disable/.test(process.env.DATABASE_URL || "")
      ? false
      : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const cols = await detectaColunas(client, tabela);

    // banco e Windsor em paralelo: um não espera o outro
    const [db, gasto] = await Promise.all([
      client.query(buildHorasSql(tabela, cols), [deISO, hojeISO, STATUS_IGNORA, STATUS_PAGOS]),
      fetchGastoPorHora(deISO, hojeISO, ctrl.signal),
    ]);

    if (gasto.erro) avisos.push(`Custo do Google Ads indisponível: ${gasto.erro}`);
    const conferencia = conferecusto(gasto);
    const custoOk = !gasto.erro && conferencia.ok;

    if (!gasto.erro && !conferencia.ok) {
      avisos.push(
        `O Windsor devolveu R$ ${conferencia.somaHoras.toLocaleString("pt-BR")} somando as horas ` +
          `contra R$ ${conferencia.somaDias.toLocaleString("pt-BR")} somando os dias — ` +
          `${(conferencia.falta * 100).toFixed(1)}% do gasto não veio com hora. ` +
          `Custo, take rate e ROAS por hora ficam ocultos: com gasto faltando o ROAS sairia alto demais.`
      );
    }
    if (gasto.semHora > 0 && custoOk) {
      avisos.push(
        `R$ ${r2(gasto.semHora).toLocaleString("pt-BR")} de gasto vieram sem hora e ficaram de fora do recorte horário.`
      );
    }

    const payload = montaPayload(db.rows, gasto, hojeISO, dias, custoOk);
    payload.de = deISO;
    payload.ate = hojeISO;
    payload.tabela = tabela;
    payload.colunas = cols;
    payload.divisorValor = DIVISOR;
    payload.statusPagos = STATUS_PAGOS;
    payload.statusIgnorados = STATUS_IGNORA;
    payload.custo = { confiavel: custoOk, ...conferencia };
    payload.avisos = avisos;
    if (!cols.valor) {
      payload.avisos.push(
        `a tabela ${tabela} não tem coluna de valor — receita e ticket ficam zerados; a conversão continua certa.`
      );
    }
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { erro: String(e?.message || e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  } finally {
    clearTimeout(timer);
    await client.end().catch(() => {});
  }
}
