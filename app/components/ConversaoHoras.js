"use client";

// app/components/ConversaoHoras.js
//
//   <ConversaoHojeSection />      -> hoje, hora a hora (sempre hoje)
//   <ConversaoHistoricoSection /> -> dia da semana × hora, por dia da semana,
//                                    por hora e dia a dia
//
// As duas compartilham o mesmo fetch: /api/dashboard/horas é chamada UMA vez.

import { useEffect, useMemo, useState } from "react";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUM = new Intl.NumberFormat("pt-BR");
const fmtMoney = (v) => (v == null || !Number.isFinite(v) ? "—" : BRL.format(v));
const fmtNum = (v) => (v == null || !Number.isFinite(v) ? "—" : NUM.format(Math.round(v)));
const fmtPct = (v) =>
  v == null || !Number.isFinite(v) ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%";
const fmtRoas = (v) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(2) + "x");
const hhmm = (h) => String(h).padStart(2, "0") + "h";

// Rampa sequencial de UM tom, clara = melhor. Validada contra o fundo escuro:
// luminosidade monotônica, degraus separados, degrau mais escuro ainda visível
// contra a superfície (2,17:1). Um tom só resolve daltonismo de graça.
const RAMPA = ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"];
// Abaixo desse volume a célula não ganha cor: 2 de 2 pagas é 100% e não quer
// dizer nada. Fica hachurada e sai do cálculo das faixas.
const VOLUME_MINIMO = 5;

// ROAS de breakeven. Abaixo disso a hora queima dinheiro.
const ROAS_ALVO = 1.4;

// ------------------------------------------------------------- dados

let store = { dados: null, ouvintes: new Set(), buscando: false };

function useHoras() {
  const [, forca] = useState(0);

  useEffect(() => {
    const ouvinte = () => forca((n) => n + 1);
    store.ouvintes.add(ouvinte);

    if (!store.dados && !store.buscando) {
      store.buscando = true;
      fetch("/api/dashboard/horas", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => {
          store.dados = j.erro ? { erro: j.erro } : j;
        })
        .catch((e) => {
          store.dados = { erro: e.message };
        })
        .finally(() => {
          store.buscando = false;
          store.ouvintes.forEach((f) => f());
        });
    }
    return () => store.ouvintes.delete(ouvinte);
  }, []);

  const d = store.dados;
  return { d: d?.erro ? null : d, err: d?.erro || null, loading: !d };
}

function Avisos({ d }) {
  if (!d?.avisos?.length) return null;
  return (
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
  );
}

// ------------------------------------------------------------- hoje

