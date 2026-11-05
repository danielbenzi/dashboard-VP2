// app/api/dashboard/horas/route.js
//
// Rota NOVA e independente: /api/dashboard/horas
// Não encosta no route.js que já existe. Arquivo próprio, pasta própria.
//
// Duas respostas numa query só:
//   1) HOJE, hora a hora (sempre o dia de hoje em Brasília)
//   2) HISTÓRICO: dia da semana × hora, por dia da semana, por hora, dia a dia
//
// SEMÂNTICA — a decisão que define o número:
//   A conversão é contada pela hora de CRIAÇÃO da cobrança, não a de pagamento.
//   Uma cobrança criada 14h50 e paga 15h10 conta inteira nas 14h. É o que
//   responde "qual hora converte melhor" — pela data de pagamento, a hora que
//   recebeu o PIX roubaria o crédito da hora que gerou a intenção.
//
// Variáveis de ambiente (todas opcionais menos DATABASE_URL, que você já tem):
//   DB_TX_TABLE       = public.transactions
//   DB_STATUS_PAGOS   = paid,approved
//   DB_STATUS_IGNORA  = refunded,chargeback
//   HORAS_DIAS_PADRAO = 28

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TZ = "America/Sao_Paulo";
const DOW_NOMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const DOW_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

const listaEnv = (nome, padrao) =>
  (process.env[nome] || padrao).split(",").map((s) => s.trim()).filter(Boolean);

const STATUS_PAGOS = listaEnv("DB_STATUS_PAGOS", "paid,approved");
const STATUS_IGNORA = listaEnv("DB_STATUS_IGNORA", "refunded,chargeback");

// Descobre as colunas em tempo de execução. O schema não está versionado aqui,
// então chutar nome de coluna é como a gente já se queimou antes.
async function detectaColunas(client, tabela) {
  const [schema, nome] = tabela.includes(".") ? tabela.split(".") : ["public", tabela];
  const { rows } = await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    [schema.replace(/"/g, ""), nome.replace(/"/g, "")]
  );
  if (!rows.length) throw new Error(`tabela ${tabela} não encontrada`);

  const acha = (cands) =>
    cands
      .map((c) => rows.find((r) => r.column_name.toLowerCase() === c.toLowerCase()))
      .find(Boolean);

  const data = acha(["createdAtBr", "createdAt", "created_at", "criadoEm"]);
  const status = acha(["status", "paymentStatus", "situacao"]);
  const valor = acha(["amount", "value", "valor", "total"]);
  if (!data) throw new Error(`nenhuma coluna de criação encontrada em ${tabela}`);
  if (!status) throw new Error(`nenhuma coluna de status encontrada em ${tabela}`);

  return {
    data: data.column_name,
    dataTipo: data.data_type,
    status: status.column_name,
    valor: valor ? valor.column_name : null,
  };
}

