// app/api/dashboard/campanhas/route.js
//
// Rota independente: /api/dashboard/campanhas
// Não encosta em nenhum outro route.js.
//
// DUAS FONTES, e cada uma responde o que sabe responder:
//
//   Windsor (Google Ads) -> gasto, cliques, conversões e VALOR de conversão
//                           por campanha. O valor de conversão é alimentado
//                           pela sua própria conversão offline, então é a sua
//                           venda real atribuída pelo Google — conferido em
//                           16-22/11: R$ 108.564 contra R$ 112.575 no banco,
//                           96% de casamento.
//
//   Postgres (a view)    -> vendas, receita e ticket por PRODUTO, por data de
//                           pagamento. É a verdade do caixa, sem atribuição.
//
// POR QUE NÃO JUNTO AS DUAS NUM ROAS POR PRODUTO GERAL:
//   A transação guarda só o identificador de clique (gclid/gbraid/wbraid), não
//   o utm_campaign. Sem isso não existe caminho de uma venda até a campanha
//   dentro do banco. Então ROAS por produto sai SÓ para as campanhas que
//   nomeiam o produto; as genéricas (Broad, PMax, Conquest, Brand) ficam num
//   bloco à parte, sem fingir atribuição que não existe.
//
// Env (opcionais; WINDSOR_API_KEY e DATABASE_URL você já tem):
//   DB_PAID_VIEW             = public.vw_transactions_paid
//   DB_VIEW_AMOUNT_DIVISOR   = 1      (a VIEW já vem em reais; a tabela base não)
//   CAMPANHA_ROAS_ALVO       = 1.4
//   CAMPANHA_PRODUTO_MAP     = JSON [{"produto":"...","padroes":["..."]}]
//   GADS_ACCOUNT_PROCESSO
//   WINDSOR_REFRESH_SINCE / WINDSOR_REFRESH_INTERVAL

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TZ = "America/Sao_Paulo";
const ROAS_ALVO = Number(process.env.CAMPANHA_ROAS_ALVO || 1.4);
const VIEW_DIVISOR = Number(process.env.DB_VIEW_AMOUNT_DIVISOR || 1) || 1;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (v) => Number(Number(v).toFixed(2));

// Sem acento e em minúsculas: os nomes reais têm "Mandato_de_Prisão" e
// "Movimentaçoes_Públicas". Comparar com acento erra na primeira campanha.
export const chave = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// Campanha -> produto. Só entra aqui campanha que NOMEIA o produto; o resto
// é genérica de propósito.
const MAPA_PADRAO = [
  { produto: "Antecedentes criminais", padroes: ["antecedentes"] },
  { produto: "Mandado de prisão", padroes: ["mandato_de_prisao", "mandado_de_prisao", "mandado", "mandato"] },
  { produto: "Movimentação de processo", padroes: ["movimentoprocesso", "movimentacoes_publicas", "movimenta"] },
  { produto: "Consulta jurídica", padroes: ["consulta_juridica", "consulta juridica"] },
  { produto: "Assinatura / monitoramento", padroes: ["monitoramento", "assinatura"] },
];

function carregaMapa() {
  const bruto = process.env.CAMPANHA_PRODUTO_MAP;
  if (!bruto) return MAPA_PADRAO;
  try {
    const m = JSON.parse(bruto);
    if (Array.isArray(m) && m.every((x) => x?.produto && Array.isArray(x?.padroes))) return m;
  } catch {
    /* mapa inválido cai no padrão; o aviso sai no payload */
  }
  return MAPA_PADRAO;
}

export function produtoDaCampanha(nome, mapa = MAPA_PADRAO) {
  const k = chave(nome);
  for (const m of mapa) {
    if (m.padroes.some((p) => k.includes(chave(p)))) return m.produto;
  }
  return null;
}

// Prefixo entre colchetes do seu padrão de nome: [PES], [PMAx], [DGen], [APP].
export function tipoDaCampanha(nome) {
  const m = String(nome || "").match(/^\s*\[([^\]]+)\]/);
  return m ? m[1].trim().toUpperCase() : "SEM PREFIXO";
}

