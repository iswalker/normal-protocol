/* ───────────────────────────────────────────────────────────────────────
   board.js — render, nested drag-and-drop, inline edit, totals, persistence
   ─────────────────────────────────────────────────────────────────────── */
(function () {
  const SB = window.SB;
  const KEY = 'sb_state_v6';
  const board = document.getElementById('board');

  window.SBoard = window.SBoard || { threshold: 10 };
  const thr = () => window.SBoard.threshold || 10;

  // ── icons ───────────────────────────────────────────────────────────
  const ICON = {
    grip: `<svg viewBox="0 0 8 16" fill="currentColor"><circle cx="2" cy="3" r="1.3"/><circle cx="6" cy="3" r="1.3"/><circle cx="2" cy="8" r="1.3"/><circle cx="6" cy="8" r="1.3"/><circle cx="2" cy="13" r="1.3"/><circle cx="6" cy="13" r="1.3"/></svg>`,
    truck: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5h11v9H1z"/><path d="M12 8h4l3 3v3h-7z"/><circle cx="5" cy="16.5" r="1.6"/><circle cx="16" cy="16.5" r="1.6"/></svg>`,
    plus: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 2v10M2 7h10"/></svg>`,
  };

  // ── state ───────────────────────────────────────────────────────────
  let STATE; // { cardData, shipmentData }
  let structure;

  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (saved && saved.cardData && saved.structure) {
      STATE = { cardData: saved.cardData, shipmentData: saved.shipmentData || {} };
      structure = saved.structure;
    } else {
      const seed = JSON.parse(JSON.stringify(SB.SEED));
      STATE = { cardData: seed.cardData, shipmentData: seed.shipmentData };
      structure = seed.structure;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function isoToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // ── builders ────────────────────────────────────────────────────────
  function cardHTML(id) {
    const c = STATE.cardData[id];
    return `
    <div class="card" data-id="${id}" data-kind="card">
      <div class="card-body">
        <div class="card-top">
          <span class="grip block-grip card-grip" title="Drag">${ICON.grip}</span>
          <div class="card-name" contenteditable="true" spellcheck="false" data-field="name">${esc(c.name)}</div>
          <span class="badge loose-tag">Loose</span>
          <span class="badge status">OK</span>
        </div>
        <div class="proj">
          <div class="cell daysleft">
            <div class="pk">Days left</div>
            <div class="pv">
              <span class="now"><span class="n">0</span><span class="u">d</span></span>
              <span class="arrow">→</span>
              <span class="next"><span class="n">0</span><span class="u">d</span></span>
            </div>
          </div>
          <div class="cell runout">
            <div class="pk">Runs out</div>
            <div class="pv">
              <span class="now">—</span>
              <span class="arrow">→</span>
              <span class="next">—</span>
            </div>
          </div>
        </div>
        <div class="order">
          <div class="field">
            <label>Price <span class="lbl-sub">/ bottle</span></label>
            <div class="input-wrap"><span class="pfx">$</span><input type="number" step="0.01" min="0" inputmode="decimal" data-field="price" value="${c.price}"></div>
          </div>
          <div class="field">
            <label>Order <span class="lbl-sub">bottles</span></label>
            <div class="input-wrap"><input type="number" step="1" min="0" inputmode="numeric" data-field="qty" value="${c.qty}"><span class="sfx">btl</span></div>
          </div>
        </div>
        <div class="card-foot">
          <span class="meta">on hand <b class="onhand">0</b> · <b class="dose">0</b>/day · <b class="bsize">0</b>/btl</span>
          <span class="ototal"><small>Order</small><span class="amt">$0.00</span></span>
          <button class="incl-toggle" data-act="toggle-include" title="Count this item in the month’s Planned total" aria-label="Count in Planned total"><span class="sw"><i></i></span></button>
        </div>
        <button class="del" data-act="del-card" title="Remove item" aria-label="Remove item">×</button>
      </div>
    </div>`;
  }

  function shipmentHTML(block) {
    const s = STATE.shipmentData[block.id] || { name: 'Shipment' };
    const cards = block.cards.map(cardHTML).join('');
    return `
    <div class="shipment" data-id="${block.id}" data-kind="shipment">
      <div class="ship-head">
        <span class="grip block-grip" title="Drag shipment">${ICON.grip}</span>
        <span class="truck">${ICON.truck}</span>
        <div class="ship-id">
          <span class="ship-name" contenteditable="true" spellcheck="false" data-field="name">${esc(s.name)}</span>
          <span class="scount">0</span>
        </div>
        <div class="ship-total"><span class="amt">$0.00</span></div>
        <button class="del" data-act="del-ship" title="Remove shipment">×</button>
      </div>
      <div class="ship-body" data-list="shipment">${cards}</div>
      <div class="ship-foot"><button class="add-btn" data-act="add-card-ship">${ICON.plus} Add item</button></div>
    </div>`;
  }

  function blockHTML(block) {
    return block.type === 'shipment' ? shipmentHTML(block) : cardHTML(block.id);
  }

  function monthHTML(m) {
    return `
    <div class="month" data-id="${m.id}">
      <div class="month-head">
        <div class="month-title">
          <span class="mname" contenteditable="true" spellcheck="false" data-field="name">${esc(m.name)}</span>
          <span class="msub">${esc(m.sub || '')}</span>
          <span class="mcount">0</span>
        </div>
        <div class="month-metrics">
          <div class="metric spent">
            <span class="mk">Spent</span>
            <span class="mv mv-money"><span class="pfx">$</span><input class="spent-input" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(m.spent) || 0}"></span>
          </div>
          <div class="metric">
            <span class="mk">Shipments</span>
            <span class="mv shipv">$0.00</span>
          </div>
          <div class="metric is-total">
            <span class="mk">Planned</span>
            <span class="mv plannedv">$0.00</span>
          </div>
          <div class="metric is-max">
            <span class="mk">Max</span>
            <span class="mv maxv">$0.00</span>
          </div>
        </div>
      </div>
      <div class="month-list" data-list="month">${m.blocks.map(blockHTML).join('')}</div>
      <div class="month-foot">
        <button class="add-btn" data-act="add-ship">${ICON.plus} Shipment</button>
        <button class="add-btn" data-act="add-card-month">${ICON.plus} Item</button>
      </div>
    </div>`;
  }

  function render() {
    board.innerHTML = structure.map(monthHTML).join('');
    board.querySelectorAll('.month-list').forEach(makeMonthSortable);
    board.querySelectorAll('.ship-body').forEach(makeShipSortable);
    board.querySelectorAll('.spent-input').forEach(sizeSpent);
    recalcAll();
  }

  function sizeSpent(input) {
    const len = Math.max(1, String(input.value).length);
    input.style.width = (len + 1.5) + 'ch';
  }

  // ── per-card update ─────────────────────────────────────────────────
  function setDays(span, val, accent) {
    const n = span.querySelector('.n');
    n.textContent = Math.max(0, Math.round(val));
  }

  function updateCard(cardEl) {
    const id = cardEl.dataset.id;
    const c = STATE.cardData[id];
    if (!c) return 0;
    const r = SB.calc(c);
    const tier = SB.tier(r.curDaysLeft, thr());
    const compact = board.classList.contains('layout-compact');
    const df = compact ? SB.fmtDateShort : SB.fmtDate;

    cardEl.classList.toggle('tier-soon', tier === 'soon');
    cardEl.classList.toggle('tier-out', tier === 'out');
    cardEl.classList.toggle('has-order', r.hasOrder);
    cardEl.classList.toggle('counted', !!c.includeInMonthTotal);

    cardEl.querySelector('.status').textContent =
      tier === 'out' ? 'OUT' : tier === 'soon' ? 'SOON' : 'OK';

    const dl = cardEl.querySelector('.daysleft');
    setDays(dl.querySelector('.now'), r.curDaysLeft);
    setDays(dl.querySelector('.next'), r.newDaysLeft);

    const ro = cardEl.querySelector('.runout');
    ro.querySelector('.now').textContent = df(r.curRunOut);
    ro.querySelector('.next').textContent = df(r.newRunOut);

    cardEl.querySelector('.onhand').textContent = SB.fmtUnits(r.onHand);
    cardEl.querySelector('.dose').textContent = String(+r.dose.toFixed(1));
    cardEl.querySelector('.bsize').textContent = String(r.bottle);
    cardEl.querySelector('.ototal .amt').textContent = SB.fmtMoney(r.cost);

    // fit number inputs to their content in the dense compact layout
    cardEl.querySelectorAll('input[data-field]').forEach((inp) => {
      if (compact) {
        const len = Math.max(1, String(inp.value).length);
        inp.style.width = (len + 1.2) + 'ch';
      } else if (inp.style.width) {
        inp.style.width = '';
      }
    });

    return r.cost;
  }

  // ── totals ──────────────────────────────────────────────────────────
  function monthSpent(monthEl) {
    const i = monthEl.querySelector('.spent-input');
    return i ? (Number(i.value) || 0) : 0;
  }

  function recalcAll() {
    board.querySelectorAll('.month').forEach((monthEl) => {
      const list = monthEl.querySelector('.month-list');
      let shipSum = 0, plannedItems = 0, maxItems = 0, itemCount = 0;

      [...list.children].forEach((node) => {
        if (node.classList.contains('shipment')) {
          let sTot = 0, sCount = 0;
          node.querySelectorAll(':scope .ship-body > .card').forEach((cardEl) => {
            const cost = updateCard(cardEl);
            sTot += cost;
            maxItems += cost;
            if (STATE.cardData[cardEl.dataset.id] && STATE.cardData[cardEl.dataset.id].includeInMonthTotal) plannedItems += cost;
            sCount++;
          });
          node.querySelector('.ship-total .amt').textContent = SB.fmtMoney(sTot);
          node.querySelector('.scount').textContent = sCount;
          shipSum += sTot;
          itemCount += sCount;
        } else if (node.classList.contains('card')) {
          const cost = updateCard(node);
          maxItems += cost;
          if (STATE.cardData[node.dataset.id] && STATE.cardData[node.dataset.id].includeInMonthTotal) plannedItems += cost;
          itemCount++;
        }
      });

      const spent = monthSpent(monthEl);
      monthEl.querySelector('.shipv').textContent = SB.fmtMoney(shipSum);
      monthEl.querySelector('.plannedv').textContent = SB.fmtMoney(spent + plannedItems);
      monthEl.querySelector('.maxv').textContent = SB.fmtMoney(spent + maxItems);
      monthEl.querySelector('.mcount').textContent = `${itemCount}`;
    });
  }
  window.SBoard.recalc = recalcAll;

  // ── persistence ─────────────────────────────────────────────────────
  function serialize() {
    const struct = [...board.querySelectorAll('.month')].map((m) => ({
      id: m.dataset.id,
      name: m.querySelector('.mname').textContent.trim(),
      sub: m.querySelector('.msub').textContent.trim(),
      spent: monthSpent(m),
      blocks: [...m.querySelector('.month-list').children]
        .filter((n) => n.classList.contains('shipment') || n.classList.contains('card'))
        .map((n) => {
          if (n.classList.contains('shipment')) {
            return {
              type: 'shipment', id: n.dataset.id,
              cards: [...n.querySelectorAll(':scope .ship-body > .card')].map((c) => c.dataset.id),
            };
          }
          return { type: 'card', id: n.dataset.id };
        }),
    }));
    // prune orphaned data
    const liveCards = new Set(), liveShips = new Set();
    struct.forEach((m) => m.blocks.forEach((b) => {
      if (b.type === 'shipment') { liveShips.add(b.id); b.cards.forEach((c) => liveCards.add(c)); }
      else liveCards.add(b.id);
    }));
    const cardData = {}, shipmentData = {};
    liveCards.forEach((id) => { if (STATE.cardData[id]) cardData[id] = STATE.cardData[id]; });
    liveShips.forEach((id) => { if (STATE.shipmentData[id]) shipmentData[id] = STATE.shipmentData[id]; });
    return { cardData, shipmentData, structure: struct };
  }

  let saveTimer = null;
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(serialize())); } catch (e) {}
  }
  function persistSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
  }

  // ── drag and drop (SortableJS, nested) ──────────────────────────────
  const afterDrag = () => { recalcAll(); persist(); };
  const COMMON = {
    animation: 160, easing: 'cubic-bezier(.2,.7,.3,1)',
    filter: 'input,[contenteditable],button',
    preventOnFilter: false,
    ghostClass: 'sb-ghost', chosenClass: 'sb-chosen', dragClass: 'sb-drag',
    fallbackOnBody: true, swapThreshold: 0.65,
  };
  function makeMonthSortable(listEl) {
    new Sortable(listEl, Object.assign({}, COMMON, {
      group: { name: 'sb', pull: true, put: true },
      draggable: '.card, .shipment',
      handle: '.block-grip',
      onEnd: afterDrag,
    }));
  }
  function makeShipSortable(bodyEl) {
    new Sortable(bodyEl, Object.assign({}, COMMON, {
      group: { name: 'sb', pull: true, put: (to, from, drag) => drag.classList.contains('card') },
      draggable: '.card',
      handle: '.card-grip',
      onEnd: afterDrag,
    }));
  }

  // ── editing ─────────────────────────────────────────────────────────
  board.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('input[data-field]')) {
      const cardEl = t.closest('.card');
      const c = STATE.cardData[cardEl.dataset.id];
      c[t.dataset.field] = t.value === '' ? 0 : Number(t.value);
      updateCard(cardEl);
      // bubble totals up (shipment + month)
      recalcTotalsFor(cardEl);
      persistSoon();
    } else if (t.matches('.card-name')) {
      STATE.cardData[t.closest('.card').dataset.id].name = t.textContent;
      persistSoon();
    } else if (t.matches('.ship-name')) {
      const ship = t.closest('.shipment');
      (STATE.shipmentData[ship.dataset.id] ||= {}).name = t.textContent;
      persistSoon();
    } else if (t.matches('.spent-input')) {
      sizeSpent(t);
      recalcTotalsFor(t);
      persistSoon();
    } else if (t.matches('.mname')) {
      persistSoon();
    }
  });

  // lightweight: only recompute the affected month's totals
  function recalcTotalsFor(node) {
    const monthEl = node.closest('.month');
    if (!monthEl) return;
    const list = monthEl.querySelector('.month-list');
    let shipSum = 0, plannedItems = 0, maxItems = 0;
    [...list.children].forEach((n) => {
      if (n.classList.contains('shipment')) {
        let sTot = 0;
        n.querySelectorAll(':scope .ship-body > .card').forEach((cardEl) => {
          const c = STATE.cardData[cardEl.dataset.id];
          const cost = c ? SB.calc(c).cost : 0;
          sTot += cost; maxItems += cost;
          if (c && c.includeInMonthTotal) plannedItems += cost;
        });
        n.querySelector('.ship-total .amt').textContent = SB.fmtMoney(sTot);
        shipSum += sTot;
      } else if (n.classList.contains('card')) {
        const c = STATE.cardData[n.dataset.id];
        const cost = c ? SB.calc(c).cost : 0;
        maxItems += cost;
        if (c && c.includeInMonthTotal) plannedItems += cost;
      }
    });
    const spent = monthSpent(monthEl);
    monthEl.querySelector('.shipv').textContent = SB.fmtMoney(shipSum);
    monthEl.querySelector('.plannedv').textContent = SB.fmtMoney(spent + plannedItems);
    monthEl.querySelector('.maxv').textContent = SB.fmtMoney(spent + maxItems);
  }

  // ── actions (add / delete / toggle) ─────────────────────────────────
  board.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;

    if (a === 'toggle-include') {
      e.preventDefault();
      const cardEl = act.closest('.card');
      const c = STATE.cardData[cardEl.dataset.id];
      c.includeInMonthTotal = !c.includeInMonthTotal;
      cardEl.classList.toggle('counted', c.includeInMonthTotal);
      recalcTotalsFor(cardEl);
      persist();
      return;
    }
    if (a === 'del-card') {
      const cardEl = act.closest('.card');
      const monthEl = cardEl.closest('.month');
      cardEl.remove();
      recalcAll(); persist();
      return;
    }
    if (a === 'del-ship') {
      act.closest('.shipment').remove();
      recalcAll(); persist();
      return;
    }
    if (a === 'add-card-ship') {
      const body = act.closest('.shipment').querySelector('.ship-body');
      const id = newCard();
      const node = el(cardHTML(id));
      body.appendChild(node);
      finishAdd(node);
      return;
    }
    if (a === 'add-card-month') {
      const list = act.closest('.month').querySelector('.month-list');
      const id = newCard();
      const node = el(cardHTML(id));
      list.appendChild(node);
      finishAdd(node);
      return;
    }
    if (a === 'add-ship') {
      const list = act.closest('.month').querySelector('.month-list');
      const sid = uid('s_');
      STATE.shipmentData[sid] = { name: 'New merchant' };
      const node = el(shipmentHTML({ type: 'shipment', id: sid, cards: [] }));
      list.appendChild(node);
      makeShipSortable(node.querySelector('.ship-body'));
      recalcAll(); persist();
      const nm = node.querySelector('.ship-name');
      nm.focus(); selectAll(nm);
      return;
    }
  });

  function newCard() {
    const id = uid('c_');
    STATE.cardData[id] = {
      name: 'New supplement', amount: 30, dose: 1, bottleSize: 30,
      loggedOn: isoToday(), price: 0, qty: 0, includeInMonthTotal: true,
    };
    return id;
  }
  function finishAdd(node) {
    recalcAll(); persist();
    const nm = node.querySelector('.card-name');
    nm.focus(); selectAll(nm);
    node.scrollIntoView ? null : null; // avoid scrollIntoView per guidelines
  }
  function selectAll(node) {
    const r = document.createRange();
    r.selectNodeContents(node);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
  }

  // commit edits / strip rich paste on blur
  board.addEventListener('blur', (e) => {
    if (e.target.matches('[contenteditable]')) persist();
  }, true);
  board.addEventListener('paste', (e) => {
    if (e.target.matches('[contenteditable]')) {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    }
  });
  board.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[contenteditable]')) {
      e.preventDefault(); e.target.blur();
    }
  });

  // ── tweaks hook (called by the React Tweaks panel) ──────────────────
  window.SBoard.applyTweaks = function (t) {
    const root = document.documentElement;
    const layout = t.cardLayout || 'detailed';
    board.classList.remove('layout-detailed', 'layout-compact', 'layout-split');
    board.classList.add('layout-' + layout);
    if (Array.isArray(t.accent)) {
      root.style.setProperty('--accent', t.accent[0]);
      root.style.setProperty('--accent-deep', t.accent[1] || t.accent[0]);
      root.style.setProperty('--accent-tint', t.accent[2] || '#eaf6f4');
    }
    window.SBoard.threshold = t.urgencyThreshold || 10;
    recalcAll();
  };

  // ── boot ────────────────────────────────────────────────────────────
  load();
  render();
  board.classList.add('layout-detailed');

  // re-fit content-sized inputs once the mono font has actually loaded
  // (ch metrics differ between the fallback and IBM Plex Mono)
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      board.querySelectorAll('.spent-input').forEach(sizeSpent);
      recalcAll();
    });
  }

  // keep the live countdown honest if the tab is left open across midnight
  setInterval(recalcAll, 60 * 60 * 1000);

  // reset helper (exposed for the appbar button)
  window.SBoard.reset = function () {
    localStorage.removeItem(KEY);
    location.reload();
  };
})();
