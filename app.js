/* Meus Recibos JP — v1
   Tudo fica no aparelho (localStorage, prefixo rec-). Nada é enviado a terceiros.
   A leitura de fotos (OCR) roda no aparelho com Tesseract.js (jpn). */
'use strict';

/* ============ Constantes ============ */
var LS_KEY = 'rec-items';
var CATEGORIES = ['Supermercado', 'Konbini', 'Restaurante', 'Transporte', 'Moradia',
  'Contas da casa', 'Saúde', 'Farmácia', 'Compras', 'Lazer', 'Outros'];
var TYPES = { recibo: 'Recibo', conta: 'Conta', promocao: 'Promoção' };
var TYPE_ICONS = { recibo: '🧾', conta: '📄', promocao: '🏷️' };

var CONTA_KEYWORDS = ['請求', 'お支払い', 'お支払', '払込', '期限', '振込'];
var PROMO_KEYWORDS = ['OFF', 'セール', 'クーポン', '割引'];
var CATEGORY_HINTS = [
  [/セブン|ローソン|ファミリーマート|ミニストップ|コンビニ/, 'Konbini'],
  [/ドラッグ|薬局|マツモトキヨシ|ウエルシア|スギ薬局/, 'Farmácia'],
  [/病院|クリニック|歯科|眼科/, 'Saúde'],
  [/スーパー|イオン|業務スーパー|西友|ライフ|マルエツ/, 'Supermercado'],
  [/電車|バス|タクシー|Suica|PASMO|チャージ/, 'Transporte']
];

/* ============ Utilidades puras ============ */
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function toISODate(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
function todayISO() {
  var t = new Date();
  return toISODate(t.getFullYear(), t.getMonth() + 1, t.getDate());
}
function fmtYen(n) {
  n = Math.round(Number(n) || 0);
  return '¥' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtDateBR(iso) {
  if (!iso) return '—';
  var p = String(iso).split('-');
  if (p.length !== 3) return iso;
  return p[2] + '/' + p[1] + '/' + p[0];
}
function daysUntil(iso) {
  if (!iso) return null;
  var a = new Date(todayISO() + 'T00:00:00');
  var b = new Date(iso + 'T00:00:00');
  if (isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}
function monthKeyOf(iso) { return iso ? String(iso).slice(0, 7) : ''; }
function newId() {
  return 'rec-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* ============ Parser de texto OCR (funções puras, testáveis) ============ */
function findAllDates(text) {
  var out = [];
  var re1 = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/g, m;
  while ((m = re1.exec(text)) !== null) {
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push(toISODate(y, mo, d));
  }
  var re2 = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g;
  while ((m = re2.exec(text)) !== null) {
    var y2 = +m[1], mo2 = +m[2], d2 = +m[3];
    if (mo2 >= 1 && mo2 <= 12 && d2 >= 1 && d2 <= 31) out.push(toISODate(y2, mo2, d2));
  }
  // Reiwa: 令和N年 = 2018 + N
  var re3 = /令和\s*(\d{1,2})年\s*(\d{1,2})月\s*(\d{1,2})日/g;
  while ((m = re3.exec(text)) !== null) {
    out.push(toISODate(2018 + (+m[1]), +m[2], +m[3]));
  }
  return out;
}

function extractAmount(text) {
  var total = null;
  var lines = String(text).split(/\n/);
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('合計') >= 0) {
      var nums = lines[i].match(/[¥￥]?\s*([0-9][0-9,]*)/g) || [];
      var best = null;
      nums.forEach(function (s) {
        var v = parseInt(s.replace(/[¥￥,\s]/g, ''), 10);
        if (!isNaN(v) && (best === null || v > best)) best = v;
      });
      if (best !== null) total = best;
    }
  }
  if (total !== null) return total;
  var max = null;
  var re = /[¥￥]\s*([0-9][0-9,]*)/g, m;
  while ((m = re.exec(text)) !== null) {
    var v = parseInt(m[1].replace(/,/g, ''), 10);
    if (!isNaN(v) && (max === null || v > max)) max = v;
  }
  return max;
}

function classifyType(text) {
  var t = String(text || '');
  for (var i = 0; i < CONTA_KEYWORDS.length; i++) {
    if (t.indexOf(CONTA_KEYWORDS[i]) >= 0) return 'conta';
  }
  for (var j = 0; j < PROMO_KEYWORDS.length; j++) {
    if (t.indexOf(PROMO_KEYWORDS[j]) >= 0) return 'promocao';
  }
  if (t.indexOf('%') >= 0 || t.indexOf('％') >= 0) return 'promocao';
  return 'recibo';
}

function guessCategory(text) {
  for (var i = 0; i < CATEGORY_HINTS.length; i++) {
    if (CATEGORY_HINTS[i][0].test(text)) return CATEGORY_HINTS[i][1];
  }
  return 'Outros';
}

function extractStore(text) {
  var lines = String(text).split(/\n/);
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i].trim();
    if (s.length >= 2 && !/^[0-9¥￥%％\s.,:：\/-]+$/.test(s)) return s.slice(0, 60);
  }
  return '';
}

