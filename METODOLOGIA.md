# Metodologia (v2)

Pergunta que o app responde: **"historicamente, comprar numa situação como a de hoje deu lucro com mais frequência do que comprar num dia qualquer?"**

## Estratégia atual: repique após pânico de mercado

**Gatilho** (dados diários):
1. Preço **25% ou mais abaixo da máxima dos últimos 30 dias**; e
2. **RSI(14) < 30** (sobrevenda). RSI < 25 = sinal **forte**; e
3. **Pânico de mercado**: pelo menos **15% das moedas acompanhadas** estão no gatilho ao mesmo tempo. Queda isolada de uma moeda fica só em "observar".

**Horizonte:** 7 dias (operação curta: comprar no pânico, reavaliar em ~1 semana).
**Rebaixamento:** se na própria moeda o padrão teve acerto < 45% em 5+ casos, vira "observar".

## Como foi escolhida (`research/`)

Dados: histórico diário completo de 30 moedas na Binance (2017–2026, ~73 mil dias-moeda). Custo de 0,2% por operação descontado.

1. **Triagem** (`backtest-strategies.mjs`): ~15 estratégias × prazos de 7/14/30 dias, divididas em **período de estudo** (antes de 2023) e **período de prova** (2023+).
   - Pontuação antiga (v1): acerto **abaixo** de um dia qualquer no período de prova → descartada.
   - Rompimentos de máxima, cruzamento de médias, volta acima da MM200, Bollinger, filtros pelo BTC: pareciam bons pela média, mas…
2. **Robustez** (`robustness.mjs`): agrupando sinais da mesma semana (eles saem juntos em várias moedas), os rompimentos perderam a significância e variavam muito com os parâmetros → descartados. O **repique após queda forte** passou em **todas as 9 variações** testadas (queda 20/25/30% × RSI 25/30/35), com t semanal 2,3–3,4. Escolhemos o centro da grade (25% / RSI 30) para não "escolher a dedo".
3. **Contexto de mercado** (`market-wide.mjs`): quedas **isoladas** foram inconsistentes (59% antes de 2023, 39% depois). Quedas em **pânico geral** tiveram vantagem nos dois períodos (56% e 66%).

## Números (gerados em `js/study.js` por `build-study.mjs`)

| | Casos | Subiram em 7 dias |
|---|---|---|
| Comprar num dia qualquer | ~67 mil | 46,8% |
| Gatilho (todos) | 653 | 57,0% |
| Gatilho em pânico de mercado | 488 | 60,0% |
| Gatilho forte (RSI < 25) | 126 | 63,5% |
| Queda isolada | 165 | 47,9% |

Significância (excesso vs. um dia qualquer do mesmo ano, agrupado por semana): t = 2,2 no retorno e t = 3,0 no acerto.

**Ano a ano (pânico de mercado):** 2018 44% · 2019 60% · 2020 100% · 2021 60% · 2022 48% · 2023 86% · 2024 63% · 2025 71% · 2026 50%.

## Limitações honestas

- Em **mercados de baixa prolongados** (2018, 2022, 2026) o acerto fica perto de 50%: a queda continua.
- O filtro de "pânico de mercado" foi identificado depois de olhar os dados; tem lógica econômica (queda isolada costuma ser notícia ruim da própria moeda; pânico geral costuma ser venda forçada/liquidez), mas ainda precisa ser confirmado com dados futuros.
- Mediana do ganho em 7 dias é modesta (~+1,5% a +3%); os 10% piores casos perdem 12–19%. Use o stop.
- Sinais em várias moedas no mesmo dia são correlacionados: se der errado, tende a dar errado em todas juntas. Não concentre tudo.

## Simulação

Distribuição empírica dos retornos de 7 dias após o gatilho — da própria moeda (se tiver 10+ casos) ou do estudo completo. Pessimista = percentil 10, provável = mediana, otimista = percentil 90.

## Reproduzir

```bash
node research/fetch-history.mjs research/data      # baixa o histórico (precisa de acesso à Binance)
node research/backtest-strategies.mjs research/data
node research/robustness.mjs research/data
node research/market-wide.mjs research/data
node research/build-study.mjs research/data         # regenera js/study.js
```
