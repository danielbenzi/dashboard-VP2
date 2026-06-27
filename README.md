# Dashboard — Verifica Processo & Verifica Placa

Dashboard simples e sempre atualizado com **gasto, transações, CPA, ROAS e receita paga**
por marca (Verifica Processo e Verifica Placa). Os dados vêm de:

- **Google Ads** (gasto, cliques, impressões) → via API do **Windsor.ai**
- **AbacatePay** (transações pagas e receita) → via API do **AbacatePay**, uma chave por marca

Feito em Next.js, pronto para deploy na **Vercel**. As chaves ficam só no servidor
(variáveis de ambiente) — nunca aparecem no navegador.

---

## Métricas

Por marca e no total consolidado:

| Métrica         | Como é calculada                                            |
| --------------- | ---------------------------------------------------------- |
| **Gasto**       | Soma do `spend` do Google Ads no período                    |
| **Receita paga**| Soma das cobranças com status `PAID` no AbacatePay          |
| **Transações**  | Quantidade de cobranças `PAID` no AbacatePay                |
| **CPA**         | Gasto ÷ Transações                                          |
| **ROAS**        | Receita paga ÷ Gasto                                        |
| **Ticket médio**| Receita paga ÷ Transações                                   |

Tem ainda o gráfico **dia a dia** (gasto x receita) para o total e para cada marca,
e um seletor de período (Mês atual, Últimos 7 dias, Últimos 30 dias ou datas personalizadas).
O padrão é **mês atual**.

---

## Passo a passo do deploy na Vercel

### 1. Pegar suas chaves

- **Windsor.ai:** entre no painel do Windsor → seção de API / Onboarding API → copie a `api_key`.
- **AbacatePay:** no painel ([app.abacatepay.com](https://app.abacatepay.com)) → Integração → Chaves de API.
  Você tem **uma conta por marca**, então copie a chave de **cada** conta:
  uma da Verifica Processo e outra da Verifica Placa.
  (Use chaves de **Produção** para ver dados reais.)

### 2. Subir o projeto

Opção mais fácil (sem terminal):

1. Crie um repositório no GitHub e suba esta pasta (`verifica-dashboard`).
2. Em [vercel.com](https://vercel.com) → **Add New… → Project** → importe esse repositório.
3. A Vercel detecta Next.js sozinha. **Não clique em Deploy ainda** — primeiro configure as variáveis (passo 3).

Opção via terminal (alternativa):

```bash
npm i -g vercel
cd verifica-dashboard
vercel
```

### 3. Configurar as variáveis de ambiente

Na Vercel: **Project → Settings → Environment Variables**. Adicione:

| Nome                     | Valor                                               |
| ------------------------ | --------------------------------------------------- |
| `WINDSOR_API_KEY`        | sua chave do Windsor.ai                              |
| `ABACATE_KEY_PROCESSO`   | chave do AbacatePay da conta **Verifica Processo**  |
| `ABACATE_KEY_PLACA`      | chave do AbacatePay da conta **Verifica Placa**     |
| `GADS_ACCOUNT_PROCESSO`  | `Verifica Processo` (só mude se renomear no Windsor)|
| `GADS_ACCOUNT_PLACA`     | `Verifica Placa` (só mude se renomear no Windsor)   |

Veja `.env.example` para o modelo. Depois de salvar, clique em **Deploy** (ou **Redeploy**).

### 4. Pronto

Abra a URL que a Vercel gerou. O dashboard busca os dados ao vivo toda vez que abre
ou que você clica em **Atualizar**.

---

## Rodar localmente (opcional)

```bash
cd verifica-dashboard
cp .env.example .env.local   # preencha suas chaves
npm install
npm run dev                  # http://localhost:3000
```

---

## Observações importantes

- **Receita = cobranças `PAID`.** O dashboard lê as *cobranças* (billing) do AbacatePay.
  Se você gera pagamentos pelo fluxo de **billing/checkout**, tudo aparece. Cobranças
  feitas só via PIX QR Code avulso (endpoint `pixQrCode`) **não** entram nessa lista.
- **Data da transação:** usamos a data de criação da cobrança (`createdAt`). Para PIX, o
  pagamento normalmente cai no mesmo dia, então fica fiel ao dia a dia. Reembolsos
  (`REFUNDED`) **não** contam como receita.
- **Moeda:** tudo em BRL (assume contas de Google Ads em reais).
- **Separação por marca:** gasto vem por `account_name` do Google Ads; receita vem da
  chave AbacatePay de cada marca. Por isso é importante usar a chave certa em cada variável.
- O endpoint `/billing/list` do AbacatePay retorna todas as cobranças; o filtro por período
  é feito no servidor. Se o volume crescer muito, vale migrar para uma base alimentada por
  webhook — posso te ajudar com isso depois.
```
