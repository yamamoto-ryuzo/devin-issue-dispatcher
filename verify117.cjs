const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8585/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  const res = await p.evaluate(() => {
    setCandView('board');
    const repo = 'yamamoto-ryuzo/devin-issue-dispatcher';
    const key = repo + ' issue#99999';
    if (!candGroups.has(repo)) candGroups.set(repo, []);
    candGroups.get(repo).push({ key, repo, type: 'issue', number: 99999,
      title: '誤起票ダミー（検証用）', url: 'https://example.com/x',
      state: 'needs-review', assess: { category: 'human', risk: 'low' } });
    renderCandTabs(); renderCandBody();
    return [...document.querySelectorAll('.bcol')].map(col => ({
      head: col.querySelector('.bcol-h span')?.textContent.trim(),
      cards: col.querySelectorAll('.bcard').length,
      delBtns: [...col.querySelectorAll('button')]
        .filter(x => (x.getAttribute('onclick') || '').includes('delIssue(')).length,
    }));
  });
  console.log(JSON.stringify(res));
  await p.screenshot({ path: 'issue117-verify.png' });
  console.log('pageerrors:', errs.join(';') || 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