export function ConversaoHojeSection() {
  const { d, err, loading } = useHoras();
  const horas = d?.hoje?.horas || [];

  // O máximo da barra ignora as horas de amostra baixa: uma hora com 1 de 1
  // paga marcaria 100% e esmagaria todas as barras reais contra o zero.
  const maxConv = Math.max(
    ...horas.filter((h) => h.criadas >= VOLUME_MINIMO).map((h) => h.conversao ?? 0),
    0.0001
  );

  const horaAtual = Number(
    new Date()
      .toLocaleString("en-CA", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false })
      .slice(-2)
  );

  return (
    <>
      <div className="section-title">
        <span className="dot" style={{ background: RAMPA[3] }} />
        Conversão de hoje, hora a hora
      </div>

      {loading && <div className="table-card loading">Carregando…</div>}
      {err && <div className="banner">Conversão por hora indisponível: {err}</div>}

      {d && (
        <div className="table-card">
          <div className="legend" style={{ display: "block", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--text)" }}>
              {d.hoje.date.slice(8, 10)}/{d.hoje.date.slice(5, 7)} ·{" "}
              {fmtPct(d.hoje.total.conversao)} ({fmtNum(d.hoje.total.pagas)} de{" "}
              {fmtNum(d.hoje.total.criadas)}) · {fmtMoney(d.hoje.total.receita)}
              {d.hoje.total.roas != null && <> · ROAS {fmtRoas(d.hoje.total.roas)}</>}
            </strong>
            <div style={{ marginTop: 4 }}>
              A hora é a da <strong>criação</strong> da cobrança, não a do pagamento:
              criada 14h50 e paga 15h10 conta inteira nas 14h. É o que responde qual
              horário converte — e é a mesma hora em que o anúncio gastou, então ROAS
              e take rate só fecham nessa base. Hora sem cobrança criada aparece
              como — , não como 0%.
            </div>
          </div>

          <Avisos d={d} />

          <div className="table-scroll">
            <table className="day-table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Criadas</th>
                  <th>Pagas</th>
                  <th>Conversão</th>
                  <th>Custo</th>
                  <th>Receita</th>
                  <th>Take rate</th>
                  <th>ROAS</th>
                  <th>Ticket</th>
                  <th>CPA</th>
                </tr>
              </thead>
              <tbody>
                {horas.map((h) => {
                  const passou = h.hora <= horaAtual;
                  const vazia = h.criadas === 0 && !(h.custo > 0);
                  // Mesma regra do heatmap: 1 de 2 pagas é 50% e não quer dizer
                  // nada. A barra some para não dar peso visual de hora boa; o
                  // número fica, porque numa tabela ele é honesto.
                  const pouco = h.criadas > 0 && h.criadas < VOLUME_MINIMO;
                  return (
                    <tr
                      key={h.hora}
                      style={{ opacity: passou ? 1 : 0.35 }}
                      title={
                        !passou
                          ? "ainda não aconteceu hoje"
                          : pouco
                          ? `só ${h.criadas} cobrança(s) criada(s) — amostra pequena demais para ler como taxa`
                          : undefined
                      }
                    >
                      <td style={{ whiteSpace: "nowrap" }}>
                        {hhmm(h.hora)}
                        {h.hora === horaAtual && (
                          <span style={{ color: "var(--amber)" }}> ·agora</span>
                        )}
                      </td>
                      <td>{vazia ? "—" : fmtNum(h.criadas)}</td>
                      <td>{vazia ? "—" : fmtNum(h.pagas)}</td>
                      <td>
                        {h.conversao == null ? (
                          "—"
                        ) : (
                          <span
                            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                flex: "0 0 auto",
                                width: pouco
                                  ? "56px"
                                  : `${Math.max(2, (h.conversao / maxConv) * 56)}px`,
                                height: 8,
                                borderRadius: 4,
                                background: pouco ? "transparent" : RAMPA[3],
                                border: pouco ? "1px dashed var(--muted)" : "none",
                              }}
                            />
                            <span
                              style={{
                                fontVariantNumeric: "tabular-nums",
                                color: pouco ? "var(--muted)" : undefined,
                              }}
                            >
                              {fmtPct(h.conversao)}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className={h.custo > 0 ? "neg" : undefined}>
                        {h.custo == null ? "—" : h.custo > 0 ? fmtMoney(h.custo) : "—"}
                      </td>
                      <td>{h.receita > 0 ? fmtMoney(h.receita) : "—"}</td>
                      <td className={h.takeRate == null ? undefined : h.takeRate >= 0 ? "pos" : "neg"}>
                        {fmtMoney(h.takeRate)}
                      </td>
                      <td
                        style={{
                          fontVariantNumeric: "tabular-nums",
                          color:
                            h.roas == null
                              ? undefined
                              : h.roas >= ROAS_ALVO
                              ? "var(--green)"
                              : "var(--red)",
                        }}
                        title={h.roas == null ? undefined : `breakeven em ${ROAS_ALVO}x`}
                      >
                        {fmtRoas(h.roas)}
                      </td>
                      <td>{fmtMoney(h.ticket)}</td>
                      <td>{fmtMoney(h.cpa)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------- histórico

const METRICAS = {
  conversao: {
    rot: "Conversão",
    get: (c) => c.conversao,
    fmt: fmtPct,
    legenda: ["menos", "mais converte"],
  },
  roas: {
    rot: "ROAS",
    get: (c) => c.roas,
    fmt: fmtRoas,
    legenda: ["pior", "melhor ROAS"],
  },
};

// Faixas por QUANTIL das células com volume. Faixa fixa não serve: se a
// conversão vive entre 48% e 56%, uma escala de 0 a 100% pinta tudo igual e o
// heatmap não mostra nada.
function fazFaixas(valores) {
  const v = valores.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < RAMPA.length) return null;
  const corte = [];
  for (let i = 1; i < RAMPA.length; i++) corte.push(v[Math.floor((v.length * i) / RAMPA.length)]);
  return corte;
}
const corDaFaixa = (valor, cortes) => {
  if (valor == null || !Number.isFinite(valor) || !cortes) return null;
  let i = 0;
  while (i < cortes.length && valor >= cortes[i]) i++;
  return RAMPA[i];
};

function TabelaLinhas({ linhas, rotulo, chave }) {
  return (
    <div className="table-scroll">
      <table className="day-table">
        <thead>
          <tr>
            <th>{rotulo}</th>
            <th>Criadas</th>
            <th>Pagas</th>
            <th>Conversão</th>
            <th>Custo</th>
            <th>Receita</th>
            <th>Take rate</th>
            <th>ROAS</th>
            <th>Ticket</th>
            <th>CPA</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((r) => (
            <tr key={r[chave]}>
              <td style={{ whiteSpace: "nowrap" }}>{r.__rot}</td>
              <td>{fmtNum(r.criadas)}</td>
              <td>{fmtNum(r.pagas)}</td>
              <td style={{ fontVariantNumeric: "tabular-nums" }}>{fmtPct(r.conversao)}</td>
              <td className={r.custo > 0 ? "neg" : undefined}>{fmtMoney(r.custo)}</td>
              <td>{fmtMoney(r.receita)}</td>
              <td className={r.takeRate == null ? undefined : r.takeRate >= 0 ? "pos" : "neg"}>
                {fmtMoney(r.takeRate)}
              </td>
              <td
                style={{
                  fontVariantNumeric: "tabular-nums",
                  color:
                    r.roas == null ? undefined : r.roas >= ROAS_ALVO ? "var(--green)" : "var(--red)",
                }}
              >
                {fmtRoas(r.roas)}
              </td>
              <td>{fmtMoney(r.ticket)}</td>
              <td>{fmtMoney(r.cpa)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConversaoHistoricoSection() {
  const { d, err, loading } = useHoras();
  const [aba, setAba] = useState("matriz");
  const [metrica, setMetrica] = useState("conversao");

  const hist = d?.historico;
  const M = METRICAS[metrica];

  const cortes = useMemo(() => {
    if (!hist) return null;
    return fazFaixas(
      hist.matriz
        .flat()
        .filter((c) => c.criadas >= VOLUME_MINIMO)
        .map((c) => M.get(c))
    );
  }, [hist, metrica]);

  if (loading) return <div className="table-card loading">Carregando…</div>;
  if (err) return null; // o erro já apareceu na seção de hoje
  if (!hist) return null;

  const curto = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const semCusto = !d.custo?.confiavel;

  return (
    <>
      <div className="section-title">
        <span className="dot" style={{ background: RAMPA[1] }} />
        Conversão por dia da semana e hora
      </div>

      <div className="table-card">
        <div className="legend" style={{ display: "block", lineHeight: 1.5 }}>
          <strong style={{ color: "var(--text)" }}>
            Últimos {hist.dias} dias ({d.de.slice(8, 10)}/{d.de.slice(5, 7)} a{" "}
            {d.ate.slice(8, 10)}/{d.ate.slice(5, 7)}) · {fmtPct(hist.total.conversao)}
            {hist.total.roas != null && <> · ROAS {fmtRoas(hist.total.roas)}</>}
          </strong>
          <div style={{ marginTop: 4 }}>
            Hoje fica de fora: o dia está pela metade e puxaria a média da hora para
            baixo. Célula com menos de {VOLUME_MINIMO} cobranças criadas fica hachurada
            e <strong>sem cor</strong> — 2 de 2 pagas é 100% e não quer dizer nada. As
            faixas são quantis das células com volume, não uma escala fixa: se a
            conversão vive entre 48% e 56%, escala fixa pintaria tudo igual.
          </div>
        </div>

        <Avisos d={d} />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 12px" }}>
          {[
            ["matriz", "Dia × hora"],
            ["dow", "Por dia da semana"],
            ["hora", "Por hora"],
            ["dia", "Dia a dia"],
          ].map(([k, rot]) => (
            <button
              key={k}
              onClick={() => setAba(k)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid var(--border, rgba(255,255,255,0.12))",
                background: aba === k ? RAMPA[1] : "transparent",
                color: aba === k ? "#fff" : "var(--muted)",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              {rot}
            </button>
          ))}
        </div>

        {aba === "matriz" && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 10,
                flexWrap: "wrap",
                color: "var(--muted)",
                fontSize: 12,
              }}
            >
              <span>Colorir por:</span>
              {Object.entries(METRICAS).map(([k, m]) => (
                <button
                  key={k}
                  disabled={k === "roas" && semCusto}
                  onClick={() => setMetrica(k)}
                  title={
                    k === "roas" && semCusto
                      ? "o gasto por hora veio incompleto do Windsor"
                      : undefined
                  }
                  style={{
                    padding: "3px 10px",
                    borderRadius: 5,
                    border: "1px solid var(--border, rgba(255,255,255,0.12))",
                    background: metrica === k ? RAMPA[2] : "transparent",
                    color:
                      k === "roas" && semCusto
                        ? "rgba(255,255,255,0.25)"
                        : metrica === k
                        ? "#fff"
                        : "var(--muted)",
                    cursor: k === "roas" && semCusto ? "not-allowed" : "pointer",
                    font: "inherit",
                    fontSize: 12,
                  }}
                >
                  {m.rot}
                </button>
              ))}

              <span style={{ marginLeft: 8 }}>{M.legenda[0]}</span>
              {RAMPA.map((c, i) => (
                <span
                  key={c}
                  title={
                    cortes
                      ? i === 0
                        ? `até ${M.fmt(cortes[0])}`
                        : i === RAMPA.length - 1
                        ? `acima de ${M.fmt(cortes[cortes.length - 1])}`
                        : `${M.fmt(cortes[i - 1])} a ${M.fmt(cortes[i])}`
                      : undefined
                  }
                  style={{ width: 24, height: 10, borderRadius: 2, background: c }}
                />
              ))}
              <span>{M.legenda[1]}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 14,
                    height: 10,
                    borderRadius: 2,
                    border: "1px dashed var(--muted)",
                  }}
                />
                volume baixo
              </span>
            </div>

            <div className="table-scroll">
              <table className="day-table">
                <thead>
                  <tr>
                    <th />
                    {Array.from({ length: 24 }, (_, h) => (
                      <th
                        key={h}
                        style={{ textAlign: "center", padding: "4px 2px", fontWeight: 400 }}
                      >
                        {String(h).padStart(2, "0")}
                      </th>
                    ))}
                    <th style={{ textAlign: "right" }}>Dia</th>
                  </tr>
                </thead>
                <tbody>
                  {hist.matriz.map((linha, dow) => {
                    const resumo = hist.porDiaSemana[dow];
                    return (
                      <tr key={dow}>
                        <td style={{ whiteSpace: "nowrap", color: "var(--muted)" }}>
                          {curto[dow]}
                        </td>
                        {linha.map((c) => {
                          const pouco = c.criadas > 0 && c.criadas < VOLUME_MINIMO;
                          const cor = pouco ? null : corDaFaixa(M.get(c), cortes);
                          return (
                            <td key={c.hora} style={{ padding: 2 }}>
                              <div
                                title={
                                  c.criadas === 0 && !(c.custo > 0)
                                    ? `${curto[dow]} ${hhmm(c.hora)} — nada`
                                    : `${curto[dow]} ${hhmm(c.hora)} — ` +
                                      `${fmtPct(c.conversao)} · ${fmtNum(c.pagas)} de ${fmtNum(
                                        c.criadas
                                      )} · receita ${fmtMoney(c.receita)}` +
                                      (c.custo != null ? ` · custo ${fmtMoney(c.custo)}` : "") +
                                      (c.roas != null ? ` · ROAS ${fmtRoas(c.roas)}` : "") +
                                      (c.takeRate != null
                                        ? ` · take rate ${fmtMoney(c.takeRate)}`
                                        : "") +
                                      (pouco ? " · volume baixo, cor suprimida" : "")
                                }
                                style={{
                                  width: 22,
                                  height: 22,
                                  borderRadius: 4,
                                  background: cor || "transparent",
                                  border: pouco
                                    ? "1px dashed var(--muted)"
                                    : cor
                                    ? "none"
                                    : "1px solid rgba(255,255,255,0.07)",
                                }}
                              />
                            </td>
                          );
                        })}
                        <td
                          style={{
                            textAlign: "right",
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {M.fmt(M.get(resumo))}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ color: "var(--muted)" }}>hora</td>
                    {hist.porHora.map((h) => (
                      <td
                        key={h.hora}
                        style={{
                          padding: "4px 2px",
                          textAlign: "center",
                          fontSize: 10,
                          color: "var(--muted)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                        title={`${hhmm(h.hora)} — ${fmtPct(h.conversao)} · ROAS ${fmtRoas(h.roas)}`}
                      >
                        {metrica === "conversao"
                          ? h.conversao == null
                            ? "—"
                            : Math.round(h.conversao * 100)
                          : h.roas == null
                          ? "—"
                          : h.roas.toFixed(1)}
                      </td>
                    ))}
                    <td style={{ textAlign: "right" }}>{M.fmt(M.get(hist.total))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}

        {aba === "dow" && (
          <TabelaLinhas
            rotulo="Dia da semana"
            chave="dow"
            linhas={[1, 2, 3, 4, 5, 6, 0].map((dow) => ({
              ...hist.porDiaSemana[dow],
              __rot: `${hist.porDiaSemana[dow].nome} (${hist.porDiaSemana[dow].diasNaBase})`,
            }))}
          />
        )}

        {aba === "hora" && (
          <TabelaLinhas
            rotulo="Hora"
            chave="hora"
            linhas={hist.porHora.map((r) => ({ ...r, __rot: hhmm(r.hora) }))}
          />
        )}

        {aba === "dia" && (
          <TabelaLinhas
            rotulo="Dia"
            chave="dia"
            linhas={hist.porDia
              .slice()
              .reverse()
              .map((r) => ({
                ...r,
                __rot: `${r.dia.slice(8, 10)}/${r.dia.slice(5, 7)} ${curto[r.dow]}`,
              }))}
          />
        )}
      </div>
    </>
  );
}
