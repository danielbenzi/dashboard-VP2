"use client";

// app/components/Campanhas.js
//
//   <CampanhasSection />  -> aba de campanhas: ROAS, vendas e gasto por
//                            campanha, por produto e por tipo
//
// Monta sozinha o próprio fetch em /api/dashboard/campanhas.

import { Component, useCallback, useEffect, useState } from "react";

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

function Linhas({ linhas, rotulo, alvo, chaveId }) {
  return (
    <div className="table-scroll">
      <table className="day-table">
        <thead>
          <tr>
            <th>{rotulo}</th>
            <th>Gasto</th>
            <th>Receita</th>
            <th>Take rate</th>
            <th>ROAS</th>
            <th>Vendas</th>
            <th>CPA</th>
            <th>Ticket</th>
            <th>Cliques</th>
            <th>CPC</th>
            <th>Conv. do clique</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l[chaveId]}>
              <td style={{ whiteSpace: "nowrap" }}>
                {l.__rot ?? l[chaveId]}
                {l.__sub && (
                  <div style={{ color: "var(--muted)", fontSize: 11 }}>{l.__sub}</div>
                )}
              </td>
              <td className="neg">{fmtMoney(l.spend)}</td>
              <td>{fmtMoney(l.convValue)}</td>
              <td className={l.takeRate == null ? undefined : l.takeRate >= 0 ? "pos" : "neg"}>
                {fmtMoney(l.takeRate)}
              </td>
              <td
                style={{
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 600,
                  color: corRoas(l.roas, alvo),
                }}
                title={`alvo ${alvo}x`}
              >
                {fmtRoas(l.roas)}
              </td>
              <td>{fmtNum(l.conversions)}</td>
              <td>{fmtMoney(l.cpa)}</td>
              <td>{fmtMoney(l.ticket)}</td>
              <td>{fmtNum(l.clicks)}</td>
              <td>{fmtMoney(l.cpc)}</td>
              <td style={{ fontVariantNumeric: "tabular-nums" }}>{fmtPct(l.cvr)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Conteudo() {
  const [dias, setDias] = useState(7);
  const [aba, setAba] = useState("campanhas");
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [em, setEm] = useState(null);

  const busca = useCallback(() => {
    setCarregando(true);
    setErr(null);
    fetch(`/api/dashboard/campanhas?dias=${dias}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => (j.erro ? setErr(j.erro) : (setD(j), setEm(Date.now()))))
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setCarregando(false));
  }, [dias]);

  useEffect(() => {
    busca();
  }, [busca]);

  const alvo = d?.roasAlvo ?? 1.4;
  const conf = d?.conferencia;

  return (
    <>
      <div className="section-title">
        <span className="dot" style={{ background: AZUL }} />
        Campanhas
      </div>

      <div className="table-card">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {JANELAS.map((j) => (
            <Botao key={j.dias} ativo={dias === j.dias} onClick={() => setDias(j.dias)}>
              {j.rot}
            </Botao>
          ))}
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
                <div className="legend" style={{ marginBottom: 8 }}>
                  Ordenado por <strong>take rate</strong>, não por ROAS: uma campanha de
                  3,0x que gasta R$ 90 importa menos que uma de 1,42x que sobra R$ 5,7 mil.
                </div>
                <Linhas
                  chaveId="campanha"
                  rotulo="Campanha"
                  alvo={alvo}
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
                <div className="legend" style={{ marginBottom: 8 }}>
                  ROAS por produto só existe para as campanhas que <strong>nomeiam</strong> o
                  produto. A transação guarda o identificador de clique, não o utm_campaign —
                  sem isso não há caminho de uma venda até a campanha dentro do banco. As
                  genéricas aparecem juntas no fim, sem rateio inventado.
                </div>
                <Linhas
                  chaveId="produto"
                  rotulo="Produto"
                  alvo={alvo}
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
                linhas={d.tipos.map((t) => ({ ...t, __rot: t.tipo }))}
              />
            )}

            {aba === "banco" && (
              <>
                <div className="legend" style={{ marginBottom: 8 }}>
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
