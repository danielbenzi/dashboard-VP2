"use client";

import { useEffect, useMemo, useState } from "react";

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
function fmtRoas(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(2) + "x";
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function Page() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  async function load(f = from, t = to) {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/dashboard?from=${f}&to=${t}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Falha ao carregar");
      setData(json);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyPreset(p) {
    const t = today();
    let f = firstOfMonth();
    if (p === "7d") {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      f = d.toISOString().slice(0, 10);
    } else if (p === "30d") {
      const d = new Date();
      d.setDate(d.getDate() - 29);
      f = d.toISOString().slice(0, 10);
    }
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
            {data?.updatedAt && (
              <>
                {" "}
                · atualizado{" "}
                {new Date(data.updatedAt).toLocaleString("pt-BR")}
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
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? "Carregando…" : "Atualizar"}
          </button>
        </div>
      </div>

      {err && <div className="banner">Erro: {err}</div>}
      {data?.errors?.length > 0 && (
        <div className="banner">
          Algumas fontes não responderam:
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
          <BrandBlock brand={data.total} color="#c9d4e8" />
          <ChartCard series={data.total.series} title="Total — dia a dia" />

          <BrandBlock brand={data.brands[0]} color="var(--processo)" />
          <ChartCard
            series={data.brands[0].series}
            title={`${data.brands[0].name} — dia a dia`}
          />

          <BrandBlock brand={data.brands[1]} color="var(--placa)" />
          <ChartCard
            series={data.brands[1].series}
            title={`${data.brands[1].name} — dia a dia`}
          />
        </>
      )}
    </div>
  );
}

function BrandBlock({ brand, color }) {
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
          label="Transações"
          value={fmtNum(brand.transactions)}
          sub={brand.ticket != null ? `Ticket ${fmtMoney(brand.ticket)}` : null}
        />
        <Card label="CPA" value={fmtMoney(brand.cpa)} />
        <Card label="ROAS" value={fmtRoas(brand.roas)} />
      </div>
    </>
  );
}

function Card({ label, value, sub }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function ChartCard({ series, title }) {
  const [hover, setHover] = useState(null);

  const W = 1080;
  const H = 260;
  const pad = { t: 16, r: 16, b: 28, l: 56 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const points = series || [];
  const maxVal = useMemo(() => {
    let m = 0;
    for (const p of points) m = Math.max(m, p.spend, p.revenue);
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

  const linePath = (key) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`)
      .join(" ");

  const ticks = 4;
  const gridVals = Array.from({ length: ticks + 1 }, (_, i) => (maxVal / ticks) * i);

  return (
    <div className="chart-card" style={{ position: "relative" }}>
      <div className="legend">
        <strong style={{ color: "var(--text)", marginRight: "auto" }}>
          {title}
        </strong>
        <span>
          <i style={{ background: "#5b9dff" }} /> Gasto
        </span>
        <span>
          <i style={{ background: "#36d399" }} /> Receita paga
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
          </g>
        ))}

        <path d={linePath("spend")} fill="none" stroke="#5b9dff" strokeWidth="2.5" />
        <path
          d={linePath("revenue")}
          fill="none"
          stroke="#36d399"
          strokeWidth="2.5"
        />

        {points.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.spend)} r="2.5" fill="#5b9dff" />
            <circle cx={x(i)} cy={y(p.revenue)} r="2.5" fill="#36d399" />
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
              {p.date.slice(8, 10)}/{p.date.slice(5, 7)}
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
          <b>
            {points[hover.i].date.slice(8, 10)}/{points[hover.i].date.slice(5, 7)}
          </b>
          <div className="t-row">Gasto: {fmtMoney(points[hover.i].spend)}</div>
          <div className="t-row">Receita: {fmtMoney(points[hover.i].revenue)}</div>
          <div className="t-row">
            Transações: {fmtNum(points[hover.i].transactions)}
          </div>
        </div>
      )}
    </div>
  );
}