/* Procura a data na linha do vencimento (期限/お支払い), comum em contas. */
function findDueDate(text) {
  var lines = String(text).split(/\n/);
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('期限') >= 0 || lines[i].indexOf('お支払い') >= 0 || lines[i].indexOf('お支払') >= 0) {
      var ds = findAllDates(lines[i]);
      if (ds.length) return ds[ds.length - 1];
    }
  }
  return null;
}

/* Extrai os campos do formulário a partir do texto lido (OCR ou QR). */
function extractFromText(text) {
  var type = classifyType(text);
  var dates = findAllDates(text);
  var due = null, valid = null;
  if (type === 'conta') due = findDueDate(text) || (dates.length > 1 ? dates[dates.length - 1] : null);
  if (type === 'promocao' && dates.length > 1) valid = dates[dates.length - 1];
  return {
    type: type,
    date: dates.length ? dates[0] : todayISO(),
    store: extractStore(text),
    amount: extractAmount(text),
    category: guessCategory(text),
    dueDate: due,
    validUntil: valid
  };
}

/* ============ Armazenamento ============ */
function loadItems() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveItems(items) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(items)); }
  catch (e) { toast('Espaço cheio: exporte o backup e exclua fotos antigas.'); }
}
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  var type = TYPES[raw.type] ? raw.type : 'recibo';
  return {
    id: String(raw.id),
    type: type,
    date: typeof raw.date === 'string' ? raw.date : todayISO(),
    store: String(raw.store || ''),
    amount: Math.max(0, parseInt(raw.amount, 10) || 0),
    category: CATEGORIES.indexOf(raw.category) >= 0 ? raw.category : 'Outros',
    dueDate: raw.dueDate || null,
    validUntil: raw.validUntil || null,
    paid: !!raw.paid,
    note: String(raw.note || ''),
    link: String(raw.link || ''),
    photo: typeof raw.photo === 'string' && raw.photo.indexOf('data:image') === 0 ? raw.photo : null,
    createdAt: raw.createdAt || Date.now()
  };
}
function mergeImport(existing, incoming) {
  var byId = {};
  existing.forEach(function (it) { byId[it.id] = it; });
  var added = 0, updated = 0;
  incoming.forEach(function (raw) {
    var it = sanitizeItem(raw);
    if (!it) return;
    if (byId[it.id]) updated++; else added++;
    byId[it.id] = it;
  });
  return {
    items: Object.keys(byId).map(function (k) { return byId[k]; }),
    added: added, updated: updated
  };
}

/* ============ Estado e DOM ============ */
var items = [];
var viewMonth = null; // {y, m} m = 0..11
var editingId = null;
var pendingPhoto = null;
var pendingLink = '';
var currentDetailId = null;
var filters = { type: 'todos', category: 'todas', search: '' };

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
var toastTimer = null;
function toast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 3200);
}
function showView(name) {
  ['home', 'add', 'review', 'history', 'detail', 'backup'].forEach(function (v) {
    $('view-' + v).classList.toggle('hidden', v !== name);
  });
  $('tabHome').classList.toggle('on', name === 'home');
  $('tabAdd').classList.toggle('on', name === 'add' || name === 'review');
  $('tabHistory').classList.toggle('on', name === 'history' || name === 'detail');
  window.scrollTo(0, 0);
}

var MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function monthLabel(y, m) { return MONTH_NAMES[m] + ' de ' + y; }
function monthKey(y, m) { return y + '-' + pad2(m + 1); }

/* ============ Início ============ */
function renderHome() {
  var key = monthKey(viewMonth.y, viewMonth.m);
  $('monthLabel').textContent = monthLabel(viewMonth.y, viewMonth.m);

  var monthReceipts = items.filter(function (it) {
    return it.type === 'recibo' && monthKeyOf(it.date) === key;
  });
  var total = monthReceipts.reduce(function (s, it) { return s + it.amount; }, 0);
  $('monthTotal').textContent = fmtYen(total);
  $('monthCount').textContent = monthReceipts.length
    ? monthReceipts.length + (monthReceipts.length === 1 ? ' recibo no mês' : ' recibos no mês')
    : 'Nenhum recibo neste mês';

  var byCat = {};
  monthReceipts.forEach(function (it) { byCat[it.category] = (byCat[it.category] || 0) + it.amount; });
  var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; });
  $('catBars').innerHTML = cats.length ? cats.map(function (c) {
    var pct = total > 0 ? Math.round(byCat[c] / total * 100) : 0;
    return '<div class="catbar"><div class="catbar-top"><span>' + esc(c) + '</span>' +
      '<strong>' + fmtYen(byCat[c]) + '</strong></div>' +
      '<div class="catbar-track"><div class="catbar-fill" style="width:' + pct + '%"></div></div></div>';
  }).join('') : '<div class="empty">Sem gastos registrados neste mês.</div>';

  var today = todayISO();
  var due = items.filter(function (it) { return it.type === 'conta' && !it.paid; })
    .sort(function (a, b) { return String(a.dueDate || a.date).localeCompare(String(b.dueDate || b.date)); });
  $('dueList').innerHTML = due.length ? due.slice(0, 8).map(function (it) {
    var ref = it.dueDate || it.date;
    var overdue = ref < today;
    var d = daysUntil(ref);
    var when = overdue ? 'venceu há ' + Math.abs(d) + (Math.abs(d) === 1 ? ' dia' : ' dias')
      : d === 0 ? 'vence hoje' : 'vence em ' + d + (d === 1 ? ' dia' : ' dias');
    return itemRow(it, '<span class="badge' + (overdue ? ' overdue' : '') + '">' + when + ' • ' + fmtDateBR(ref) + '</span>');
  }).join('') : '<div class="empty">Nenhuma conta pendente. 🎉</div>';

  var promos = items.filter(function (it) {
    return it.type === 'promocao' && (!it.validUntil || it.validUntil >= today);
  }).sort(function (a, b) { return String(a.validUntil || '9999').localeCompare(String(b.validUntil || '9999')); });
  $('promoList').innerHTML = promos.length ? promos.slice(0, 8).map(function (it) {
    var badge = '';
    if (it.validUntil) {
      var d = daysUntil(it.validUntil);
      badge = '<span class="badge">' + (d === 0 ? 'último dia hoje' : 'faltam ' + d + (d === 1 ? ' dia' : ' dias')) + ' • até ' + fmtDateBR(it.validUntil) + '</span>';
    } else badge = '<span class="badge">sem validade definida</span>';
    return itemRow(it, badge);
  }).join('') : '<div class="empty">Nenhuma promoção válida no momento.</div>';
}

function itemRow(it, badgeHtml) {
  var sub = fmtDateBR(it.date) + ' • ' + TYPES[it.type] +
    (it.type === 'recibo' ? ' • ' + esc(it.category) : '') +
    (it.type === 'conta' && it.paid ? ' • <span class="badge paid">paga</span>' : '');
  var thumb = it.photo
    ? '<img class="thumb" src="' + it.photo + '" alt="">'
    : '<div class="thumb thumb-none">' + TYPE_ICONS[it.type] + '</div>';
  var amount = it.amount > 0 ? '<div class="item-amount">' + fmtYen(it.amount) + '</div>' : '';
  return '<button type="button" class="item" data-open="' + esc(it.id) + '">' + thumb +
    '<div class="item-main"><div class="item-title">' + esc(it.store || TYPES[it.type]) + '</div>' +
    '<div class="item-sub">' + sub + '</div>' + (badgeHtml || '') + '</div>' + amount + '</button>';
}

