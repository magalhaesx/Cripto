// Moedas acompanhadas. symbol = par na Binance (contra USDT), id = CoinGecko.
export const COINS = [
  { sym: 'BTC',  id: 'bitcoin',                 name: 'Bitcoin',   color: '#F7931A' },
  { sym: 'ETH',  id: 'ethereum',                name: 'Ethereum',  color: '#8A9EFF' },
  { sym: 'SOL',  id: 'solana',                  name: 'Solana',    color: '#14F195' },
  { sym: 'BNB',  id: 'binancecoin',             name: 'BNB',       color: '#F3BA2F' },
  { sym: 'XRP',  id: 'ripple',                  name: 'XRP',       color: '#00AAE4' },
  { sym: 'ADA',  id: 'cardano',                 name: 'Cardano',   color: '#3468D1' },
  { sym: 'DOGE', id: 'dogecoin',                name: 'Dogecoin',  color: '#C2A633' },
  { sym: 'AVAX', id: 'avalanche-2',             name: 'Avalanche', color: '#E84142' },
  { sym: 'LINK', id: 'chainlink',               name: 'Chainlink', color: '#2A5ADA' },
  { sym: 'DOT',  id: 'polkadot',                name: 'Polkadot',  color: '#E6007A' },
  { sym: 'LTC',  id: 'litecoin',                name: 'Litecoin',  color: '#BFBBBB' },
  { sym: 'TRX',  id: 'tron',                    name: 'TRON',      color: '#EF0027' },
  { sym: 'SUI',  id: 'sui',                     name: 'Sui',       color: '#4DA2FF' },
  { sym: 'NEAR', id: 'near',                    name: 'NEAR',      color: '#00EC97' },
  { sym: 'TON',  id: 'the-open-network',        name: 'Toncoin',   color: '#0098EA' },
  { sym: 'POL',  id: 'polygon-ecosystem-token', name: 'Polygon',   color: '#8247E5' },
];

export const coinBySym = Object.fromEntries(COINS.map(c => [c.sym, c]));
