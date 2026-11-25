"use client";

// app/components/Campanhas.js
//
//   <CampanhasSection />  -> aba de campanhas: ROAS, vendas e gasto por
//                            campanha, por produto e por tipo
//
// Monta sozinha o próprio fetch em /api/dashboard/campanhas.

import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUM = new Intl.NumberFormat("pt-BR");
const fmtMoney = (v) => (v == null || !Number.isFinite(v) ? "—" : BRL.format(v));
const fmtNum = (v) => (v == null || !Number.isFinite(v) ? "—" : NUM.format(Math.round(v)));
const fmtPct = (v) =>
  v == null || !Number.isFinite(v) ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%";
const fmtRoas = (v) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(2) + "x");

const AZUL = "#3987e5";
const AZUL_ESCURO = "#256abf";

// Se esta seção quebrar, quebra só ela — nunca o dashboard inteiro.
class Isola extends Component {
  constructor(p) {
    super(p);
    this.state = { erro: null };
  }
  static getDerivedStateFromError(erro) {
    return { erro };
  }
  componentDidCatch(erro, info) {
    console.error("[Campanhas] quebrou:", erro, info);
  }
  render() {
    if (this.state.erro) {
      return (
        <div className="table-card" style={{ color: "var(--muted)", fontSize: 13 }}>
          <strong style={{ color: "var(--amber)" }}>A aba de campanhas não carregou.</strong>{" "}
          O resto do dashboard continua funcionando. Erro:{" "}
          <code>{String(this.state.erro?.message || this.state.erro)}</code>
        </div>
      );
    }
    return this.props.children;
  }
}

const JANELAS = [
  { dias: 7, rot: "7 dias" },
  { dias: 14, rot: "14 dias" },
  { dias: 30, rot: "30 dias" },
];

function Botao({ ativo, children, ...resto }) {
  return (
    <button
      {...resto}
      style={{
        padding: "6px 12px",
        borderRadius: 6,
        border: "1px solid var(--border, rgba(255,255,255,0.12))",
        background: ativo ? AZUL_ESCURO : "transparent",
        color: ativo ? "#fff" : "var(--muted)",
        cursor: "pointer",
        font: "inherit",
        ...(resto.style || {}),
      }}
    >
      {children}
    </button>
  );
}

// ROAS abaixo do alvo é dinheiro queimado: verde/vermelho sem meio-termo.
const corRoas = (v, alvo) =>
  v == null ? undefined : v >= alvo ? "var(--green)" : "var(--red)";

// Variação contra o período anterior. `melhorQuando` diz para que lado é bom:
// "maior" (ROAS, take rate) ou null (gasto — nem bom nem ruim).
function Delta({ atual, anterior, melhorQuando }) {
  if (
    atual == null || anterior == null ||
    !Number.isFinite(atual) || !Number.isFinite(anterior) || anterior === 0
  ) {
    return null;
  }
  const variacao = (atual - anterior) / Math.abs(anterior);
  if (!Number.isFinite(variacao) || variacao === 0) return null;
  const subiu = variacao > 0;
  const bom = melhorQuando === "maior" ? subiu : null;
  const cor = bom == null ? "var(--muted)" : bom ? "var(--green)" : "var(--red)";
  return (
    <div style={{ color: cor, fontSize: 11, fontWeight: 400 }}>
      {subiu ? "▲" : "▼"} {Math.abs(variacao * 100).toFixed(1).replace(".", ",")}%
    </div>
  );
}

const C_GASTO = "#5b9dff";
const C_RECEITA = "#36d399";
const C_EIXO = "#8b97ab";
const C_GRADE = "#243044";
const fmtDia = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const fmtEixo = (v) => (v >= 1000 ? (v / 1000).toFixed(1).replace(".", ",") + "k" : String(Math.round(v)));