/* ============ Histórico ============ */
function renderHistory() {
  var list = items.filter(function (it) {
    if (filters.type !== 'todos' && it.type !== filters.type) return false;
    if (filters.category !== 'todas' && it.category !== filters.category) return false;
    if (filters.search && it.store.toLowerCase().indexOf(filters.search.toLowerCase()) < 0) return false;
    return true;
  }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || b.createdAt - a.createdAt; });

  if (!list.length) {
    $('historyList').innerHTML = '<div class="card"><div class="empty">Nada por aqui ainda. Toque em ＋ Adicionar para fotografar o primeiro papel.</div></div>';
    return;
  }
  var html = '', lastKey = '';
  list.forEach(function (it) {
    var k = monthKeyOf(it.date);
    if (k !== lastKey) {
      lastKey = k;
      var p = k.split('-');
      html += '<div class="month-group">' + monthLabel(+p[0], (+p[1]) - 1) + '</div>';
    }
    var badge = '';
    if (it.type === 'conta' && it.dueDate && !it.paid) {
      var overdue = it.dueDate < todayISO();
      badge = '<span class="badge' + (overdue ? ' overdue' : '') + '">vence ' + fmtDateBR(it.dueDate) + '</span>';
    }
    if (it.type === 'promocao' && it.validUntil) {
      var d = daysUntil(it.validUntil);
      badge = d < 0 ? '<span class="badge">expirada</span>'
        : '<span class="badge">faltam ' + d + (d === 1 ? ' dia' : ' dias') + '</span>';
    }
    html += itemRow(it, badge);
  });
  $('historyList').innerHTML = html;
}

/* ============ Detalhe ============ */
function renderDetail(id) {
  var it = items.find(function (x) { return x.id === id; });
  if (!it) { showView('history'); renderHistory(); return; }
  currentDetailId = id;
  $('dTitle').textContent = TYPE_ICONS[it.type] + ' ' + (it.store || TYPES[it.type]);
  var ph = $('dPhoto');
  if (it.photo) { ph.src = it.photo; ph.classList.remove('hidden'); }
  else ph.classList.add('hidden');

  var rows = [
    ['Tipo', TYPES[it.type]],
    ['Data', fmtDateBR(it.date)],
    ['Valor', it.amount > 0 ? fmtYen(it.amount) : '—']
  ];
  if (it.type === 'recibo') rows.push(['Categoria', it.category]);
  if (it.type === 'conta') {
    rows.push(['Vencimento', it.dueDate ? fmtDateBR(it.dueDate) : '—']);
    rows.push(['Situação', it.paid ? 'Paga ✅' : 'A pagar']);
  }
  if (it.type === 'promocao' && it.validUntil) rows.push(['Válida até', fmtDateBR(it.validUntil)]);
  if (it.note) rows.push(['Observações', it.note]);
  if (it.link) rows.push(['Link', it.link]);
  $('dFields').innerHTML = rows.map(function (r) {
    return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
  }).join('');

  var tp = $('btnTogglePaid');
  if (it.type === 'conta') {
    tp.classList.remove('hidden');
    tp.textContent = it.paid ? 'Desmarcar como paga' : '✔ Marcar como paga';
  } else tp.classList.add('hidden');
  showView('detail');
}