// ---------------------------------------------------------------- Windsor

export async function fetchCampanhas(from, to, sinal) {
  const key = process.env.WINDSOR_API_KEY;
  if (!key) return { linhas: [], erro: "WINDSOR_API_KEY ausente" };

  const contas = [
    process.env.GADS_ACCOUNT_PROCESSO || "Verifica Processo",
  ];
  // Sem refresh o Windsor serve cache de até 6 HORAS e o dia corrente chega
  // pela metade. Mesmas envs que as outras rotas já usam.
  const refreshSince = process.env.WINDSOR_REFRESH_SINCE || "3d";
  const refreshInterval = process.env.WINDSOR_REFRESH_INTERVAL || "1h";

  const url =
    `https://connectors.windsor.ai/google_ads?api_key=${encodeURIComponent(key)}` +
    `&date_from=${from}&date_to=${to}` +
    `&fields=date,campaign,account_name,spend,clicks,impressions,conversions,conversion_value` +
    `&_renderer=json` +
    `&refresh_since=${encodeURIComponent(refreshSince)}` +
    `&refresh_interval=${encodeURIComponent(refreshInterval)}`;

  try {
    const res = await fetch(url, { signal: sinal, cache: "no-store" });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return {
        linhas: [],
        erro:
          res.status === 401 || res.status === 403
            ? "WINDSOR_API_KEY inválida ou sem acesso."
            : `Windsor ${res.status}: ${t.slice(0, 160)}`,
      };
    }
    const json = JSON.parse(await res.text());
    const brutas = Array.isArray(json) ? json : json?.data || [];
    const linhas = brutas.filter((l) => {
      const n = String(l.account_name ?? "").trim();
      return !n || contas.includes(n);
    });
    return { linhas, descartadas: brutas.length - linhas.length };
  } catch (e) {
    return {
      linhas: [],
      erro: e?.name === "AbortError" ? "Windsor não respondeu a tempo." : String(e?.message || e),
    };
  }
}

const zeroC = () => ({
  spend: 0,
  clicks: 0,
  impressions: 0,
  conversions: 0,
  convValue: 0,
});
const somaC = (a, b) => {
  a.spend += b.spend;
  a.clicks += b.clicks;
  a.impressions += b.impressions;
  a.conversions += b.conversions;
  a.convValue += b.convValue;
  return a;
};

// ROAS só existe com gasto. Gasto zero com receita vira Infinity e polui a
// ordenação inteira, então vira null.
export const derivadas = (o) => {
  const temGasto = o.spend > 0;
  return {
    spend: r2(o.spend),
    clicks: Math.round(o.clicks),
    impressions: Math.round(o.impressions),
    conversions: r2(o.conversions),
    convValue: r2(o.convValue),
    roas: temGasto ? o.convValue / o.spend : null,
    takeRate: temGasto ? r2(o.convValue - o.spend) : null,
    cpa: temGasto && o.conversions > 0 ? r2(o.spend / o.conversions) : null,
    cpc: temGasto && o.clicks > 0 ? r2(o.spend / o.clicks) : null,
    cvr: o.clicks > 0 ? o.conversions / o.clicks : null,
    ticket: o.conversions > 0 ? r2(o.convValue / o.conversions) : null,
  };
};

