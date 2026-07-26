const { chromium } = require('playwright');
const { Pool } = require('pg');
const http = require('http');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const SOURCES = [
  { type: 'byt', url: 'https://www.nehnutelnosti.sk/vysledky/byty/predaj' },
  { type: 'dom', url: 'https://www.nehnutelnosti.sk/vysledky/domy/predaj' },
  { type: 'byt', url: 'https://www.topreality.sk/byty.html' },
  { type: 'dom', url: 'https://www.topreality.sk/domy.html' },
  { type: 'byt', url: 'https://reality.bazos.sk/predam/byt/' },
  { type: 'dom', url: 'https://reality.bazos.sk/predam/dom/' },
];
async function ensureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, url TEXT, title TEXT, type TEXT, portal TEXT, last_price NUMERIC, first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS price_history (id SERIAL PRIMARY KEY, listing_id TEXT REFERENCES listings(id), price NUMERIC, checked_at TIMESTAMPTZ DEFAULT now());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS scrape_log (id SERIAL PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT now(), source TEXT, found INTEGER, note TEXT);`);
  await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS portal TEXT;`);
}
async function scrapeSource(browser, source) {
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });
  let found = 0, note = '';
  try {
    await page.goto(source.url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);
    const items = await page.evaluate(() => {
      const results = []; const seen = new Set();
      const priceRe = /(\d[\d\s.]{2,12})\s*(€|Eur\b)/;
      const all = Array.from(document.querySelectorAll('body *'));
      for (const el of all) {
        if (el.children.length > 2) continue;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 60) continue;
        const m = text.match(priceRe);
        if (!m) continue;
        const price = parseInt(m[1].replace(/[\s.]/g, ''), 10);
        if (!price || price < 3000) continue;
        const link = el.closest('a[href]') || el.querySelector('a[href]');
        if (!link) continue;
        const href = link.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        let title = (link.innerText || link.getAttribute('title') || href || '').split('\n')[0].trim();
        if (!title) title = href;
        results.push({ href, price, title: title.slice(0, 150) });
      }
      return results;
    });
    const portal = new URL(source.url).hostname.replace(/^www\./, '');
    for (const it of items) {
      const url = it.href.startsWith('http') ? it.href : new URL(it.href, source.url).href;
      const id = portal + '|' + it.href;
      const prev = await pool.query('SELECT last_price FROM listings WHERE id=$1', [id]);
      await pool.query(`INSERT INTO listings(id,url,title,type,portal,last_price,last_seen) VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (id) DO UPDATE SET last_price=$6,last_seen=now(),title=$3`, [id, url, it.title, source.type, portal, it.price]);
      if (prev.rows.length === 0 || Number(prev.rows[0].last_price) !== it.price) {
        await pool.query('INSERT INTO price_history(listing_id,price) VALUES ($1,$2)', [id, it.price]);
      }
      found++;
    }
    if (found === 0) {
      const debugSnippet = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const idx = body.search(/€|Eur\b/);
        return idx >= 0 ? body.slice(Math.max(0, idx - 80), idx + 150).replace(/\s+/g, ' ') : 'no € / Eur text found on page at all';
      });
      note = 'no items - debug: ' + debugSnippet.slice(0, 250);
    } else {
      note = 'ok';
    }
  } catch (e) { note = 'error: ' + e.message; }
  finally { await page.close(); }
  await pool.query('INSERT INTO scrape_log(source,found,note) VALUES ($1,$2,$3)', [source.url, found, note]);
}
async function scrapeAll() {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  for (const s of SOURCES) { await scrapeSource(browser, s); await new Promise(r => setTimeout(r, 5000)); }
  await browser.close();
}
function renderPage(rows, log, allRows) {
  const rowsHtml = rows.map(r => { const drop = r.max_price && r.last_price ? Math.round((1 - r.last_price / r.max_price) * 100) : 0; return `<tr data-type="${r.type}"><td><a href="${r.url}" target="_blank">${r.title}</a></td><td>${r.type}</td><td>${r.portal || ''}</td><td>${r.max_price} € → <b>${r.last_price} €</b></td><td>-${drop}%</td></tr>`; }).join('');
  const allHtml = (allRows || []).map(r => `<tr><td><a href="${r.url}" target="_blank">${r.title}</a></td><td>${r.type}</td><td>${r.portal || ''}</td><td>${r.last_price} €</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Zľavy na nehnuteľnostiach</title><style>body{font-family:sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse}td,th{padding:.5rem;border-bottom:1px solid #ddd;text-align:left}input,select{padding:.4rem;margin-right:.5rem}h2{margin-top:2.5rem}</style></head><body><h1>Zľavy na nehnuteľnostiach</h1><p>Posledné behy:</p><ul>${log.map(l => `<li>${l.ran_at}: ${l.source} — nájdených ${l.found} (${l.note})</li>`).join('')}</ul><div><select id="type"><option value="">Všetky</option><option value="byt">Byty</option><option value="dom">Domy</option></select><input id="loc" placeholder="Lokalita..."><input id="minDrop" type="number" placeholder="Min. % zľavy" style="width:8em"></div><table id="tbl"><thead><tr><th>Názov</th><th>Typ</th><th>Portál</th><th>Cena</th><th>Zľava</th></tr></thead><tbody>${rowsHtml}</tbody></table><h2>Všetky sledované inzeráty (posledných 100)</h2><table><thead><tr><th>Názov</th><th>Typ</th><th>Portál</th><th>Cena</th></tr></thead><tbody>${allHtml}</tbody></table><script>const type=document.getElementById('type'),loc=document.getElementById('loc'),minDrop=document.getElementById('minDrop');function filter(){document.querySelectorAll('#tbl tbody tr').forEach(tr=>{const t=type.value,l=loc.value.toLowerCase(),md=parseFloat(minDrop.value)||0;const dropPct=parseFloat(tr.children[4].textContent.replace('-','').replace('%',''))||0;const show=(!t||tr.dataset.type===t)&&tr.textContent.toLowerCase().includes(l)&&dropPct>=md;tr.style.display=show?'':'none';});}[type,loc,minDrop].forEach(el=>el.addEventListener('input',filter));</script></body></html>`;
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    const drops = await pool.query(`SELECT l.id, l.url, l.title, l.type, l.portal, l.last_price, (SELECT MAX(price) FROM price_history ph WHERE ph.listing_id=l.id) AS max_price FROM listings l WHERE l.last_price < (SELECT MAX(price) FROM price_history ph WHERE ph.listing_id=l.id) ORDER BY l.last_seen DESC LIMIT 500`);
    const all = await pool.query(`SELECT id, url, title, type, portal, last_price FROM listings ORDER BY last_seen DESC LIMIT 100`);
    const log = await pool.query('SELECT * FROM scrape_log ORDER BY ran_at DESC LIMIT 5');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage(drops.rows, log.rows, all.rows));
  } else { res.writeHead(404); res.end('not found'); }
});
ensureSchema().then(() => { scrapeAll(); setInterval(scrapeAll, 3 * 60 * 60 * 1000); server.listen(process.env.PORT || 3000); });

