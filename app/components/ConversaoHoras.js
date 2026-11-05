"use client";

// app/components/ConversaoHoras.js
//
// Arquivo NOVO. Não encosta no page.js que já existe — ele só importa daqui.
//
//   <ConversaoHojeSection />      -> hoje, hora a hora (sempre hoje)
//   <ConversaoHistoricoSection /> -> dia da semana × hora, por dia da semana,
//                                    por hora e dia a dia
//
// As duas compartilham o mesmo fetch, então /api/dashboard/horas é chamada
// UMA vez, não duas.

import { useEffect, useMemo, useState } from "react";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUM = new Intl.NumberFormat("pt-BR");
const fmtMoney = (v) => (v == null || !Number.isFinite(v) ? "—" : BRL.format(v));
const fmtNum = (v) => (v == null || !Number.isFinite(v) ? "—" : NUM.format(Math.round(v)));
const fmtPct = (v) =>
  v == null || !Number.isFinite(v) ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%";

// Rampa sequencial de UM tom (azul), clara = converte mais. Validada contra o
// fundo escuro do dashboard: passa monotonia de luminosidade, gap entre
// degraus e contraste do degrau mais escuro contra a superfície.
const RAMPA = ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"];
// Abaixo desse volume de cobranças criadas a célula não ganha cor: 2 de 2 pagas
// é 100% e não quer dizer nada. Fica com hachura e sai do cálculo das faixas.
const VOLUME_MINIMO = 5;

let _cache = null;
function useHoras() {
  const [d, setD] = useState(_cache);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(!_cache);

  useEffect(() => {
    if (_cache) return;
    let vivo = true;
    fetch("/api/dashboard/horas", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!vivo) return;
        if (j.erro) setErr(j.erro);
        else {
          _cache = j;
          setD(j);
        }
      })
      .catch((e) => vivo && setErr(e.message))
      .finally(() => vivo && setLoading(false));
    return () => {
      vivo = false;
    };
  }, []);

  return { d, err, loading };
}

const hhmm = (h) => String(h).padStart(2, "0") + "h";

// Faixas por QUANTIL das células com volume suficiente. Faixa fixa não serve:
// se a conversão vive entre 52% e 58%, uma escala de 0 a 100% pinta tudo igual
// e o heatmap não mostra nada.
function fazFaixas(valores) {
  const v = valores.filter((x) => x != null).sort((a, b) => a - b);
  if (v.length < RAMPA.length) return null;
  const corte = [];
  for (let i = 1; i < RAMPA.length; i++) {
    corte.push(v[Math.floor((v.length * i) / RAMPA.length)]);
  }
  return corte;
}
const corDaFaixa = (valor, cortes) => {
  if (valor == null || !cortes) return null;
  let i = 0;
  while (i < cortes.length && valor >= cortes[i]) i++;
  return RAMPA[i];
};

export function ConversaoHojeSection() {
  const { d, err, loading } = useHoras();
  const horas = d?.hoje?.horas || [];
  // O máximo da barra ignora as horas de amostra baixa: uma hora com 1 de 1
  // paga marcaria 100% e esmagaria todas as barras reais contra o zero.
  const maxConv = Math.max(
    ...horas
      .filter((h) => h.criadas >= VOLUME_MINIMO)
      .map((h) => h.conversao ?? 0),
    0.0001
  );
  const agora = new Date().toLocaleString("en-CA", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hour12: false,
  });
  const horaAtual = Number(String(agora).slice(-2));

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
              {fmtPct(d.hoje.total.conversao)} no dia ({fmtNum(d.hoje.total.pagas)} de{" "}
              {fmtNum(d.hoje.total.criadas)})
            </strong>
            <div style={{ marginTop: 4 }}>
              A hora é a da <strong>criação</strong> da cobrança, não a do pagamento:
              uma cobrança criada 14h50 e paga 15h10 conta inteira nas 14h — é o que
              responde qual horário converte. Hora sem cobrança criada aparece como
              — , não como 0%.
            </div>
          </div>
          <div className="table-scroll">
            <table className="day-table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Criadas</th>
                  <th>Pagas</th>
                  <th>Conversão</th>
                  <th>Receita</th>
                  <th>Ticket</th>
                </tr>
              </thead>
              <tbody>
                {horas.map((h) => {
                  const passou = h.hora <= horaAtual;
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
                      <td>{h.criadas > 0 ? fmtNum(h.criadas) : "—"}</td>
                      <td>{h.criadas > 0 ? fmtNum(h.pagas) : "—"}</td>
                      <td>
                        {h.conversao == null ? (
                          "—"
                        ) : (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              width: "100%",
                            }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                flex: "0 0 auto",
                                width: pouco
                                  ? "64px"
                                  : `${Math.max(2, (h.conversao / maxConv) * 64)}px`,
                                height: 8,
                                borderRadius: 4,
                                background: pouco ? "transparent" : RAMPA[3],
                                border: pouco
                                  ? "1px dashed var(--muted)"
                                  : "none",
                              }}
                            />
                            <span
                              style={{
                                fontVariantNumeric: "tabular-nums",
                                color: pouco ? "var(--muted)" : undefined,
                              }}
                            >
                              {fmtPct(h.conversao)}
                              {pouco && (
                                <span style={{ fontSize: 11 }}> ·amostra baixa</span>
                              )}
                            </span>
                          </span>
                        )}
                      </td>
                      <td>{h.receita > 0 ? fmtMoney(h.receita) : "—"}</td>
                      <td>{h.ticket == null ? "—" : fmtMoney(h.ticket)}</td>
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