export function montaCampanhas(linhas, mapa) {
  const porCampanha = new Map();
  // campanha -> dia -> métricas, para a evolução dia a dia
  const porDia = new Map();
  const dias = new Set();
  for (const l of linhas) {
    const nome = String(l.campaign ?? "").trim() || "(sem nome)";
    const valores = {
      spend: num(l.spend),
      clicks: num(l.clicks),
      impressions: num(l.impressions),
      conversions: num(l.conversions),
      convValue: num(l.conversion_value),
    };
    const atual = porCampanha.get(nome) || zeroC();
    somaC(atual, valores);
    porCampanha.set(nome, atual);

    const dia = String(l.date ?? "").slice(0, 10);
    if (dia) {
      dias.add(dia);
      if (!porDia.has(nome)) porDia.set(nome, new Map());
      const doDia = porDia.get(nome);
      doDia.set(dia, somaC(doDia.get(dia) || zeroC(), valores));
    }
  }
  // Mesmo eixo de dias para todas as campanhas: dia sem linha é dia de zero,
  // não um buraco que encurta o gráfico.
  const diasOrdenados = [...dias].sort();
  const serieDe = (nome) =>
    diasOrdenados.map((date) => {
      const v = porDia.get(nome)?.get(date) || zeroC();
      return {
        date,
        spend: r2(v.spend),
        convValue: r2(v.convValue),
        conversions: r2(v.conversions),
        roas: v.spend > 0 ? v.convValue / v.spend : null,
      };
    });

  // O bruto fica guardado à parte: agregar somando valores já arredondados
  // erra centavos no total, e total que não fecha com a soma das linhas é o
  // tipo de coisa que faz você desconfiar da tela inteira — com razão.
  const bruto = new Map();

  const campanhas = [...porCampanha.entries()]
    .map(([campanha, v]) => {
      bruto.set(campanha, v);
      return {
        campanha,
        tipo: tipoDaCampanha(campanha),
        produto: produtoDaCampanha(campanha, mapa),
        ...derivadas(v),
        serie: serieDe(campanha),
      };
    })
    // por take rate: o que interessa é quanto cada campanha SOBRA, não o ROAS
    // isolado. Uma 3,0x que gasta R$ 90 importa menos que uma 1,42x que sobra
    // R$ 5,7 mil.
    .sort((a, b) => (b.takeRate ?? -Infinity) - (a.takeRate ?? -Infinity));

  const agrega = (filtro) =>
    derivadas(
      campanhas
        .filter(filtro)
        .reduce((a, c) => somaC(a, bruto.get(c.campanha) || zeroC()), zeroC())
    );

  const tipos = [...new Set(campanhas.map((c) => c.tipo))]
    .map((tipo) => ({ tipo, ...agrega((c) => c.tipo === tipo) }))
    .sort((a, b) => b.spend - a.spend);

  const produtos = [...new Set(campanhas.map((c) => c.produto).filter(Boolean))]
    .map((produto) => ({
      produto,
      campanhas: campanhas.filter((c) => c.produto === produto).map((c) => c.campanha),
      ...agrega((c) => c.produto === produto),
    }))
    .sort((a, b) => (b.takeRate ?? -Infinity) - (a.takeRate ?? -Infinity));

  const genericas = {
    campanhas: campanhas.filter((c) => !c.produto).map((c) => c.campanha),
    ...agrega((c) => !c.produto),
  };

  return { campanhas, tipos, produtos, genericas, total: agrega(() => true) };
}

// Período imediatamente anterior, com o mesmo número de dias.
export function periodoAnterior(de, ate) {
  const dia = (s) => new Date(`${s}T12:00:00Z`);
  const iso = (d) => d.toISOString().slice(0, 10);
  const n = Math.round((dia(ate) - dia(de)) / 86400000) + 1;
  const fim = dia(de);
  fim.setUTCDate(fim.getUTCDate() - 1);
  const ini = new Date(fim);
  ini.setUTCDate(ini.getUTCDate() - (n - 1));
  return { de: iso(ini), ate: iso(fim) };
}

// Só o que a tela compara. Campanha que não existia antes fica sem `anterior`.
const resumo = (o) =>
  o ? { spend: o.spend, convValue: o.convValue, takeRate: o.takeRate, roas: o.roas } : null;

