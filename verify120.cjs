const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8585/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  const res = await p.evaluate(async () => {
    const real = [...candGroups.values()].flat().filter(c => c.humanWait);
    let key, injected = false;
    if (real.length) { key = real[0].key; }
    else {
      key = '__verify120__#999'; injected = true;
      let arr = candGroups.values().next().value;
      if (!arr) { arr = []; candGroups.set('__verify__', arr); }
      arr.push({ key, number: 999, title: '検証用ダミー人間待ち', humanWait: { question: 'テスト質問' } });
      const inp = document.createElement('input');
      inp.className = 'hw-in'; inp.dataset.key = key; document.body.appendChild(inp);
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
    if (injected) {
      const arr2 = candGroups.get('__verify__') || candGroups.values().next().value;
      arr2.pop(); renderHwBar();
      out.emptyHidesBar = getComputedStyle(bar).display === 'none';
      arr2.push({ key, number: 999, title: '検証用ダミー人間待ち', humanWait: { question: 'テスト質問' } });
      renderHwBar();
    }
    return out;
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: 'issue120-verify.png' });
  console.log(JSON.stringify(res));
  await b.close();
  const ok = res.barDisplay === 'flex' && res.btns.length > 0 && res.barAboveTabs && res.focusOk && res.flashApplied && (res.injected ? res.emptyHidesBar : true);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
