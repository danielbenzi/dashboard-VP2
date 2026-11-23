// app/campanhas/page.js
//
// Página própria da aba Campanhas: /campanhas

import Link from "next/link";
import { CampanhasSection } from "../components/Campanhas";

export const metadata = {
  title: "Campanhas — Verifica Processo & Verifica Placa",
};

export default function CampanhasPage() {
  return (
    <div className="wrap">
      <nav className="abas">
        <Link className="aba" href="/">
          Visão geral
        </Link>
        <span className="aba ativa">Campanhas</span>
      </nav>
      <div className="topbar">
        <div className="title">
          <h1>Campanhas</h1>
          <p>ROAS, vendas e gasto por campanha, produto e tipo · Google Ads + Postgres</p>
        </div>
      </div>
      <CampanhasSection />
    </div>
  );
}