export function anexaAnterior(bloco, antes) {
  const por = (lista, chaveId) => new Map(lista.map((x) => [x[chaveId], x]));
  const camp = por(antes.campanhas, "campanha");
  const prod = por(antes.produtos, "produto");
  const tipo = por(antes.tipos, "tipo");
  for (const c of bloco.campanhas) c.anterior = resumo(camp.get(c.campanha));
  for (const p of bloco.produtos) p.anterior = resumo(prod.get(p.produto));
  for (const t of bloco.tipos) t.anterior = resumo(tipo.get(t.tipo));
  bloco.genericas.anterior = antes.genericas.campanhas.length ? resumo(antes.genericas) : null;
  bloco.total.anterior = antes.campanhas.length ? resumo(antes.total) : null;
  return bloco;
}

// Ação de conversão mal configurada: muitas conversões valendo quase nada.
// A [APP]_NewAppCampaign tinha 89 conversões somando R$ 1,00 — isso não é
// venda, é outro evento contado como conversão, e suja o total da conta.
export function detectaConversaoSuspeita(campanhas, pisoTicket = 1) {
  return campanhas.filter((c) => c.conversions >= 10 && c.ticket != null && c.ticket < pisoTicket);
}

// ---------------------------------------------------------------- Postgres

async function detectaColunasView(client, view) {
  const [schema, nome] = view.includes(".") ? view.split(".") : ["public", view];
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    [schema.replace(/"/g, ""), nome.replace(/"/g, "")]
  );
  if (!rows.length) throw new Error(`view ${view} não encontrada`);
  const acha = (c) =>
    c.map((x) => rows.find((r) => r.column_name.toLowerCase() === x.toLowerCase())).find(Boolean);

  const data = acha(["paidAtBr", "paidAt", "paid_at", "createdAtBr", "createdAt"]);
  const valor = acha(["amount", "value", "valor", "total"]);
  const produto = acha(["productName", "product_name", "produto", "product", "plano"]);
  if (!data) throw new Error(`nenhuma coluna de data em ${view}`);
  return {
    data: data.column_name,
    dataTipo: data.data_type,
    valor: valor ? valor.column_name : null,
    produto: produto ? produto.column_name : null,
  };
}