/* ============ Revisão (obrigatória antes de salvar) ============ */
var formType = 'recibo';
function setFormType(t) {
  formType = t;
  var btns = $('fType').querySelectorAll('button');
  btns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-type') === t); });
  $('wrapDue').classList.toggle('hidden', t !== 'conta');
  $('wrapValid').classList.toggle('hidden', t !== 'promocao');
  $('wrapCategory').classList.toggle('hidden', t !== 'recibo');
}
function openReview(data, photo, link, editId) {
  editingId = editId || null;
  pendingPhoto = photo || null;
  pendingLink = link || '';
  $('reviewTitle').textContent = editId ? 'Editar item' : 'Confira antes de salvar';
  var ph = $('fPhoto');
  if (pendingPhoto) { ph.src = pendingPhoto; ph.classList.remove('hidden'); }
  else ph.classList.add('hidden');
  setFormType(data.type || 'recibo');
  $('fStore').value = data.store || '';
  $('fDate').value = data.date || todayISO();
  $('fAmount').value = data.amount != null ? data.amount : '';
  $('fCategory').value = data.category || 'Outros';
  $('fDue').value = data.dueDate || '';
  $('fValid').value = data.validUntil || '';
  $('fNote').value = data.note || '';
  if (pendingLink) {
    $('fLinkBox').classList.remove('hidden');
    var a = $('fLink');
    a.href = pendingLink; a.textContent = pendingLink;
  } else $('fLinkBox').classList.add('hidden');
  showView('review');
}
function saveFromForm() {
  var amount = parseInt(String($('fAmount').value).replace(/[^0-9]/g, ''), 10);
  var data = {
    id: editingId || newId(),
    type: formType,
    date: $('fDate').value || todayISO(),
    store: $('fStore').value.trim(),
    amount: isNaN(amount) ? 0 : amount,
    category: formType === 'recibo' ? $('fCategory').value : 'Outros',
    dueDate: formType === 'conta' && $('fDue').value ? $('fDue').value : null,
    validUntil: formType === 'promocao' && $('fValid').value ? $('fValid').value : null,
    paid: false,
    note: $('fNote').value.trim(),
    link: pendingLink || '',
    photo: pendingPhoto,
    createdAt: Date.now()
  };
  if (editingId) {
    var old = items.find(function (x) { return x.id === editingId; });
    if (old) { data.paid = old.paid; data.createdAt = old.createdAt; }
    items = items.map(function (x) { return x.id === editingId ? data : x; });
    toast('Item atualizado ✔');
  } else {
    items.push(data);
    toast('Salvo ✔');
  }
  saveItems(items);
  editingId = null; pendingPhoto = null; pendingLink = '';
  viewMonth = { y: +(data.date.slice(0, 4)), m: (+(data.date.slice(5, 7))) - 1 };
  renderHome();
  showView('home');
}

/* ============ Foto + OCR ============ */
function downscaleImage(file, cb) {
  var url = URL.createObjectURL(file);
  var img = new Image();
  img.onload = function () {
    var max = 1200;
    var w = img.naturalWidth, h = img.naturalHeight;
    var scale = Math.min(1, max / Math.max(w, h));
    var cw = Math.round(w * scale), ch = Math.round(h * scale);
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
    URL.revokeObjectURL(url);
    cb(canvas.toDataURL('image/jpeg', 0.7));
  };
  img.onerror = function () { URL.revokeObjectURL(url); toast('Não consegui abrir essa imagem.'); };
  img.src = url;
}
function runOCR(dataUrl) {
  var box = $('ocrBox');
  box.classList.remove('hidden');
  $('ocrStatus').textContent = 'Lendo a foto… (pode levar alguns segundos)';
  $('ocrBar').style.width = '5%';
  if (typeof Tesseract === 'undefined') {
    box.classList.add('hidden');
    toast('Leitura automática indisponível (sem internet?). Preencha manualmente.');
    openReview({ type: 'recibo', date: todayISO(), category: 'Outros' }, dataUrl, '', null);
    return;
  }
  Tesseract.recognize(dataUrl, 'jpn', {
    logger: function (m) {
      if (m.status === 'recognizing text') {
        $('ocrBar').style.width = Math.round(m.progress * 100) + '%';
        $('ocrStatus').textContent = 'Lendo a foto… ' + Math.round(m.progress * 100) + '%';
      } else if (m.status) {
        $('ocrStatus').textContent = 'Preparando leitura…';
      }
    }
  }).then(function (res) {
    box.classList.add('hidden');
    var text = (res && res.data && res.data.text) || '';
    var data = extractFromText(text);
    if (!text.trim()) toast('Não consegui ler o texto. Confira e preencha os campos.');
    openReview(data, dataUrl, '', null);
  }).catch(function () {
    box.classList.add('hidden');
    toast('A leitura falhou. Preencha os campos manualmente.');
    openReview({ type: 'recibo', date: todayISO(), category: 'Outros' }, dataUrl, '', null);
  });
}
function handlePhotoFile(file) {
  if (!file) return;
  downscaleImage(file, function (dataUrl) { runOCR(dataUrl); });
}

