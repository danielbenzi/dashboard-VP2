import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Rota SEPARADA do /api/dashboard de propósito: esta consulta é pesada e lenta,
// e não pode roubar o orçamento das APIs de pagamento nem segurar a tela toda.
// O frontend carrega as duas em paralelo.

const VIEW = process.env.REPEAT_VIEW || "public.vw_transactions_paid";
const JANELAS = (process.env.REPEAT_WINDOWS || "7,14,21,28,30,60,90")
  .split(",")
  .map((n) => parseInt(String(n).trim(), 10))
  .filter((n) => Number.isInteger(n) && n > 0 && n <= 3650)
  .sort((a, b) => a - b);
// Quanto histórico entra como ÂNCORA. Não segue o seletor de período do
// dashboard: com "mês atual" a janela de 90 dias ficaria sem nenhuma âncora
// elegível (ver censura abaixo) e a tabela viria vazia.
const LOOKBACK_DIAS = Math.max(1, Number(process.env.REPEAT_LOOKBACK_DAYS) || 365);
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map(); // key -> { at, payload }

// ---------- identificadores ----------
const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;
function splitView(v) {
  const partes = String(v).split(".");
  return partes.length > 1
    ? { schema: partes[0], table: partes.slice(1).join(".") }
    : { schema: "public", table: partes[0] };
}

// ---------- descoberta das colunas ----------
// Em vez de chutar como a view se chama por dentro, pergunta ao information_schema
// e escolhe. Dá para forçar com REPEAT_EMAIL_COL / REPEAT_DATE_COL.
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
    cols
      .filter((c) => /timestamp|date/i.test(c.data_type))
      .map((c) => c.column_name)
  );
  let data = dataForcada && nomes.includes(dataForcada) ? dataForcada : null;
  if (!data) {
    for (const p of PREF_DATA) {
      const achado = nomes.find((n) => n.toLowerCase() === p && temporais.has(n));
      if (achado) {
        data = achado;
        break;
      }
    }
  }
  if (!data) data = nomes.find((n) => temporais.has(n)) || null;

  return { email, data, temporais: [...temporais] };
}

// ---------- SQL ----------
// Uma varredura só. O `pares` casa cada compra com as compras seguintes DO MESMO
// e-mail limitadas à maior janela — o join não explode porque a maioria dos
// e-mails tem 1 ou 2 compras.
//
// CENSURA: uma compra feita ontem não teve 90 dias para ser repetida. Contá-la
// como "não recomprou" derruba as janelas longas artificialmente. Por isso cada
// janela só considera âncoras com `ts + N dias <= última compra da base`.
export function buildSql(janelas, view, emailCol, dataCol) {
  const { schema, table } = splitView(view);
  const alvo = `${q(schema)}.${q(table)}`;
  const E = q(emailCol);
  const D = q(dataCol);
  const maiorJanela = Math.max(...janelas);

  const contagens = janelas
    .map((n) => `         count(p.gap) FILTER (WHERE p.gap <= ${n}) AS n_${n}`)
    .join(",\n");

  const elegivel = (n) =>
    `ts + interval '${n} days' <= (SELECT max_ts FROM lim)`;
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
)
SELECT
  (SELECT max_ts FROM lim) AS max_ts,
  (SELECT count(*) FROM base) AS total_compras,
  (SELECT count(DISTINCT email) FROM base) AS total_emails,
${agregados}
FROM por_ancora;`;
}

// ---------- montagem da resposta ----------
export function montaPayload(row, janelas, lookbackDias, colunas) {
  const n = (v) => (v == null ? 0 : Number(v));
  return {
    view: VIEW,
    colunas,
    lookbackDias,
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
  const { schema, table } = splitView(VIEW);
  const { rows } = await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table]
  );
  if (rows.length === 0) {
    throw new Error(
      `a view ${VIEW} não existe ou o usuário do DATABASE_URL não enxerga ela. ` +
        `Ajuste REPEAT_VIEW ou dê SELECT para o usuário.`
    );
  }
  return rows;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const debug = searchParams.get("debug") === "1";
  const lookback = Math.max(
    1,
    Number(searchParams.get("dias")) || LOOKBACK_DIAS
  );
  const force = searchParams.get("refresh") === "1";

  const chave = `${lookback}`;
  const hit = cache.get(chave);
  if (!debug && !force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ ...hit.payload, cached: true });
  }

  try {
    const payload = await comCliente(async (client) => {
      const cols = await lerColunas(client);
      const { email, data, temporais } = escolheColunas(cols);

      if (debug) {
        return {
          view: VIEW,
          colunasDaView: cols.map((c) => `${c.column_name} (${c.data_type})`),
          colunasDetectadas: { email, data },
          colunasDeDataDisponiveis: temporais,
          comoForcar:
            "REPEAT_EMAIL_COL / REPEAT_DATE_COL nas variáveis de ambiente",
          janelas: JANELAS,
          sqlQueSeriaExecutado:
            email && data ? buildSql(JANELAS, VIEW, email, data) : null,
        };
      }

      if (!email || !data) {
        throw new Error(
          `não achei coluna de ${!email ? "e-mail" : "data"} em ${VIEW}. ` +
            `Colunas: ${cols.map((c) => c.column_name).join(", ")}. ` +
            `Defina REPEAT_EMAIL_COL / REPEAT_DATE_COL.`
        );
      }

      const { rows } = await client.query(buildSql(JANELAS, VIEW, email, data), [
        lookback,
      ]);
      return montaPayload(rows[0] || {}, JANELAS, lookback, { email, data });
    });

    if (!debug) cache.set(chave, { at: Date.now(), payload });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { erro: String(e?.message || e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