export function ConversaoHistoricoSection() {
  const { d, err, loading } = useHoras();
  const [aba, setAba] = useState("matriz");

  const hist = d?.historico;
  const cortes = useMemo(() => {
    if (!hist) return null;
    return fazFaixas(
      hist.matriz
        .flat()
        .filter((c) => c.criadas >= VOLUME_MINIMO)
        .map((c) => c.conversao)
    );
  }, [hist]);

  if (loading) return <div className="table-card loading">Carregando…</div>;
  if (err) return null; // o erro já apareceu na seção de hoje
  if (!hist) return null;

  const curto = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

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
            {d.ate.slice(8, 10)}/{d.ate.slice(5, 7)}) · {fmtPct(hist.total.conversao)}{" "}
            no período
          </strong>
          <div style={{ marginTop: 4 }}>
            Hoje fica de fora: o dia está pela metade e puxaria a média da hora para
            baixo. Célula com menos de {VOLUME_MINIMO} cobranças criadas fica
            hachurada e <strong>sem cor</strong> — 2 de 2 pagas é 100% e não quer
            dizer nada. As faixas de cor são quantis das células com volume, não uma
            escala de 0 a 100%: se a conversão vive entre 52% e 58%, uma escala fixa
            pintaria tudo igual.
          </div>
        </div>

        <div className="bar" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 12px" }}>
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
            {/* Legenda da rampa: sem ela a cor não significa nada */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 10,
                color: "var(--muted)",
                fontSize: 12,
              }}
            >
              <span>menos</span>
              {RAMPA.map((c, i) => (
                <span
                  key={c}
                  title={
                    cortes
                      ? i === 0
                        ? `até ${fmtPct(cortes[0])}`
                        : i === RAMPA.length - 1
                        ? `acima de ${fmtPct(cortes[cortes.length - 1])}`
                        : `${fmtPct(cortes[i - 1])} a ${fmtPct(cortes[i])}`
                      : undefined
                  }
                  style={{ width: 26, height: 10, borderRadius: 2, background: c }}
                />
              ))}
              <span>mais converte</span>
              <span style={{ marginLeft: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
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
                      <th key={h} style={{ textAlign: "center", padding: "4px 2px", fontWeight: 400 }}>
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
                          const cor = pouco ? null : corDaFaixa(c.conversao, cortes);
                          return (
                            <td key={c.hora} style={{ padding: 2 }}>
                              <div
                                title={
                                  c.criadas === 0
                                    ? `${curto[dow]} ${hhmm(c.hora)} — nenhuma cobrança criada`
                                    : `${curto[dow]} ${hhmm(c.hora)} — ${fmtPct(
                                        c.conversao
                                      )} · ${fmtNum(c.pagas)} de ${fmtNum(
                                        c.criadas
                                      )} · ${fmtMoney(c.receita)}${
                                        pouco ? " · volume baixo, cor suprimida" : ""
                                      }`
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
                          {fmtPct(resumo.conversao)}
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
                        title={`${hhmm(h.hora)} — ${fmtNum(h.pagas)} de ${fmtNum(h.criadas)}`}
                      >
                        {h.conversao == null ? "—" : Math.round(h.conversao * 100)}
                      </td>
                    ))}
                    <td style={{ textAlign: "right" }}>{fmtPct(hist.total.conversao)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}

        {aba === "dow" && (
          <div className="table-scroll">
            <table className="day-table">
              <thead>
                <tr>
                  <th>Dia da semana</th>
                  <th>Dias na base</th>
                  <th>Criadas</th>
                  <th>Pagas</th>
                  <th>Conversão</th>
                  <th>Receita</th>
                  <th>Ticket</th>
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4, 5, 6, 0].map((dow) => {
                  const r = hist.porDiaSemana[dow];
                  return (
                    <tr key={dow}>
                      <td>{r.nome}</td>
                      <td>{fmtNum(r.diasNaBase)}</td>
                      <td>{fmtNum(r.criadas)}</td>
                      <td>{fmtNum(r.pagas)}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>
                        {fmtPct(r.conversao)}
                      </td>
                      <td>{fmtMoney(r.receita)}</td>
                      <td>{r.ticket == null ? "—" : fmtMoney(r.ticket)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {aba === "hora" && (
          <div className="table-scroll">
            <table className="day-table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Criadas</th>
                  <th>Pagas</th>
                  <th>Conversão</th>
                  <th>Receita</th>
                  <th>Ticket</th>
                </tr>
              </thead>
              <tbody>
                {hist.porHora.map((r) => (
                  <tr key={r.hora}>
                    <td>{hhmm(r.hora)}</td>
                    <td>{fmtNum(r.criadas)}</td>
                    <td>{fmtNum(r.pagas)}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>
                      {fmtPct(r.conversao)}
                    </td>
                    <td>{fmtMoney(r.receita)}</td>
                    <td>{r.ticket == null ? "—" : fmtMoney(r.ticket)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {aba === "dia" && (
          <div className="table-scroll">
            <table className="day-table">
              <thead>
                <tr>
                  <th>Dia</th>
                  <th>Criadas</th>
                  <th>Pagas</th>
                  <th>Conversão</th>
                  <th>Receita</th>
                  <th>Ticket</th>
                </tr>
              </thead>
              <tbody>
                {hist.porDia
                  .slice()
                  .reverse()
                  .map((r) => (
                    <tr key={r.dia}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {r.dia.slice(8, 10)}/{r.dia.slice(5, 7)}{" "}
                        <span style={{ color: "var(--muted)" }}>{curto[r.dow]}</span>
                      </td>
                      <td>{fmtNum(r.criadas)}</td>
                      <td>{fmtNum(r.pagas)}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>
                        {fmtPct(r.conversao)}
                      </td>
                      <td>{fmtMoney(r.receita)}</td>
                      <td>{r.ticket == null ? "—" : fmtMoney(r.ticket)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
