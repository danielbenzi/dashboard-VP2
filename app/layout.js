import "./globals.css";

export const metadata = {
  title: "Dashboard — Verifica Processo",
  description: "Gasto, transações, CPA, ROAS e receita paga",
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