/* ============ QR Code ============ */
var qrStream = null, qrRAF = null, qrDetector = null;
function stopQR() {
  if (qrRAF) cancelAnimationFrame(qrRAF);
  qrRAF = null;
  if (qrStream) { qrStream.getTracks().forEach(function (t) { t.stop(); }); qrStream = null; }
  $('qrOverlay').classList.add('hidden');
}
function handleQRText(text) {
  stopQR();
  var data = extractFromText(text);
  var isUrl = /^https?:\/\//i.test(text.trim());
  if (isUrl) {
    data.note = data.note || '';
    openReview({ type: 'recibo', date: todayISO(), category: 'Outros' }, null, text.trim(), null);
  } else {
    openReview(data, null, '', null);
    if (data.amount == null && !data.store) $('fNote').value = text.slice(0, 300);
  }
  toast('QR lido ✔ Confira os dados.');
}
function startQR() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Câmera não disponível neste aparelho/navegador.');
    return;
  }
  $('qrOverlay').classList.remove('hidden');
  $('qrStatus').textContent = 'Aponte a câmera para o QR Code…';
  qrDetector = null;
  if ('BarcodeDetector' in window) {
    try { qrDetector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { qrDetector = null; }
  }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(function (stream) {
      qrStream = stream;
      var video = $('qrVideo');
      video.srcObject = stream;
      video.play();
      var canvas = $('qrCanvas');
      var ctx = canvas.getContext('2d');
      function tick() {
        if (!qrStream) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          if (qrDetector) {
            qrDetector.detect(video).then(function (codes) {
              if (codes && codes.length) { handleQRText(codes[0].rawValue || ''); return; }
              qrRAF = requestAnimationFrame(tick);
            }).catch(function () { qrRAF = requestAnimationFrame(tick); });
            return;
          }
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (typeof jsQR !== 'undefined' && canvas.width) {
            var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var code = jsQR(img.data, img.width, img.height);
            if (code && code.data) { handleQRText(code.data); return; }
          }
        }
        qrRAF = requestAnimationFrame(tick);
      }
      qrRAF = requestAnimationFrame(tick);
    })
    .catch(function () {
      stopQR();
      toast('Sem acesso à câmera. Verifique a permissão do navegador.');
    });
}

/* ============ Backup ============ */
function exportBackup() {
  var payload = JSON.stringify({ app: 'recibos-jp', version: 1, exportedAt: new Date().toISOString(), items: items }, null, 1);
  var blob = new Blob([payload], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'recibos-jp-backup-' + todayISO() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  toast('Backup exportado ✔');
}
function importBackup(file) {
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var parsed = JSON.parse(String(reader.result));
      var incoming = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(incoming)) throw new Error('formato');
      var res = mergeImport(items, incoming);
      items = res.items;
      saveItems(items);
      renderBackupInfo();
      toast('Importado: ' + res.added + ' novo(s), ' + res.updated + ' atualizado(s). Nada foi apagado.');
    } catch (e) {
      toast('Arquivo inválido. Nenhum dado foi alterado.');
    }
  };
  reader.readAsText(file);
}
function renderBackupInfo() {
  $('backupInfo').textContent = items.length + (items.length === 1 ? ' item salvo neste aparelho.' : ' itens salvos neste aparelho.');
}

