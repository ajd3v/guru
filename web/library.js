(() => {
  const sheet = document.querySelector('.sheet');
  if (!sheet) return;
  const key = sheet.dataset.history + ':' + sheet.dataset.reader;
  const passageKey = key + ':passages';
  const saved = (name) => { try { const rows = JSON.parse(localStorage.getItem(name)); return Array.isArray(rows) ? rows.filter((r) => r && /^[1-9]\d*$/.test(String(r.book)) && /^[a-f0-9]{32}$/.test(r.revision)) : []; } catch { return []; } };
  const announce = document.createElement('p');
  announce.className = 'note'; announce.setAttribute('role', 'status');
  document.getElementById('saved-passages')?.after(announce);
  window.addEventListener('bookmark-passage', ({ detail: p }) => {
    const rows = saved(passageKey);
    if (!rows.some((r) => r.book === p.book && r.revision === p.revision && r.id === p.id)) rows.push({ book: p.book, revision: p.revision, id: p.id, title: p.title, page: p.page_start });
    try { localStorage.setItem(passageKey, JSON.stringify(rows.slice(-500))); announce.textContent = 'Passage bookmarked on this device.'; }
    catch { announce.textContent = 'This browser could not save the bookmark.'; }
  });
  const dialog = document.getElementById('bookmark-dialog');
  function showSaved() {
    const list = document.getElementById('bookmark-list'); list.replaceChildren();
    for (const [name, kind] of [[passageKey, 'passage'], [key + ':pages', 'page']]) {
      for (const row of saved(name)) {
        const p = document.createElement('p'), link = document.createElement('a'), remove = document.createElement('button');
        const params = new URLSearchParams({ book: row.book, revision: row.revision });
        // Page bookmarks store a physical PDF page. The reader accepts that separately.
        params.set(kind === 'page' ? 'pdfPage' : 'chunk', kind === 'page' ? row.page : row.id);
        link.href = (kind === 'page' ? '/reader?' : '/book?') + params;
        link.textContent = row.title + ', ' + (kind === 'page' ? 'PDF page ' : 'passage at ') + row.page;
        remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove bookmark for ' + row.title);
        remove.onclick = () => { try { localStorage.setItem(name, JSON.stringify(saved(name).filter((r) => JSON.stringify(r) !== JSON.stringify(row)))); showSaved(); } catch { announce.textContent = 'Could not remove this bookmark.'; } };
        p.append(link, remove); list.append(p);
      }
    }
    if (!list.childElementCount) list.textContent = 'Open a source passage or PDF page to save a bookmark on this device.';
  }
  document.getElementById('saved-passages')?.addEventListener('click', () => { showSaved(); dialog.showModal(); });
  const selects = ['book', 'compare'].map((id) => document.getElementById(id)).filter(Boolean);
  const originals = selects.map((select) => Array.from(select.options));
  const filter = () => {
    const term = (document.getElementById('book-filter')?.value || '').trim().toLowerCase();
    const tradition = document.getElementById('tradition-filter')?.value || '';
    const edition = document.getElementById('edition-filter')?.value || '';
    let count = 0;
    selects.forEach((select, index) => {
      const rows = originals[index].filter((option) => {
        const match = !option.value || (option.textContent.toLowerCase().includes(term) && (!tradition || option.dataset.tradition === tradition) && (!edition || option.dataset.edition === edition));
        if (!index && option.value && match) count++;
        return match || option.selected;
      });
      select.replaceChildren(...rows);
    });
    const status = document.getElementById('book-count');
    if (status) status.textContent = count + ' matching books. Selected books stay visible.';
  };
  for (const id of ['book-filter', 'tradition-filter', 'edition-filter']) document.getElementById(id)?.addEventListener('input', filter);
  const chunk = new URLSearchParams(location.search).get('chunk');
  if (/^[1-9]\d*$/.test(chunk || '')) {
    const target = document.querySelector('button.source[data-chunk="' + chunk + '"]');
    target?.click(); target?.scrollIntoView({ block: 'center' });
  }
})();
