"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const NUM = new Intl.NumberFormat("pt-BR");

function fmtMoney(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return BRL.format(v);
}
function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return NUM.format(Math.round(v));
}
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(1).replace(".", ",") + "%";
}
function fmtRoas(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(2) + "x";
}
function fmtDate(d) {
  return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
}

// datas sempre em America/Sao_Paulo (mesmo fuso usado pela API)
const TZ = "America/Sao_Paulo";
function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}
function firstOfMonth() {
  const [y, m] = today().split("-");
  return `${y}-${m}-01`;
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

export default function Page() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const abortRef = useRef(null);

  // force=true (botão Atualizar): manda ?refresh=1, que faz a API ignorar
  // todos os caches e buscar os dados na hora
  async function load(f = from, t = to, force = false) {
    // cancela request anterior ainda em andamento
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // rede de segurança: a API tem orçamento próprio (~45s) e sempre responde
    // antes disso; se mesmo assim nada voltar, aborta com mensagem clara em vez
    // de deixar a tela em "Carregando…" para sempre
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 60000);

    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/dashboard?from=${f}&to=${t}${force ? "&refresh=1" : ""}`,
        {
          signal: ctrl.signal,
          cache: "no-store",
        }
      );
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* resposta não-JSON (ex.: página de erro 504 da Vercel) */
      }
      if (!res.ok) {
        throw new Error(
          json?.error ||
            (res.status === 504
              ? "O servidor demorou demais para responder. Tente novamente."
              : `Falha ao carregar (HTTP ${res.status})`)
        );
      }
      if (!json) throw new Error("Resposta inválida do servidor.");
      setData(json);
    } catch (e) {
      if (e.name === "AbortError") {
        // abortado pela rede de segurança (≠ cancelado por um request novo)
        if (!timedOut) return;
        setErr("O servidor demorou demais para responder. Tente novamente.");
      } else {
        setErr(e.message);
      }
    } finally {
      clearTimeout(killer);
      if (abortRef.current === ctrl) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyPreset(p) {
    const t = today();
    let f = firstOfMonth();
    if (p === "7d") f = daysAgo(6);
    else if (p === "30d") f = daysAgo(29);
    setFrom(f);
    setTo(t);
    load(f, t);
  }

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="title">
          <h1>Verifica Processo &amp; Verifica Placa</h1>
          <p>
            Gasto, transações, CPA, ROAS e receita paga · Google Ads + AbacatePay
            + PushinPay + Stripe
            {data?.updatedAt && (
              <>
                {" "}
                · atualizado{" "}
                {new Date(data.updatedAt).toLocaleString("pt-BR", {
                  timeZone: TZ,
                })}
              </>
            )}
          </p>
        </div>
        <div className="controls">
          <select onChange={(e) => applyPreset(e.target.value)} defaultValue="mes">
            <option value="mes">Mês atual</option>
            <option value="7d">Últimos 7 dias</option>
            <option value="30d">Últimos 30 dias</option>
          </select>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <button
            className="btn"
            onClick={() => load(from, to, true)}
            disabled={loading}
          >
            {loading ? "Carregando…" : "Atualizar"}
          </button>
        </div>
      </div>

      {err && (
        <div className="banner">
          Erro: {err}{" "}
          <button className="btn" onClick={() => load(from, to, true)}>
            Tentar de novo
          </button>
        </div>
      )}
      {data?.errors?.length > 0 && (
        <div className="banner">
          Algumas fontes não responderam (números podem estar incompletos):
          <ul>
            {data.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {loading && !data && <div className="loading">Carregando dados…</div>}

      {data && (
        <>
          <Section brand={data.total} color="#c9d4e8" title="Total" />
          <Section
            brand={data.brands[0]}
            color="var(--processo)"
            title={data.brands[0].name}
          />
          <Section
            brand={data.brands[1]}
            color="var(--placa)"
            title={data.brands[1].name}
          />
          <RepeatSection />
        </>
      )}
    </div>
  );
}

// Recompra por e-mail — vem do Postgres (view vw_transactions_paid), não das
// APIs de pagamento. Mesma rota do dashboard, ramo ?repeat=1, mas buscada
// separadamente para não segurar o resto da tela.
function RepeatSection() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let vivo = true;
    fetch("/api/dashboard?repeat=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!vivo) return;
        if (j.erro) setErr(j.erro);
        else setD(j);
      })
      .catch((e) => vivo && setErr(e.message))
      .finally(() => vivo && setLoading(false));
    return () => {
      vivo = false;
    };
  }, []);

  return (
    <>
      <div className="section-title">
        <span className="dot" style={{ background: "var(--amber)" }} />
        Recompra por e-mail
      </div>

      {loading && <div className="table-card loading">Consultando o banco…</div>}

      {err && (
        <div className="banner">
          Recompra indisponível: {err}
        </div>
      )}

      {d && (
        <div className="table-card">
          <div className="legend" style={{ display: "block", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--text)" }}>
              De cada compra, quantas voltaram em até N dias
            </strong>
            <div style={{ marginTop: 4 }}>
              {fmtNum(d.totalCompras)} compras de {fmtNum(d.totalEmails)} e-mails
              nos últimos {d.lookbackDias} dias. Cada compra é uma âncora: a
              pergunta é se aquele e-mail comprou de novo dentro da janela.
            </div>
            <div style={{ marginTop: 4 }}>
              Compras recentes demais para terem completado a janela ficam de
              fora da contagem — por isso "âncoras" cai nas janelas longas. Sem
              isso, 90 dias apareceria menor do que é.
            </div>
          </div>
          <div className="table-scroll">
            <table className="day-table">
              <thead>
                <tr>
                  <th>Janela</th>
                  <th>Âncoras</th>
                  <th>Com recompra</th>
                  <th>Taxa</th>
                  <th></th>
                  <th>Compras por e-mail</th>
                </tr>
              </thead>
              <tbody>
                {d.janelas.map((j) => (
                  <tr key={j.dias}>
                    <td>{j.dias} dias</td>
                    <td>{fmtNum(j.ancoras)}</td>
                    <td>{fmtNum(j.comRecompra)}</td>
                    <td>{fmtPct(j.taxa)}</td>
                    <td style={{ width: "34%" }}>
                      <span className="bar">
                        <i style={{ width: `${Math.min(100, (j.taxa || 0) * 100)}%` }} />
                      </span>
                    </td>
                    <td>
                      {j.comprasPorEmail == null
                        ? "—"
                        : j.comprasPorEmail.toFixed(2).replace(".", ",")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ brand, color, title }) {
  return (
    <>
      <BrandBlock brand={brand} color={color} />
      <SourceBreakdown sources={brand.sources} total={brand.revenue} />
      <ChartCard series={brand.series} title={`${title} — dia a dia`} />
      <DayTable series={brand.series} title={`${title} — tabela dia a dia`} />
    </>
  );
}

// De onde veio cada real. Uma fonte com R$ 0,00 (ou ausente da lista) é o
// sinal de que ela está desligada, falhando ou sem chave configurada —
// sem isso, receita faltando parece simplesmente venda fraca.
function SourceBreakdown({ sources, total }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="table-card">
      <div className="legend">
        <strong style={{ color: "var(--text)" }}>Receita por fonte</strong>
      </div>
      <div className="table-scroll">
        <table className="day-table">
          <thead>
            <tr>
              <th>Fonte</th>
              <th>Receita</th>
              <th>% do total</th>
              <th>Transações</th>
              <th>Ticket</th>
              <th>Criadas</th>
              <th>Pagas</th>
              <th>Conversão</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.source}>
                <td>{s.source}</td>
                <td>{fmtMoney(s.revenue)}</td>
                <td>{total > 0 ? ((s.revenue / total) * 100).toFixed(1) + "%" : "—"}</td>
                <td>{fmtNum(s.transactions)}</td>
                <td>
                  {fmtMoney(s.transactions > 0 ? s.revenue / s.transactions : null)}
                </td>
                <td>{s.created > 0 ? fmtNum(s.created) : "—"}</td>
                <td>{s.created > 0 ? fmtNum(s.convPaid) : "—"}</td>
                <td>{fmtPct(s.created > 0 ? s.convPaid / s.created : null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BrandBlock({ brand, color }) {
  const takeRate = brand.revenue - brand.spend;
  const margin =
    brand.revenue > 0 ? ((takeRate / brand.revenue) * 100).toFixed(0) : null;
  return (
    <>
      <div className="section-title">
        <span className="dot" style={{ background: color }} />
        {brand.name}
      </div>
      <div className="cards">
        <Card label="Gasto" value={fmtMoney(brand.spend)} />
        <Card label="Receita paga" value={fmtMoney(brand.revenue)} />
        <Card
          label="Take rate"
          value={fmtMoney(takeRate)}
          valueColor={takeRate >= 0 ? "var(--green)" : "var(--red)"}
          sub={margin != null ? `${margin}% da receita` : null}
        />
        <Card
          label="Transações"
          value={fmtNum(brand.transactions)}
          sub={brand.ticket != null ? `Ticket ${fmtMoney(brand.ticket)}` : null}
        />
        <Card label="CPA" value={fmtMoney(brand.cpa)} />
        <Card label="ROAS" value={fmtRoas(brand.roas)} />
        <Card
          label="Conversão"
          value={fmtPct(brand.conversion)}
          sub={
            brand.created > 0
              ? `${fmtNum(brand.convPaid)} pagas de ${fmtNum(brand.created)} criadas`
              : "sem dados de cobranças criadas"
          }
        />
      </div>
    </>
  );
}

function Card({ label, value, sub, valueColor }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

// enriquece a série diária com CPA e ROAS calculados
function enrich(series) {
  return (series || []).map((p) => ({
    ...p,
    cpa: p.transactions > 0 ? p.spend / p.transactions : null,
    roas: p.spend > 0 ? p.revenue / p.spend : null,
    takeRate: p.revenue - p.spend,
    conversion: p.created > 0 ? p.convPaid / p.created : null,
  }));
}

function DayTable({ series, title }) {
  const rows = useMemo(() => enrich(series).slice().reverse(), [series]);

  if (rows.length === 0) return null;

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const tSpend = sum("spend");
  const tRevenue = sum("revenue");
  const tTx = sum("transactions");
  const tCreated = sum("created");
  const tConvPaid = sum("convPaid");

  return (
    <div className="table-card">
      <div className="legend">
        <strong style={{ color: "var(--text)" }}>{title}</strong>
      </div>
      <div className="table-scroll">
        <table className="day-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Gasto</th>
              <th>Receita</th>
              <th>Take rate</th>
              <th>Transações</th>
              <th>Ticket</th>
              <th>CPA</th>
              <th>ROAS</th>
              <th>Criadas</th>
              <th>Conversão</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date}>
                <td>{fmtDate(r.date)}</td>
                <td>{fmtMoney(r.spend)}</td>
                <td>{fmtMoney(r.revenue)}</td>
                <td className={r.takeRate >= 0 ? "pos" : "neg"}>
                  {fmtMoney(r.takeRate)}
                </td>
                <td>{fmtNum(r.transactions)}</td>
                <td>
                  {fmtMoney(r.transactions > 0 ? r.revenue / r.transactions : null)}
                </td>
                <td>{fmtMoney(r.cpa)}</td>
                <td>{fmtRoas(r.roas)}</td>
                <td>{r.created > 0 ? fmtNum(r.created) : "—"}</td>
                <td>{fmtPct(r.conversion)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td>{fmtMoney(tSpend)}</td>
              <td>{fmtMoney(tRevenue)}</td>
              <td className={tRevenue - tSpend >= 0 ? "pos" : "neg"}>
                {fmtMoney(tRevenue - tSpend)}
              </td>
              <td>{fmtNum(tTx)}</td>
              <td>{fmtMoney(tTx > 0 ? tRevenue / tTx : null)}</td>
              <td>{fmtMoney(tTx > 0 ? tSpend / tTx : null)}</td>
              <td>{fmtRoas(tSpend > 0 ? tRevenue / tSpend : null)}</td>
              <td>{tCreated > 0 ? fmtNum(tCreated) : "—"}</td>
              <td>{fmtPct(tCreated > 0 ? tConvPaid / tCreated : null)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

const C_SPEND = "#5b9dff";
const C_REVENUE = "#36d399";
const C_CPA = "#fbbd23";
const C_ROAS = "#a78bfa";

function ChartCard({ series, title }) {
  const [hover, setHover] = useState(null);

  const W = 1080;
  const H = 260;
  const pad = { t: 16, r: 48, b: 28, l: 56 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const points = useMemo(() => enrich(series), [series]);

  // eixo esquerdo: R$ (gasto/receita) · eixo direito: CPA (R$) e ROAS (x)
  const maxVal = useMemo(() => {
    let m = 0;
    for (const p of points) m = Math.max(m, p.spend, p.revenue);
    return m || 1;
  }, [points]);
  const maxR = useMemo(() => {
    let m = 0;
    for (const p of points) m = Math.max(m, p.cpa || 0, p.roas || 0);
    return m || 1;
  }, [points]);

  if (points.length === 0) {
    return (
      <div className="chart-card">
        <div className="legend">
          <strong style={{ color: "var(--text)" }}>{title}</strong>
        </div>
        <div className="loading">Sem dados no período.</div>
      </div>
    );
  }

  const x = (i) =>
    pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / maxVal) * ih;
  const yR = (v) => pad.t + ih - (v / maxR) * ih;

  const linePath = (key, scale = y) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${scale(p[key]).toFixed(1)}`)
      .join(" ");

  // caminho que pula pontos nulos (dias sem transação não têm CPA/ROAS)
  const gapPath = (key, scale) => {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (v == null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"} ${x(i).toFixed(1)} ${scale(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const ticks = 4;
  const gridVals = Array.from({ length: ticks + 1 }, (_, i) => (maxVal / ticks) * i);

  return (
    <div className="chart-card" style={{ position: "relative" }}>
      <div className="legend">
        <strong style={{ color: "var(--text)", marginRight: "auto" }}>
          {title}
        </strong>
        <span>
          <i style={{ background: C_SPEND }} /> Gasto
        </span>
        <span>
          <i style={{ background: C_REVENUE }} /> Receita paga
        </span>
        <span>
          <i style={{ background: C_CPA }} /> CPA
        </span>
        <span>
          <i style={{ background: C_ROAS }} /> ROAS
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block" }}
        onMouseLeave={() => setHover(null)}
      >
        {gridVals.map((g, i) => (
          <g key={i}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(g)}
              y2={y(g)}
              stroke="#243044"
              strokeWidth="1"
            />
            <text
              x={pad.l - 8}
              y={y(g) + 4}
              fill="#8b97ab"
              fontSize="11"
              textAnchor="end"
            >
              {g >= 1000 ? (g / 1000).toFixed(1) + "k" : Math.round(g)}
            </text>
            <text
              x={W - pad.r + 8}
              y={y(g) + 4}
              fill="#8b97ab"
              fontSize="11"
              textAnchor="start"
            >
              {(((maxR / ticks) * i) || 0).toFixed(1)}
            </text>
          </g>
        ))}

        <path d={linePath("spend")} fill="none" stroke={C_SPEND} strokeWidth="2.5" />
        <path
          d={linePath("revenue")}
          fill="none"
          stroke={C_REVENUE}
          strokeWidth="2.5"
        />
        <path
          d={gapPath("cpa", yR)}
          fill="none"
          stroke={C_CPA}
          strokeWidth="2"
          strokeDasharray="5 4"
        />
        <path
          d={gapPath("roas", yR)}
          fill="none"
          stroke={C_ROAS}
          strokeWidth="2"
          strokeDasharray="5 4"
        />

        {points.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.spend)} r="2.5" fill={C_SPEND} />
            <circle cx={x(i)} cy={y(p.revenue)} r="2.5" fill={C_REVENUE} />
            {p.cpa != null && (
              <circle cx={x(i)} cy={yR(p.cpa)} r="2" fill={C_CPA} />
            )}
            {p.roas != null && (
              <circle cx={x(i)} cy={yR(p.roas)} r="2" fill={C_ROAS} />
            )}
            <rect
              x={x(i) - (iw / points.length) / 2}
              y={pad.t}
              width={iw / points.length}
              height={ih}
              fill="transparent"
              onMouseEnter={() => setHover({ i, px: x(i) })}
            />
          </g>
        ))}

        {points.map((p, i) =>
          i % Math.ceil(points.length / 10) === 0 ? (
            <text
              key={i}
              x={x(i)}
              y={H - 8}
              fill="#8b97ab"
              fontSize="10"
              textAnchor="middle"
            >
              {fmtDate(p.date)}
            </text>
          ) : null
        )}
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{
            left: `${(hover.px / W) * 100}%`,
            top: 70,
          }}
        >
          <b>{fmtDate(points[hover.i].date)}</b>
          <div className="t-row">Gasto: {fmtMoney(points[hover.i].spend)}</div>
          <div className="t-row">Receita: {fmtMoney(points[hover.i].revenue)}</div>
          <div className="t-row">
            Take rate: {fmtMoney(points[hover.i].takeRate)}
          </div>
          <div className="t-row">
            Transações: {fmtNum(points[hover.i].transactions)}
          </div>
          <div className="t-row">
            Conversão: {fmtPct(points[hover.i].conversion)}
            {points[hover.i].created > 0 &&
              ` (${fmtNum(points[hover.i].convPaid)}/${fmtNum(points[hover.i].created)})`}
          </div>
          <div className="t-row">CPA: {fmtMoney(points[hover.i].cpa)}</div>
          <div className="t-row">ROAS: {fmtRoas(points[hover.i].roas)}</div>
        </div>
      )}
    </div>
  );
}