export function exprDiaLocal(col, tipo) {
  const q = `"${col}"`;
  if (/Br$/.test(col)) return q;
  if (/with time zone/i.test(tipo)) return `(${q} AT TIME ZONE '${TZ}')`;
  return `((${q} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;
}

export function buildProdutoSql(view, cols, divisor = VIEW_DIVISOR) {
  const ts = exprDiaLocal(cols.data, cols.dataTipo);
  const valor = cols.valor ? `(COALESCE("${cols.valor}", 0)::numeric / ${divisor})` : `0::numeric`;
  const produto = cols.produto
    ? `COALESCE(NULLIF(btrim("${cols.produto}"::text), ''), 'sem produto')`
    : `'sem produto'::text`;
  return `
    SELECT ${produto} AS produto,
           count(*)   AS vendas,
           COALESCE(sum(${valor}), 0) AS receita
      FROM ${view}
     WHERE ${ts} >= $1::timestamp
       AND ${ts} <  ($2::timestamp + interval '1 day')
     GROUP BY 1
     ORDER BY 3 DESC`;
}

// ---------------------------------------------------------------- handler

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const ate = searchParams.get("to") || hoje;
  let de = searchParams.get("from");
  if (!de) {
    const d = new Date(`${ate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - Number(searchParams.get("dias") || 7));
    de = d.toISOString().slice(0, 10);
  }

  const avisos = [];
  const mapa = carregaMapa();
  if (process.env.CAMPANHA_PRODUTO_MAP && mapa === MAPA_PADRAO) {
    avisos.push("CAMPANHA_PRODUTO_MAP não é um JSON válido — usando o mapa padrão.");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);

  try {
    // Uma chamada só cobre o período e o anterior; a separação é por data.
    const antes = periodoAnterior(de, ate);
    const gads = await fetchCampanhas(antes.de, ate, ctrl.signal);
    if (gads.erro) {
      return NextResponse.json(
        { erro: `Google Ads indisponível: ${gads.erro}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const doPeriodo = (l) => {
      const dia = String(l.date ?? "").slice(0, 10);
      return !dia || dia >= de;
    };
    const bloco = anexaAnterior(
      montaCampanhas(gads.linhas.filter(doPeriodo), mapa),
      montaCampanhas(gads.linhas.filter((l) => !doPeriodo(l)), mapa)
    );

    // ---- produto pelo banco (verdade do caixa, sem atribuição) ----
    let produtosBanco = null;
    let colunas = null;
    let receitaBanco = null;
    if (process.env.DATABASE_URL) {
      const view = process.env.DB_PAID_VIEW || "public.vw_transactions_paid";
      const { Client } = await import("pg");
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: /sslmode=disable/.test(process.env.DATABASE_URL || "")
          ? false
          : { rejectUnauthorized: false },
      });
      try {
        await client.connect();
        colunas = await detectaColunasView(client, view);
        const { rows } = await client.query(buildProdutoSql(view, colunas), [de, ate]);
        produtosBanco = rows.map((r) => ({
          produto: r.produto,
          vendas: Number(r.vendas),
          receita: r2(r.receita),
          ticket: Number(r.vendas) > 0 ? r2(Number(r.receita) / Number(r.vendas)) : null,
        }));
        receitaBanco = r2(produtosBanco.reduce((a, p) => a + p.receita, 0));
        if (!colunas.produto) {
          avisos.push(
            `A view ${view} não tem coluna de produto — tudo cai em "sem produto". ` +
              `Se o nome for outro, aponte em DB_PRODUTO_COL.`
          );
        }
        // Mesma armadilha dos centavos que já me pegou: ticket absurdo = divisor errado
        const ticketGeral =
          produtosBanco.reduce((a, p) => a + p.vendas, 0) > 0
            ? receitaBanco / produtosBanco.reduce((a, p) => a + p.vendas, 0)
            : 0;
        if (ticketGeral > 500) {
          avisos.push(
            `Ticket médio de R$ ${r2(ticketGeral).toLocaleString("pt-BR")} — valor provavelmente ` +
              `em centavos nesta view. Ajuste DB_VIEW_AMOUNT_DIVISOR=100.`
          );
        }
      } catch (e) {
        avisos.push(`Produtos pelo banco indisponíveis: ${String(e?.message || e)}`);
      } finally {
        await client.end().catch(() => {});
      }
    }

    // ---- a conferência que dá credibilidade ao ROAS por campanha ----
    let conferencia = null;
    if (receitaBanco != null && receitaBanco > 0) {
      const casamento = bloco.total.convValue / receitaBanco;
      conferencia = {
        receitaBanco,
        valorConversaoGoogle: bloco.total.convValue,
        casamento,
        ok: casamento >= 0.85 && casamento <= 1.15,
      };
      if (!conferencia.ok) {
        avisos.push(
          `O valor de conversão do Google (R$ ${bloco.total.convValue.toLocaleString("pt-BR")}) ` +
            `está ${(casamento * 100).toFixed(0)}% da receita real do banco ` +
            `(R$ ${receitaBanco.toLocaleString("pt-BR")}). Enquanto estiver longe de 100%, ` +
            `o ROAS por campanha serve para COMPARAR campanhas entre si, não como valor absoluto. ` +
            `Vale checar a conversão offline.`
        );
      }
    }

    const suspeitas = detectaConversaoSuspeita(bloco.campanhas);
    for (const c of suspeitas) {
      avisos.push(
        `"${c.campanha}": ${c.conversions} conversões somando apenas ` +
          `R$ ${c.convValue.toLocaleString("pt-BR")} (R$ ${c.ticket} por conversão). ` +
          `Isso é ação de conversão mal configurada, não venda — e está entrando no total da conta.`
      );
    }

    return NextResponse.json(
      {
        periodo: { de, ate },
        periodoAnterior: antes,
        roasAlvo: ROAS_ALVO,
        ...bloco,
        produtosBanco,
        conferencia,
        colunas,
        mapaProduto: mapa,
        avisos,
        geradoEm: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      { erro: String(e?.message || e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  } finally {
    clearTimeout(timer);
  }
}
