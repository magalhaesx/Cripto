// Gera os PNGs dos ícones a partir de icons/icon.svg (requer Playwright): node scripts/gen-icons.cjs
const { chromium } = require('playwright'); const fs=require('fs');
const dir=require('path').join(__dirname,'..','icons')+'/'; const svg=fs.readFileSync(dir+'icon.svg','utf8');
(async()=>{const b=await chromium.launch();
for (const [n,s] of [['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180]]){const p=await b.newPage({viewport:{width:s,height:s}});await p.setContent(`<style>html,body{margin:0}svg{width:${s}px;height:${s}px;display:block}</style>${svg}`);await p.screenshot({path:dir+n});}
await b.close();})();
