import { createRequire } from 'node:module';
const require = createRequire('C:SERSYU.RYU-NOTEAPPDATAocal/npm-cache/_npx/411d535eabdf86de/node_modules/');
const { chromium } = require('playwright');
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://127.0.0.1:8585/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
const res = await p.evaluate(async () => {
  const real = [...candGroups.values()].flat().filter(c => c.humanWait);
  let key, injected = false;
  if (real.length) key = real[0].key;
  else {
    key = '__verify120__#999';
    const arr = candGroups.values().next().value || [];
    arr.push({ key, number: 999, title: '検証用ダミー人間待ち', humanWait: { question: 'テスト質問' }, repo: arr[0]?.repo || 'r' });
    const inp = document.createElement('input');
    inp.className = 'hw-in'; inp.dataset.key = key; document.body.appendChild(inp);
    injected = true;
  }
  renderHwBar();
  const bar = document.getElementById('hw-bar');
  const out = {
    injected,
    barDisplay: getComputedStyle(bar).display,
    badge: bar.querySelector('.badge')?.textContent,
    btns: [...bar.querySelectorAll('.hw-btn')].map(x => x.textContent),
    barAboveTabs: !!(bar.compareDocumentPosition(document.getElementById('cand-tabs')) & Node.DOCUMENT_POSITION_FOLLOWING),
  };
  hwJump(key);
  await new Promise(r => setTimeout(r, 300));
  out.focusOk = document.activeElement?.dataset?.key === key;
  out.flashApplied = !!document.querySelector('.hw-in.hw-flash, tr.hw-flash, .bcard.hw-flash');
  // 人間待ち0件時にバーが消えるか（非表示経路の確認）
  if (injected) {
    const arr = candGroups.values().next().value;
    arr.pop(); renderHwBar();
    out.emptyHidesBar = getComputedStyle(bar).display === 'none';
    arr.push({ key, number: 999, title: '検証用ダミー人間待ち', humanWait: { question: 'テスト質問' } });
    renderHwBar();
  }
  return out;
});
await p.evaluate(() => { renderHwBar(); });
await p.waitForTimeout(300);
await p.screenshot({ path: 'issue120-verify.png' });
console.log(JSON.stringify(res, null, 1));
await b.close();