// Evolução dia a dia de uma campanha. Dois gráficos empilhados com o mesmo
// eixo de datas: R$ (gasto e receita) em cima, ROAS embaixo. São escalas
// diferentes, então cada uma tem o seu eixo em vez de dividir um só.
function Evolucao({ serie, alvo }) {
  const [hover, setHover] = useState(null);
  const pontos = serie || [];
  if (pontos.length < 2) {
    return (
      <div style={{ color: "var(--muted)", fontSize: 12, padding: "4px 0" }}>
        Evolução dia a dia precisa de pelo menos dois dias no período.
      </div>
    );
  }

  const W = 1000;
  const pad = { l: 52, r: 16 };
  const iw = W - pad.l - pad.r;
  const x = (i) => pad.l + (i / (pontos.length - 1)) * iw;
  const passo = Math.ceil(pontos.length / 10);

  const maxReais = Math.max(1, ...pontos.map((p) => Math.max(p.spend, p.convValue)));
  const maxRoas = Math.max(alvo * 1.25, ...pontos.map((p) => p.roas || 0));

  const caminho = (valor, y) => {
    let d = "";
    let caneta = false;
    pontos.forEach((p, i) => {
      const v = valor(p);
      if (v == null || !Number.isFinite(v)) {
        caneta = false;
        return;
      }
      d += `${caneta ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      caneta = true;
    });
    return d.trim();
  };

  // Função comum, não componente: um componente declarado aqui dentro seria
  // remontado a cada hover e o ponteiro perderia o alvo.
  const painel = ({ altura, max, fmt, children, comDatas }) => {
    const pt = 10;
    const pb = comDatas ? 22 : 8;
    const ih = altura - pt - pb;
    const y = (v) => pt + ih - (v / max) * ih;
    return (
      <svg viewBox={`0 0 ${W} ${altura}`} width="100%" style={{ display: "block" }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke={C_GRADE} />
            <text x={pad.l - 8} y={y(max * f) + 4} fill={C_EIXO} fontSize="11" textAnchor="end">
              {fmt(max * f)}
            </text>
          </g>
        ))}
        {children(y, pt, ih)}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={pt} y2={pt + ih} stroke={C_EIXO} strokeDasharray="3 3" />
        )}
        {comDatas &&
          pontos.map((p, i) =>
            i % passo === 0 ? (
              <text key={p.date} x={x(i)} y={altura - 6} fill={C_EIXO} fontSize="10" textAnchor="middle">
                {fmtDia(p.date)}
              </text>
            ) : null
          )}
        {pontos.map((p, i) => (
          <rect
            key={p.date}
            x={x(i) - iw / (pontos.length - 1) / 2}
            y={pt}
            width={iw / (pontos.length - 1)}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
    );
  };

  const h = hover != null ? pontos[hover] : null;
  const item = (cor, rot) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <i style={{ width: 10, height: 2, background: cor, display: "inline-block" }} />
      {rot}
    </span>
  );

  return (
    <div style={{ whiteSpace: "normal" }} onMouseLeave={() => setHover(null)}>
      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          color: "var(--muted)",
          fontSize: 12,
          marginBottom: 4,
          minHeight: 18,
        }}
      >
        {item(C_GASTO, "Gasto")}
        {item(C_RECEITA, "Receita")}
        {h && (
          <span style={{ color: "var(--text)", marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
            {fmtDia(h.date)} · gasto {fmtMoney(h.spend)} · receita {fmtMoney(h.convValue)} · ROAS{" "}
            {fmtRoas(h.roas)} · {fmtNum(h.conversions)} vendas
          </span>
        )}
      </div>
      {painel({
        altura: 150,
        max: maxReais,
        fmt: fmtEixo,
        children: (y) => (
          <>
            <path d={caminho((p) => p.spend, y)} fill="none" stroke={C_GASTO} strokeWidth="2" />
            <path d={caminho((p) => p.convValue, y)} fill="none" stroke={C_RECEITA} strokeWidth="2" />
            {h && (
              <>
                <circle cx={x(hover)} cy={y(h.spend)} r="4" fill={C_GASTO} stroke="var(--panel)" strokeWidth="2" />
                <circle cx={x(hover)} cy={y(h.convValue)} r="4" fill={C_RECEITA} stroke="var(--panel)" strokeWidth="2" />
              </>
            )}
          </>
        ),
      })}
      <div style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 4px" }}>
        ROAS por dia · linha tracejada = alvo {String(alvo).replace(".", ",")}x
      </div>
      {painel({
        altura: 120,
        max: maxRoas,
        fmt: (v) => v.toFixed(1).replace(".", ",") + "x",
        comDatas: true,
        children: (y) => (
          <>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(alvo)}
              y2={y(alvo)}
              stroke={C_EIXO}
              strokeDasharray="6 4"
            />
            <path d={caminho((p) => p.roas, y)} fill="none" stroke="var(--text)" strokeWidth="2" />
            {h && h.roas != null && (
              <circle cx={x(hover)} cy={y(h.roas)} r="4" fill="var(--text)" stroke="var(--panel)" strokeWidth="2" />
            )}
          </>
        ),
      })}
    </div>
  );
}

// Colunas da tabela. `chave` é o campo usado na ordenação.
const COLUNAS = [
  { chave: "spend", rot: "Gasto" },
  { chave: "convValue", rot: "Receita" },
  { chave: "takeRate", rot: "Take rate" },
  { chave: "lucro", rot: "Lucro" },
  { chave: "roas", rot: "ROAS" },
  { chave: "conversions", rot: "Vendas" },
  { chave: "cpa", rot: "CPA" },
  { chave: "ticket", rot: "Ticket" },
  { chave: "clicks", rot: "Cliques" },
  { chave: "cpc", rot: "CPC" },
  { chave: "cvr", rot: "Conv. do clique" },
];

// Lucro = take rate menos o imposto sobre a receita. Sem alíquota, sem lucro.
const comLucro = (l, aliquota) => ({
  ...l,
  lucro:
    aliquota == null || l.takeRate == null ? null : l.takeRate - l.convValue * aliquota,
});

function Celulas({ l, alvo }) {
  const sinal = (v) => (v == null ? undefined : v >= 0 ? "pos" : "neg");
  return (
    <>
      <td className="neg">
        {fmtMoney(l.spend)}
        <Delta atual={l.spend} anterior={l.anterior?.spend} melhorQuando={null} />
      </td>
      <td>{fmtMoney(l.convValue)}</td>
      <td className={sinal(l.takeRate)}>
        {fmtMoney(l.takeRate)}
        <Delta atual={l.takeRate} anterior={l.anterior?.takeRate} melhorQuando="maior" />
      </td>
      <td className={sinal(l.lucro)}>{fmtMoney(l.lucro)}</td>
      <td style={{ fontWeight: 600, color: corRoas(l.roas, alvo) }} title={`alvo ${alvo}x`}>
        {fmtRoas(l.roas)}
        <Delta atual={l.roas} anterior={l.anterior?.roas} melhorQuando="maior" />
      </td>
      <td>{fmtNum(l.conversions)}</td>
      <td>{fmtMoney(l.cpa)}</td>
      <td>{fmtMoney(l.ticket)}</td>
      <td>{fmtNum(l.clicks)}</td>
      <td>{fmtMoney(l.cpc)}</td>
      <td>{fmtPct(l.cvr)}</td>
    </>
  );
}

function Linhas({ linhas, rotulo, alvo, chaveId, total, aliquota, expansivel }) {
  // Padrão: take rate, do maior para o menor.
  const [ordem, setOrdem] = useState({ chave: "takeRate", desc: true });
  const [aberta, setAberta] = useState(null);

  // A tabela pode ser mais larga que a área visível (rola na horizontal). O
  // gráfico da linha aberta ocupa a largura VISÍVEL e fica preso à esquerda,
  // senão metade dele some para fora da tela.
  const rolagem = useRef(null);
  const [largura, setLargura] = useState(null);
  useEffect(() => {
    const el = rolagem.current;
    if (!el) return;
    const mede = () => setLargura(el.clientWidth);
    mede();
    const obs = new ResizeObserver(mede);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const ordenadas = useMemo(() => {
    const lista = linhas.map((l) => comLucro(l, aliquota));
    const { chave, desc } = ordem;
    const valor = (l) => (chave === "__nome" ? String(l.__rot ?? l[chaveId]) : l[chave]);
    return lista.sort((a, b) => {
      const va = valor(a);
      const vb = valor(b);
      // sem valor vai sempre para o fim, em qualquer direção
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = typeof va === "string" ? va.localeCompare(vb, "pt-BR") : va - vb;
      return desc ? -c : c;
    });
  }, [linhas, aliquota, ordem, chaveId]);

  const ordenaPor = (chave) =>
    setOrdem((o) =>
      o.chave === chave ? { chave, desc: !o.desc } : { chave, desc: chave !== "__nome" }
    );
  const Cabecalho = ({ chave, children }) => {
    const ativa = ordem.chave === chave;
    return (
      <th aria-sort={ativa ? (ordem.desc ? "descending" : "ascending") : "none"}>
        <button
          type="button"
          onClick={() => ordenaPor(chave)}
          title="Ordenar por esta coluna"
          style={{
            all: "unset",
            cursor: "pointer",
            color: ativa ? "var(--text)" : "inherit",
          }}
        >
          {children}
          {ativa ? (ordem.desc ? " ▼" : " ▲") : ""}
        </button>
      </th>
    );
  };

  const totalComLucro = total ? comLucro(total, aliquota) : null;

  return (
    <div className="table-scroll" ref={rolagem}>
      <table className="day-table">
        <thead>
          <tr>
            <Cabecalho chave="__nome">{rotulo}</Cabecalho>
            {COLUNAS.map((c) => (
              <Cabecalho key={c.chave} chave={c.chave}>
                {c.rot}
              </Cabecalho>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordenadas.map((l) => {
            const id = l[chaveId];
            const estaAberta = expansivel && aberta === id;
            return (
              <Fragment key={id}>
                <tr>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {expansivel ? (
                      <button
                        type="button"
                        onClick={() => setAberta(estaAberta ? null : id)}
                        aria-expanded={estaAberta}
                        title="Ver evolução dia a dia"
                        style={{ all: "unset", cursor: "pointer", color: "var(--text)" }}
                      >
                        <span style={{ color: "var(--muted)", marginRight: 6 }}>
                          {estaAberta ? "▾" : "▸"}
                        </span>
                        {l.__rot ?? id}
                      </button>
                    ) : (
                      l.__rot ?? id
                    )}
                    {l.__sub && (
                      <div
                        style={{
                          color: "var(--muted)",
                          fontSize: 11,
                          whiteSpace: "normal",
                          maxWidth: 420,
                          marginLeft: expansivel ? 16 : 0,
                        }}
                      >
                        {l.__sub}
                      </div>
                    )}
                  </td>
                  <Celulas l={l} alvo={alvo} />
                </tr>
                {estaAberta && (
                  <tr>
                    <td
                      colSpan={COLUNAS.length + 1}
                      style={{ background: "var(--panel-2)", padding: "12px 0" }}
                    >
                      <div
                        style={{
                          position: "sticky",
                          left: 0,
                          width: largura || "100%",
                          padding: "0 16px",
                          boxSizing: "border-box",
                        }}
                      >
                        <Evolucao serie={l.serie} alvo={alvo} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        {totalComLucro && (
          <tfoot>
            <tr>
              <td>Total</td>
              <Celulas l={totalComLucro} alvo={alvo} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Conteudo() {
  // Ou um atalho (`dias`) ou um intervalo escolhido (`intervalo`), nunca os dois.
  const [dias, setDias] = useState(7);
  const [intervalo, setIntervalo] = useState(null);
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [aba, setAba] = useState("campanhas");
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [em, setEm] = useState(null);
  // Alíquota efetiva de imposto do período, a mesma da Visão geral.
  const [aliquota, setAliquota] = useState(null);

  const busca = useCallback(() => {
    setCarregando(true);
    setErr(null);
    const qs = intervalo ? `from=${intervalo.de}&to=${intervalo.ate}` : `dias=${dias}`;
    fetch(`/api/dashboard/campanhas?${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => (j.erro ? setErr(j.erro) : (setD(j), setEm(Date.now()))))
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setCarregando(false));
  }, [dias, intervalo]);

  useEffect(() => {
    busca();
  }, [busca]);

  // Os campos de data acompanham o período que a API de fato devolveu.
  useEffect(() => {
    if (d?.periodo) {
      setDe(d.periodo.de);
      setAte(d.periodo.ate);
    }
  }, [d]);

  // O imposto é calculado pela rota principal (regime, faixa, adicional); aqui
  // só se reaproveita a alíquota efetiva do mesmo período. Se ela não vier, a
  // coluna de lucro fica vazia em vez de mostrar um número inventado.
  const pDe = d?.periodo?.de;
  const pAte = d?.periodo?.ate;
  useEffect(() => {
    if (!pDe || !pAte) return;
    let vivo = true;
    setAliquota(null);
    fetch(`/api/dashboard?from=${pDe}&to=${pAte}&comparar=0`)
      .then((r) => r.json())
      .then((j) => {
        const t = j?.total?.taxRate;
        if (vivo && Number.isFinite(t)) setAliquota(t);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [pDe, pAte]);

  const intervaloValido = Boolean(de && ate && de <= ate);
  const aplicaIntervalo = () => {
    if (!intervaloValido) return;
    setDias(null);
    setIntervalo({ de, ate });
  };
  const estiloData = {
    background: "var(--panel-2)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "5px 8px",
    font: "inherit",
    colorScheme: "dark",
  };

  const alvo = d?.roasAlvo ?? 1.4;
  const conf = d?.conferencia;

  return (
    <>
      <div className="section-title">
        <span className="dot" style={{ background: AZUL }} />
        Campanhas
      </div>

      <div className="table-card">
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          {JANELAS.map((j) => (
            <Botao
              key={j.dias}
              ativo={!intervalo && dias === j.dias}
              onClick={() => {
                setIntervalo(null);
                setDias(j.dias);
              }}
            >
              {j.rot}
            </Botao>
          ))}
          <input
            type="date"
            aria-label="Data inicial"
            value={de}
            max={ate || undefined}
            onChange={(e) => setDe(e.target.value)}
            style={estiloData}
          />
          <span style={{ color: "var(--muted)" }}>a</span>
          <input
            type="date"
            aria-label="Data final"
            value={ate}
            min={de || undefined}
            onChange={(e) => setAte(e.target.value)}
            style={estiloData}
          />
          <Botao
            ativo={Boolean(intervalo)}
            onClick={aplicaIntervalo}
            disabled={!intervaloValido || carregando}
          >
            aplicar
          </Botao>
          <span style={{ flex: 1 }} />
          <Botao ativo={false} onClick={busca} disabled={carregando}>
            {carregando ? "atualizando…" : "atualizar"}
          </Botao>
        </div>

        {carregando && !d && <div className="loading">Carregando…</div>}
        {err && <div className="banner">Campanhas indisponíveis: {err}</div>}

        {d && (
          <>
            <div className="legend" style={{ display: "block", lineHeight: 1.5 }}>
              <strong style={{ color: "var(--text)" }}>
                {d.periodo.de.slice(8, 10)}/{d.periodo.de.slice(5, 7)} a{" "}
                {d.periodo.ate.slice(8, 10)}/{d.periodo.ate.slice(5, 7)} ·{" "}
                {fmtMoney(d.total.spend)} de gasto · {fmtMoney(d.total.convValue)} de receita ·{" "}
                <span style={{ color: corRoas(d.total.roas, alvo) }}>
                  ROAS {fmtRoas(d.total.roas)}
                </span>{" "}
                · sobra {fmtMoney(d.total.takeRate)}
              </strong>
              <div style={{ marginTop: 4 }}>
                Gasto e receita vêm do Google Ads. A receita é o{" "}
                <strong>valor de conversão</strong>, que é alimentado pela sua conversão
                offline — ou seja, são as suas vendas reais atribuídas pelo Google, por data
                do clique.
                {conf && (
                  <>
                    {" "}
                    No período, isso soma {fmtMoney(conf.valorConversaoGoogle)} contra{" "}
                    {fmtMoney(conf.receitaBanco)} de receita no banco —{" "}
                    <strong style={{ color: conf.ok ? "var(--green)" : "var(--amber)" }}>
                      {fmtPct(conf.casamento)} de casamento
                    </strong>
                    .
                  </>
                )}
              </div>
            </div>

            <div className="legend" style={{ display: "block", lineHeight: 1.5 }}>
              {d.periodoAnterior && (
                <>
                  As variações (▲▼) comparam com o período anterior de mesmo tamanho,{" "}
                  {d.periodoAnterior.de.slice(8, 10)}/{d.periodoAnterior.de.slice(5, 7)} a{" "}
                  {d.periodoAnterior.ate.slice(8, 10)}/{d.periodoAnterior.ate.slice(5, 7)}.{" "}
                </>
              )}
              {aliquota != null ? (
                <>
                  <strong>Lucro</strong> = take rate menos imposto de {fmtPct(aliquota)} sobre a
                  receita (alíquota efetiva da Visão geral no período). Não desconta custos
                  fixos.
                </>
              ) : (
                <>
                  <strong>Lucro</strong> fica vazio enquanto a alíquota de imposto do período
                  não chega da Visão geral.
                </>
              )}
            </div>

            {d.avisos?.length > 0 && (
              <div
                style={{
                  border: "1px solid rgba(237,161,0,0.35)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  margin: "0 0 12px",
                  color: "var(--muted)",
                  fontSize: 12.5,
                  lineHeight: 1.5,
                }}
              >
                {d.avisos.map((a, i) => (
                  <div key={i}>{a}</div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {[
                ["campanhas", "Por campanha"],
                ["produto", "Por produto"],
                ["tipo", "Por tipo"],
                ["banco", "Produtos no banco"],
              ].map(([k, rot]) => (
                <Botao key={k} ativo={aba === k} onClick={() => setAba(k)}>
                  {rot}
                </Botao>
              ))}
            </div>

            {aba === "campanhas" && (
              <>
                <div className="legend" style={{ display: "block", marginBottom: 8 }}>
                  Vem ordenado por <strong>take rate</strong>, não por ROAS: uma campanha de
                  3,0x que gasta R$ 90 importa menos que uma de 1,42x que sobra R$ 5,7 mil.
                  Clique num cabeçalho para ordenar por outra coluna, e numa campanha para
                  ver a evolução dia a dia.
                </div>
                <Linhas
                  chaveId="campanha"
                  rotulo="Campanha"
                  alvo={alvo}
                  total={d.total}
                  aliquota={aliquota}
                  expansivel
                  linhas={d.campanhas.map((c) => ({
                    ...c,
                    __rot: c.campanha,
                    __sub: c.produto ? c.produto : "genérica",
                  }))}
                />
              </>
            )}

            {aba === "produto" && (
              <>
                <div className="legend" style={{ display: "block", marginBottom: 8 }}>
                  ROAS por produto só existe para as campanhas que <strong>nomeiam</strong> o
                  produto. A transação guarda o identificador de clique, não o utm_campaign —
                  sem isso não há caminho de uma venda até a campanha dentro do banco. As
                  genéricas aparecem juntas no fim, sem rateio inventado.
                </div>
                <Linhas
                  chaveId="produto"
                  rotulo="Produto"
                  alvo={alvo}
                  total={d.total}
                  aliquota={aliquota}
                  linhas={[
                    ...d.produtos.map((p) => ({
                      ...p,
                      __rot: p.produto,
                      __sub: `${p.campanhas.length} campanha(s)`,
                    })),
                    {
                      ...d.genericas,
                      produto: "— genéricas (sem produto no nome)",
                      __rot: "Genéricas",
                      __sub: d.genericas.campanhas.join(" · "),
                    },
                  ]}
                />
              </>
            )}

            {aba === "tipo" && (
              <Linhas
                chaveId="tipo"
                rotulo="Tipo"
                alvo={alvo}
                total={d.total}
                aliquota={aliquota}
                linhas={d.tipos.map((t) => ({ ...t, __rot: t.tipo }))}
              />
            )}

            {aba === "banco" && (
              <>
                <div className="legend" style={{ display: "block", marginBottom: 8 }}>
                  Estes números vêm do <strong>Postgres</strong>, por data de pagamento: é o
                  caixa, sem atribuição nenhuma. Não têm gasto nem ROAS de propósito —
                  servem para ver o que mais vende e com que ticket.
                </div>
                {!d.produtosBanco?.length ? (
                  <div className="legend">Sem dados de produto no banco neste período.</div>
                ) : (
                  <div className="table-scroll">
                    <table className="day-table">
                      <thead>
                        <tr>
                          <th>Produto</th>
                          <th>Vendas</th>
                          <th>Receita</th>
                          <th>Ticket</th>
                          <th>% da receita</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const tot = d.produtosBanco.reduce((a, p) => a + p.receita, 0) || 1;
                          return d.produtosBanco.map((p) => (
                            <tr key={p.produto}>
                              <td>{p.produto}</td>
                              <td>{fmtNum(p.vendas)}</td>
                              <td>{fmtMoney(p.receita)}</td>
                              <td>{fmtMoney(p.ticket)}</td>
                              <td style={{ fontVariantNumeric: "tabular-nums" }}>
                                {fmtPct(p.receita / tot)}
                              </td>
                            </tr>
                          ));
                        })()}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 10 }}>
              atualizado às{" "}
              {em
                ? new Date(em).toLocaleTimeString("pt-BR", {
                    timeZone: "America/Sao_Paulo",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "—"}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function CampanhasSection() {
  return (
    <Isola>
      <Conteudo />
    </Isola>
  );
}
