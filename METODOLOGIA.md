# Metodologia

O objetivo é responder: **"historicamente, comprar esta moeda numa situação como a de hoje deu lucro com mais frequência do que comprar num dia qualquer?"** Só há alerta quando a resposta é *sim* com amostra suficiente.

## 1. Pontuação (0–100)

Calculada com candles diários (até 1.000 dias da Binance).

| Grupo | Pts | Fatores | Base teórica |
|---|---|---|---|
| Tendência | 30 | Preço > média 200d (12) · média 50d > 200d (10) · média 200d subindo (8) | Filtros de tendência / médias móveis (Brock, Lakonishok & LeBaron 1992); time-series momentum (Moskowitz, Ooi & Pedersen 2012) |
| Momentum | 20 | Retorno 90d > 0 (6) · histograma MACD subindo (8) · MACD > sinal (6) | Momentum em cripto (Liu & Tsyvinski 2021, *Review of Financial Studies*) |
| Ponto de entrada | 25 | RSI(14) entre 30–50 (12; sobrecompra > 70 tira 10) · preço 0,3–2,2 desvios abaixo da média de 20d (13) | Reversão de curto prazo (Jegadeesh 1990): comprar correções dentro de tendência de alta, não topos |
| Volume | 13 | Volume 5d ≥ média 50d (6) · OBV subindo em 20d (7) | Atenção/fluxo de investidores como preditor (Liu & Tsyvinski 2021) |
| Risco | 12 | ATR% ≤ mediana do ano (7) · queda < 60% da máxima de 12 meses (5) | Evitar regimes de volatilidade extrema e “facas caindo” |

## 2. Backtest em cada moeda

Para cada dia do histórico (após 210 dias de aquecimento) a pontuação é recalculada **só com dados disponíveis naquele dia** (sem olhar o futuro). Mede‑se o retorno 14 dias depois, já descontando 0,2% de taxas.

Comparação: dias com pontuação ≥ 65 (“dias‑sinal”) vs. todos os dias (base).

- **Acerto**: % de dias‑sinal com retorno positivo.
- **Vantagem**: acerto dos sinais − acerto da base.
- **Episódios independentes**: sinais separados por ≥ 14 dias (evita contar o mesmo movimento várias vezes).
- **p‑valor**: teste binomial unilateral usando apenas episódios independentes (conservador).

## 3. Regra do alerta “COMPRA FORTE”

Todas as condições:

- pontuação atual ≥ 65 e RSI < 72;
- ≥ 20 dias‑sinal e ≥ 5 episódios independentes;
- acerto ≥ 55% **e** pelo menos 3 p.p. acima da base;
- retorno mediano dos sinais > 0.

Outros estados: **Observar** (perto do limiar ou sem validação), **Neutro**, **Evitar** (pontuação < 35 ou RSI > 75).

## 4. Simulação

Usa a **distribuição empírica** dos retornos de 14 dias após os sinais daquela moeda: pessimista = percentil 10, provável = mediana, otimista = percentil 90; chance de lucro = fração de casos positivos. Stop sugerido = preço − 2×ATR; alvo = preço + 3×ATR.

## Limitações honestas

- ~2,7 anos de dados diários é pouco para ciclos de cripto; o mercado muda de regime.
- Os parâmetros (65 pontos, 14 dias) foram escolhidos a priori, não otimizados — isso evita *overfitting*, mas não garante desempenho.
- Eventos externos (regulação, hacks, falências) não aparecem nos indicadores.