// Converte a coluna para a hora LOCAL de Brasília respeitando o TIPO:
//  - nome terminando em "Br": já está em BRT, não mexe
//  - timestamptz: converte direto
//  - timestamp cru (padrão do Prisma, guarda UTC): marca como UTC e converte
export function exprHoraLocal(col, tipo) {
  const q = `"${col}"`;
  if (/Br$/.test(col)) return q;
  if (/with time zone/i.test(tipo)) return `(${q} AT TIME ZONE '${TZ}')`;
  return `((${q} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;
}

export function buildHorasSql(tabela, cols) {
  const ts = exprHoraLocal(cols.data, cols.dataTipo);
  const valor = cols.valor ? `COALESCE("${cols.valor}", 0)::numeric` : `0::numeric`;
  const st = `"${cols.status}"`;
  return `
    WITH base AS (
      SELECT ${ts} AS ts, ${st} AS status, ${valor} AS valor
        FROM ${tabela}
       WHERE ${ts} >= $1::timestamp
         AND ${ts} <  ($2::timestamp + interval '1 day')
    )
    SELECT
      to_char(ts, 'YYYY-MM-DD')                                   AS dia,
      EXTRACT(dow  FROM ts)::int                                  AS dow,
      EXTRACT(hour FROM ts)::int                                  AS hora,
      count(*) FILTER (WHERE NOT (status = ANY($3::text[])))      AS criadas,
      count(*) FILTER (WHERE status = ANY($4::text[]))            AS pagas,
      COALESCE(sum(valor) FILTER (WHERE status = ANY($4::text[])), 0) AS receita
    FROM base
    GROUP BY 1, 2, 3
    ORDER BY 1, 3`;
}

const zero = () => ({ criadas: 0, pagas: 0, receita: 0 });
const soma = (a, b) => {
  a.criadas += b.criadas;
  a.pagas += b.pagas;
  a.receita += b.receita;
  return a;
};
// Conversão só existe se houve cobrança criada. Sem isso, 0/0 viraria 0% e uma
// hora morta da madrugada apareceria como "péssima conversão" em vez de vazia.
const comTaxa = (o) => ({
  ...o,
  receita: Number(o.receita.toFixed(2)),
  conversao: o.criadas > 0 ? o.pagas / o.criadas : null,
  ticket: o.pagas > 0 ? Number((o.receita / o.pagas).toFixed(2)) : null,
});

export function montaHorasPayload(linhas, hojeISO, dias) {
  const hojeHoras = Array.from({ length: 24 }, () => zero());
  const matriz = new Map();
  const porDow = new Map();
  const porHora = Array.from({ length: 24 }, () => zero());
  const porDia = new Map();
  const diasPorDow = new Map();

  for (const r of linhas) {
    const v = {
      criadas: Number(r.criadas),
      pagas: Number(r.pagas),
      receita: Number(r.receita),
    };
    const dow = Number(r.dow);
    const hora = Number(r.hora);

    if (r.dia === hojeISO) {
      soma(hojeHoras[hora], v);
      continue; // hoje está incompleto: não entra na média histórica
    }

    const k = `${dow}|${hora}`;
    soma(matriz.get(k) || matriz.set(k, zero()).get(k), v);
    soma(porDow.get(dow) || porDow.set(dow, zero()).get(dow), v);
    soma(porHora[hora], v);
    soma(porDia.get(r.dia) || porDia.set(r.dia, zero()).get(r.dia), v);
    if (!diasPorDow.has(dow)) diasPorDow.set(dow, new Set());
    diasPorDow.get(dow).add(r.dia);
  }

  const hoje = {
    date: hojeISO,
    horas: hojeHoras.map((h, i) => ({ hora: i, ...comTaxa(h) })),
    total: comTaxa(hojeHoras.reduce((a, h) => soma(a, h), zero())),
  };

  const totalHist = [...porDow.values()].reduce((a, v) => soma(a, { ...v }), zero());
  const historico = {
    dias,
    matriz: Array.from({ length: 7 }, (_, dow) =>
      Array.from({ length: 24 }, (_, hora) => ({
        dow,
        hora,
        ...comTaxa(matriz.get(`${dow}|${hora}`) || zero()),
      }))
    ),
    porDiaSemana: Array.from({ length: 7 }, (_, dow) => ({
      dow,
      nome: DOW_NOMES[dow],
      curto: DOW_CURTO[dow],
      diasNaBase: diasPorDow.get(dow)?.size || 0,
      ...comTaxa(porDow.get(dow) || zero()),
    })),
    porHora: porHora.map((h, i) => ({ hora: i, ...comTaxa(h) })),
    porDia: [...porDia.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([dia, v]) => ({
        dia,
        dow: new Date(`${dia}T12:00:00Z`).getUTCDay(),
        ...comTaxa(v),
      })),
    total: comTaxa(totalHist),
  };

  return { tz: TZ, hoje, historico };
}

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
  // "hoje" é sempre hoje em Brasília, não a data do filtro da tela
  const hojeISO =
    searchParams.get("hoje") || new Date().toLocaleDateString("en-CA", { timeZone: TZ });

  const de = new Date(`${hojeISO}T12:00:00Z`);
  de.setUTCDate(de.getUTCDate() - dias);
  const deISO = de.toISOString().slice(0, 10);

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
    const { rows } = await client.query(buildHorasSql(tabela, cols), [
      deISO,
      hojeISO,
      STATUS_IGNORA,
      STATUS_PAGOS,
    ]);
    const payload = montaHorasPayload(rows, hojeISO, dias);
    payload.de = deISO;
    payload.ate = hojeISO;
    payload.tabela = tabela;
    payload.colunas = cols;
    payload.statusPagos = STATUS_PAGOS;
    payload.statusIgnorados = STATUS_IGNORA;
    if (!cols.valor) {
      payload.aviso = `a tabela ${tabela} não tem coluna de valor — receita e ticket ficam zerados; a conversão continua certa.`;
    }
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { erro: String(e?.message || e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  } finally {
    await client.end().catch(() => {});
  }
}
