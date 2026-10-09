// Page script for `capture.mjs --select`: tags the screens of «Relay - Rediseño», which has no data-screen-label.
// Marks every frame, the two D-0 boards and the section sheets with data-screen-label (the ID used as file name),
// data-capture-title and data-capture-notes (JSON lines: caption and CAMBIO / A VALIDAR notes under the screen).
// Returns how many elements it tagged.
(() => {
  document.querySelectorAll('[data-screen-label]').forEach((el) => el.removeAttribute('data-screen-label'));
  const css = (el) => getComputedStyle(el);
  const isFrame = (el) => {
    const r = css(el).borderTopLeftRadius;
    const w = Math.round(el.getBoundingClientRect().width);
    return (r === '44px' && w === 370) || (r === '30px' && w === 1180);
  };
  const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const NOTE_TAGS = ['CAMBIO', 'A VALIDAR'];
  // Caption spans and note rows that follow `after` inside `parent`, one line each.
  const notesAfter = (parent, after) => {
    const lines = [];
    let past = false;
    for (const child of parent.children) {
      if (child === after || child.contains(after)) { past = true; continue; }
      if (!past) continue;
      const rows = child.children.length === 2 && NOTE_TAGS.includes(clean(child.children[0].innerText)) ? [child]
        : [...child.querySelectorAll('div')].filter((d) => d.children.length === 2 && NOTE_TAGS.includes(clean(d.children[0].innerText)));
      if (rows.length) rows.forEach((d) => lines.push(`${clean(d.children[0].innerText)}: ${clean(d.children[1].innerText)}`));
      else if (clean(child.innerText)) lines.push(clean(child.innerText));
    }
    return lines;
  };
  const tag = (el, id, title, notes) => {
    el.setAttribute('data-screen-label', id);
    el.setAttribute('data-capture-title', title);
    el.setAttribute('data-capture-notes', JSON.stringify(notes));
  };

  const frames = [...document.querySelectorAll('div')].filter(isFrame);
  const labels = [...document.querySelectorAll('span')].filter((s) =>
    css(s).fontSize === '11px' && /Martian/.test(css(s).fontFamily) && /^[A-Z]-[0-9A-Z]+/.test(clean(s.innerText)));
  for (const frame of frames) {
    const label = labels.filter((s) => s.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
    if (!label) continue;
    const id = clean(label.innerText).replace(/ · /g, '_').replace(/·/g, '-');
    let column = label.parentElement;
    while (!column.contains(frame)) column = column.parentElement;
    const row = [...column.children].find((c) => c.contains(label));
    const notes = notesAfter(column, frame);
    // A section with a single frame keeps its notes below the row (D-TB).
    const section = column.closest('[id]');
    if (section && [...section.querySelectorAll('div')].filter(isFrame).length === 1) {
      notes.push(...notesAfter(section, column));
    }
    tag(frame, id, clean(row.innerText).slice(clean(label.innerText).length).trim(), notes);
  }

  // The two D-0 boards: the light blocks before D-0·3.
  const d0 = document.getElementById('D-0');
  if (d0) {
    const boards = [...d0.querySelectorAll('div')].filter((d) => css(d).borderTopLeftRadius === '28px' && css(d).backgroundColor === 'rgb(216, 213, 206)');
    ['D-0-barra', 'D-0-riel'].forEach((id, i) => boards[i] && tag(boards[i], id, clean(boards[i].querySelector('span').innerText), []));
  }

  for (const id of ['S-15', 'D-ES', 'G-1', 'K-1']) {
    const sheet = document.getElementById(id);
    if (sheet) tag(sheet, id, clean(sheet.firstElementChild.innerText), []);
  }
  return document.querySelectorAll('[data-screen-label]').length;
})()
