import "./globals.css";

export const metadata = {
  title: "Dashboard — Verifica Processo & Verifica Placa",
  description: "Gasto, transações, CPA, ROAS e receita paga por marca",
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
