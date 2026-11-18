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
  { sym: 'BCH',  id: 'bitcoin-cash',            name: 'Bitcoin Cash', color: '#8DC351' },
  { sym: 'XLM',  id: 'stellar',                 name: 'Stellar',   color: '#7D8CFF' },
  { sym: 'HBAR', id: 'hedera-hashgraph',        name: 'Hedera',    color: '#9E9E9E' },
  { sym: 'SHIB', id: 'shiba-inu',               name: 'Shiba Inu', color: '#FFA409' },
  { sym: 'PEPE', id: 'pepe',                    name: 'Pepe',      color: '#3D9A3A' },
  { sym: 'UNI',  id: 'uniswap',                 name: 'Uniswap',   color: '#FF007A' },
  { sym: 'AAVE', id: 'aave',                    name: 'Aave',      color: '#B6509E' },
  { sym: 'ATOM', id: 'cosmos',                  name: 'Cosmos',    color: '#6F7390' },
  { sym: 'APT',  id: 'aptos',                   name: 'Aptos',     color: '#2ED8A7' },
  { sym: 'ARB',  id: 'arbitrum',                name: 'Arbitrum',  color: '#28A0F0' },
  { sym: 'OP',   id: 'optimism',                name: 'Optimism',  color: '#FF0420' },
  { sym: 'ICP',  id: 'internet-computer',       name: 'Internet Computer', color: '#F15A24' },
  { sym: 'FET',  id: 'fetch-ai',                name: 'Fetch.ai',  color: '#1D2A5B' },
  { sym: 'RENDER', id: 'render-token',          name: 'Render',    color: '#E8303A' },
];

// Cores para moedas adicionadas pelo usuário
const PALETTE = ['#AB9FF2', '#2EE6A6', '#FFD166', '#FF9F5A', '#4DA2FF', '#FF5C7A', '#14F195', '#E6007A'];
export const colorFor = sym => PALETTE[[...sym].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

export const coinBySym = Object.fromEntries(COINS.map(c => [c.sym, c]));
