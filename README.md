# 📡 Radar Cripto

App para iPhone (PWA — instalado pelo Safari, sem App Store) que **avisa quando uma criptomoeda está boa para compra**, com base em estatística e teste no histórico, não em palpite.

- Gráficos em tempo real, coloridos e interativos (arraste o dedo para ver preço e data)
- Preço ao vivo, máxima e mínima histórica, máx./mín. 24h, volume, valor de mercado
- **Estratégia validada em estudo**: repique após pânico de mercado (queda ≥25% em 30 dias + RSI<30 + várias moedas caindo juntas) — 60% de acerto em 7 dias vs 47% de um dia qualquer, em 30 moedas desde 2017
- **Histórico de alertas** (aba Sinais): registro oficial gravado pelo robô no momento de cada alerta (`data/alerts-log.json`, com histórico no Git) e simulação de todos os alertas que a regra teria dado nos últimos ~2,7 anos, com o resultado de cada um
- **Clima do mercado**: Índice de Medo e Ganância, tendência do Bitcoin e quantas moedas estão em pânico; em baixa longa do BTC os alertas são pausados (nesse clima o repique não teve vantagem)
- Distância do gatilho (0–100) por moeda + explicação curta do porquê
- **Simulação**: digite quanto quer investir e veja cenários pessimista/provável/otimista e a chance de lucro, baseados em casos reais
- **Carteira fictícia com painel**: saldo virtual (R$ 10.000 por padrão), compras e vendas que mexem no saldo, gráfico de evolução do patrimônio, distribuição por moeda, lucro realizado/não realizado, ativos agrupados por moeda e histórico de movimentações
- **Avisos de venda**: cada compra simulada tem stop (limita a perda) e alvo (realiza o lucro), ajustáveis; o app e o robô avisam quando o preço bater um deles ou quando o prazo de 7 dias acabar
- **Alertas de preço manuais**: "me avise se o BTC passar de R$ 600 mil" — com atalhos de ±5/10%, linha no gráfico e lista no Início
- Notificações push no iPhone, mesmo com o app fechado
- Visual escuro inspirado em carteiras como a Phantom, com ícone de cada moeda

- **Favoritas**: toque na ☆ de qualquer moeda para fixá-la no topo; filtre os sinais por favoritas
- **Adicionar moedas**: em Ajustes › Moedas acompanhadas, busque qualquer par com USDT da Binance

Moedas padrão (30): BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK, DOT, LTC, TRX, SUI, NEAR, TON, POL, BCH, XLM, HBAR, SHIB, PEPE, UNI, AAVE, ATOM, APT, ARB, OP, ICP, FET, RENDER (edite `js/coins.js` para mudar a lista padrão).

### Notificações de moedas extras e "só favoritas"
O código do aparelho (Ajustes › Gerar código) leva junto suas moedas adicionadas, suas favoritas e se você quer ser avisado de **todas** ou **só das favoritas**. O robô lê isso do segredo `PUSH_SUBSCRIPTIONS`. Sempre que mudar essas escolhas, o app avisa para gerar o código de novo e atualizar o segredo.

## Como colocar no ar (uma vez só)

1. **Junte este código na branch `main`** (o site e o robô de alertas rodam a partir dela).
2. **Ative o GitHub Pages**: no repositório, vá em *Settings › Pages › Source* e escolha **GitHub Actions**.
   O app ficará em `https://<seu-usuario>.github.io/<repositório>/`.
   (Em repositório privado, o Pages exige plano pago do GitHub; em público é grátis.)
3. **Crie o segredo da chave de notificação**: *Settings › Secrets and variables › Actions › New repository secret*
   - Nome: `VAPID_PRIVATE_KEY` — valor: a chave privada que acompanha este projeto (a pública já está em `js/config.js`).
   - Para gerar um par novo: `npx web-push generate-vapid-keys` e troque também a pública em `js/config.js`.

## Como instalar no iPhone

1. Abra o endereço do app no **Safari**.
2. Toque em **Compartilhar** › **Adicionar à Tela de Início**.
3. Abra o app pelo ícone, vá em **Ajustes › Ativar notificações** e permita.
4. Toque em **Copiar código** e salve no GitHub como segredo **`PUSH_SUBSCRIPTIONS`** (mesmo lugar do passo 3 acima).
5. Pronto: o robô (`.github/workflows/signals.yml`) analisa o mercado **a cada 30 minutos** e manda push quando aparecer uma oportunidade (no máximo 1 alerta por moeda a cada 24h). Você pode rodá-lo na mão em *Actions › Robô de alertas de compra › Run workflow* e ver o relatório de todas as moedas no log.

> Notificações push no iPhone exigem iOS 16.4+ e o app instalado na Tela de Início.

## Como o app decide

Resumo em [METODOLOGIA.md](METODOLOGIA.md). Código em `js/analysis.js` (o mesmo arquivo é usado pelo app e pelo robô).

## Desenvolvimento

```bash
npm install
npm test          # testes do motor estatístico
npm start         # servidor local em http://localhost:8080
npm run signals   # roda o robô localmente (sem segredos ele só imprime o relatório)
```

Dados: Binance (`data-api.binance.vision`, público, tempo real via WebSocket) e CoinGecko (ícones, máxima/mínima histórica, valor de mercado).

## ⚠️ Aviso

Estatística reduz o “chute”, mas **não elimina o risco**. Resultados passados não garantem resultados futuros. Use como apoio à decisão, invista só o que pode perder e respeite o stop sugerido. Não é recomendação de investimento.