/* ============ Inicialização ============ */
function fillSelects() {
  $('fCategory').innerHTML = CATEGORIES.map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
  }).join('');
  $('filterCategory').innerHTML = '<option value="todas">Todas as categorias</option>' +
    CATEGORIES.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
}
function bindEvents() {
  $('tabHome').onclick = function () { renderHome(); showView('home'); };
  $('tabAdd').onclick = function () { showView('add'); };
  $('tabHistory').onclick = function () { renderHistory(); showView('history'); };
  $('btnBackup').onclick = function () { renderBackupInfo(); showView('backup'); };

  $('monthPrev').onclick = function () {
    viewMonth.m--; if (viewMonth.m < 0) { viewMonth.m = 11; viewMonth.y--; } renderHome();
  };
  $('monthNext').onclick = function () {
    viewMonth.m++; if (viewMonth.m > 11) { viewMonth.m = 0; viewMonth.y++; } renderHome();
  };

  $('btnCamera').onclick = function () { $('fileCamera').click(); };
  $('btnGallery').onclick = function () { $('fileGallery').click(); };
  $('fileCamera').onchange = function () { handlePhotoFile(this.files[0]); this.value = ''; };
  $('fileGallery').onchange = function () { handlePhotoFile(this.files[0]); this.value = ''; };
  $('btnManual').onclick = function () {
    openReview({ type: 'recibo', date: todayISO(), category: 'Outros' }, null, '', null);
  };
  $('btnQR').onclick = startQR;
  $('btnCloseQR').onclick = stopQR;

  $('fType').querySelectorAll('button').forEach(function (b) {
    b.onclick = function () { setFormType(b.getAttribute('data-type')); };
  });
  $('btnSave').onclick = saveFromForm;
  $('btnCancelReview').onclick = function () {
    editingId = null; pendingPhoto = null; pendingLink = '';
    showView(editingId ? 'detail' : 'home');
    renderHome();
  };

  $('filterType').querySelectorAll('button').forEach(function (b) {
    b.onclick = function () {
      filters.type = b.getAttribute('data-type');
      $('filterType').querySelectorAll('button').forEach(function (x) {
        x.classList.toggle('on', x === b);
      });
      renderHistory();
    };
  });
  $('filterCategory').onchange = function () { filters.category = this.value; renderHistory(); };
  $('filterSearch').oninput = function () { filters.search = this.value; renderHistory(); };

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-open]') : null;
    if (el) renderDetail(el.getAttribute('data-open'));
  });
  $('btnBackDetail').onclick = function () { renderHistory(); showView('history'); };
  $('btnEdit').onclick = function () {
    var it = items.find(function (x) { return x.id === currentDetailId; });
    if (it) openReview(it, it.photo, it.link, it.id);
  };
  $('btnDelete').onclick = function () {
    var it = items.find(function (x) { return x.id === currentDetailId; });
    if (!it) return;
    if (confirm('Excluir "' + (it.store || TYPES[it.type]) + '"? Essa ação não tem volta.')) {
      items = items.filter(function (x) { return x.id !== currentDetailId; });
      saveItems(items);
      toast('Item excluído.');
      renderHistory();
      showView('history');
    }
  };
  $('btnTogglePaid').onclick = function () {
    var it = items.find(function (x) { return x.id === currentDetailId; });
    if (!it) return;
    it.paid = !it.paid;
    saveItems(items);
    toast(it.paid ? 'Conta marcada como paga ✔' : 'Conta marcada como a pagar.');
    renderDetail(currentDetailId);
  };

  $('btnExport').onclick = exportBackup;
  $('btnImport').onclick = function () { $('fileImport').click(); };
  $('fileImport').onchange = function () { if (this.files[0]) importBackup(this.files[0]); this.value = ''; };
}

function init() {
  items = loadItems().map(sanitizeItem).filter(Boolean);
  var now = new Date();
  viewMonth = { y: now.getFullYear(), m: now.getMonth() };
  fillSelects();
  bindEvents();
  renderHome();
  showView('home');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
}

if (typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

/* Exporta as funções puras para testes em Node (ignorado no navegador). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractFromText: extractFromText, classifyType: classifyType,
    extractAmount: extractAmount, findAllDates: findAllDates,
    fmtYen: fmtYen, fmtDateBR: fmtDateBR, mergeImport: mergeImport,
    sanitizeItem: sanitizeItem, CATEGORIES: CATEGORIES
  };
}
