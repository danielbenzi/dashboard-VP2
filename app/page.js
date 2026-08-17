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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
