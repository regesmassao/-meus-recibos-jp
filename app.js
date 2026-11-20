/* Meus Recibos JP — v1.4
   Tudo fica no aparelho (localStorage, prefixo rec-). Nada é enviado a terceiros.
   A leitura de fotos (OCR) roda no aparelho com Tesseract.js (jpn).
   v1.3: extração reforçada (nome fantasia, total/valor pago/troco) e
   salvamento automático após a leitura — editar virou opcional.
   v1.4: cada item ganha lugar (place), filial (branch) e telefone; nova
   aba Lugares agrupando visitas por categoria → lugar → filial, com
   filtro por ano; histórico agrupado por ano — uma agenda pessoal de
   lugares. */
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
  [/スーパー|イオン|業務スーパー|西友|ライフ|マルエツ|サンワ|コストコ|マイバスケット|オーケー/, 'Supermercado'],
  [/サイゼリヤ|ガスト|マクドナルド|モスバーガー|すき家|吉野家|松屋|日高屋|スシロー|くら寿司|はま寿司|かっぱ寿司|コメダ|スターバックス|ドトール|タリーズ|レストラン|食堂|ラーメン|居酒屋|カフェ/, 'Restaurante'],
  [/ダイソー|セリア|キャンドゥ|3COINS|ブックオフ|ハードオフ|ドン・キホーテ/, 'Compras'],
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

/* Normaliza o texto do OCR antes de extrair: converte dígitos/letras/
   pontuação de largura cheia (１２３，：) para meia largura, ￥ para ¥ e
   junta espaços que o OCR costuma enfiar no meio dos números
   ("1, 234" e "1 234" viram "1234"). Idempotente. */
function normalizeOcr(text) {
  var t = String(text == null ? '' : text);
  t = t.replace(/[！-～]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  t = t.replace(/　/g, ' ');
  t = t.replace(/￥/g, '¥');
  t = t.replace(/(\d)\s*,\s*(?=\d)/g, '$1,');
  var prev = null;
  while (prev !== t) {
    prev = t;
    t = t.replace(/(\d)\s+(\d{3})(?!\d)/g, '$1$2');
  }
  return t;
}

/* Todos os números de uma linha (sem ¥ nem vírgulas). */
function numbersInLine(line) {
  var out = [];
  var re = /[0-9][0-9,]*[0-9]|[0-9]/g, m;
  while ((m = re.exec(String(line))) !== null) {
    var v = parseInt(m[0].replace(/,/g, ''), 10);
    if (!isNaN(v)) out.push(v);
  }
  return out;
}

/* Procura uma palavra-chave (comparando sem espaços, porque o OCR
   devolve "合 計" / "お 釣 り") e devolve o maior número depois dela na
   mesma linha; se a linha não tiver número, olha a linha seguinte. */
function moneyByKeywords(lines, keywords) {
  for (var i = 0; i < lines.length; i++) {
    var stripped = lines[i].replace(/\s/g, '');
    for (var k = 0; k < keywords.length; k++) {
      var pos = stripped.indexOf(keywords[k]);
      if (pos < 0) continue;
      var nums = numbersInLine(stripped.slice(pos + keywords[k].length));
      if (!nums.length) nums = numbersInLine(lines[i]);
      if (!nums.length && i + 1 < lines.length) nums = numbersInLine(lines[i + 1]);
      if (nums.length) return Math.max.apply(null, nums);
    }
  }
  return null;
}

var TOTAL_KEYWORDS = ['合計金額', '税込合計', 'お買上計', 'お買い上げ',
  '請求金額', 'お支払金額', 'お支払い金額', '合計'];
var TENDERED_KEYWORDS = ['お預かり金', 'お預かり', 'お預り', '預り金'];
var CHANGE_KEYWORDS = ['お釣り', 'おつり', '釣銭', '釣り銭'];

/* Extrai total, valor entregue (お預かり) e troco (お釣り) do texto.
   tendered/change ficam null quando não aparecem no papel. */
function extractMoney(rawText) {
  var text = normalizeOcr(rawText);
  var lines = text.split(/\n/);
  var amount = moneyByKeywords(lines, TOTAL_KEYWORDS);
  if (amount === null) {
    var maxY = null, m;
    var reY = /¥\s*([0-9][0-9,]*)/g;
    while ((m = reY.exec(text)) !== null) {
      var vy = parseInt(m[1].replace(/,/g, ''), 10);
      if (!isNaN(vy) && (maxY === null || vy > maxY)) maxY = vy;
    }
    amount = maxY;
  }
  if (amount === null) {
    var maxE = null;
    var reE = /([0-9][0-9,]*)\s*円/g;
    while ((m = reE.exec(text)) !== null) {
      var ve = parseInt(m[1].replace(/,/g, ''), 10);
      if (!isNaN(ve) && (maxE === null || ve > maxE)) maxE = ve;
    }
    amount = maxE;
  }
  return {
    amount: amount,
    tendered: moneyByKeywords(lines, TENDERED_KEYWORDS),
    change: moneyByKeywords(lines, CHANGE_KEYWORDS)
  };
}

function extractAmount(text) {
  return extractMoney(text).amount;
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

/* Redes conhecidas: [trecho procurado no texto sem espaços, nome exibido].
   O recibo costuma trazer o nome fantasia em destaque e a razão social
   (株式会社…) miúda no rodapé — por isso a rede é procurada no texto
   inteiro antes de olhar linha a linha. */
var CHAIN_NAMES = [
  ['セブン-イレブン', 'セブン-イレブン'], ['セブンイレブン', 'セブン-イレブン'],
  ['ファミリーマート', 'ファミリーマート'], ['ファミマ', 'ファミリーマート'],
  ['ローソン', 'ローソン'], ['ミニストップ', 'ミニストップ'],
  ['デイリーヤマザキ', 'デイリーヤマザキ'],
  ['マイバスケット', 'マイバスケット'], ['まいばすけっと', 'マイバスケット'],
  ['業務スーパー', '業務スーパー'], ['コストコ', 'コストコ'],
  ['マルエツ', 'マルエツ'], ['サンワ', 'サンワ'], ['ライフ', 'ライフ'],
  ['イオン', 'イオン'], ['西友', '西友'], ['オーケー', 'オーケー'],
  ['ドン・キホーテ', 'ドン・キホーテ'], ['ドンキホーテ', 'ドン・キホーテ'],
  ['ダイソー', 'ダイソー'], ['セリア', 'セリア'], ['キャンドゥ', 'キャンドゥ'],
  ['スリーコインズ', '3COINS'], ['3COINS', '3COINS'],
  ['ブックオフ', 'ブックオフ'], ['ハードオフ', 'ハードオフ'],
  ['ノジマ', 'ノジマ'], ['ヤマダ電機', 'ヤマダ電機'], ['ケーズデンキ', 'ケーズデンキ'],
  ['マツモトキヨシ', 'マツモトキヨシ'], ['ウエルシア', 'ウエルシア'],
  ['サンドラッグ', 'サンドラッグ'], ['クリエイト', 'クリエイト'],
  ['マクドナルド', 'マクドナルド'], ['モスバーガー', 'モスバーガー'],
  ['すき家', 'すき家'], ['吉野家', '吉野家'], ['松屋', '松屋'],
  ['ガスト', 'ガスト'], ['サイゼリヤ', 'サイゼリヤ'],
  ['スシロー', 'スシロー'], ['くら寿司', 'くら寿司'],
  ['はま寿司', 'はま寿司'], ['かっぱ寿司', 'かっぱ寿司'],
  ['日高屋', '日高屋'], ['コメダ珈琲', 'コメダ珈琲'],
  ['スターバックス', 'スターバックス'], ['ドトール', 'ドトール'],
  ['タリーズコーヒー', 'タリーズコーヒー'], ['タリーズ', 'タリーズコーヒー']
];

/* Linhas que nunca são o nome da loja: cabeçalhos de recibo, telefone,
   endereço postal, datas, linhas só de números e a linha do total. */
function isJunkStoreLine(s) {
  if (/領収書|領収証|いらっしゃいませ|ありがとう/.test(s)) return true;
  if (/TEL|電話|〒|郵便|登録番号/.test(s)) return true;
  if (/合計|小計/.test(s)) return true;
  if (/^[0-9¥%.,:：\/\-\s]+$/.test(s)) return true;
  var flat = s.replace(/\s/g, '');
  if (/^\d{4}[\/.-]?\d{1,2}[\/.-]?\d{1,2}/.test(flat)) return true;
  if (/\d{4}年\s*\d{1,2}月\s*\d{1,2}日/.test(s)) return true;
  return false;
}

function extractStore(rawText) {
  var text = normalizeOcr(rawText);
  var flatAll = text.replace(/\s/g, '');
  for (var i = 0; i < CHAIN_NAMES.length; i++) {
    if (flatAll.indexOf(CHAIN_NAMES[i][0].replace(/\s/g, '')) >= 0) return CHAIN_NAMES[i][1];
  }
  var lines = text.split(/\n/);
  var legalFallback = '';
  for (var j = 0; j < Math.min(lines.length, 8); j++) {
    var s = lines[j].trim();
    if (s.length < 2 || s.length > 30) continue;
    if (isJunkStoreLine(s)) continue;
    if (/株式会社|有限会社|合同会社|（株）|\(株\)/.test(s)) {
      if (!legalFallback) legalFallback = s;
      continue;
    }
    if (/[ぁ-んァ-ヶ一-龯A-Za-z]/.test(s)) return s;
  }
  return legalFallback.slice(0, 60);
}

/* Nome de lugar "canônico" — a chave de agrupamento da aba Lugares:
   sem espaços sobrando nas pontas nem espaços duplos no meio. */
function normalizePlaceName(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
}

/* Telefone japonês no papel (045-XXX-XXXX, 090-XXXX-XXXX, 03-XXXX-XXXX,
   0120-XXX-XXX). Devolve com hífens ou '' se não achar. Só aceita o
   formato com separadores, pra não confundir com valores e datas. */
function extractPhone(rawText) {
  var text = normalizeOcr(rawText);
  var patterns = [
    /0120[- ]\d{3}[- ]\d{3}/,
    /0\d{1,4}[- ]\d{1,4}[- ]\d{4}/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = patterns[i].exec(text);
    if (m) {
      var digits = m[0].replace(/[^0-9]/g, '');
      if (digits.length >= 10 && digits.length <= 11) return m[0].replace(/\s/g, '-');
    }
  }
  return '';
}

/* Separa lugar (place) e filial (branch) a partir do texto lido.
   Rede conhecida: place é o nome fantasia da rede; a filial é o que vem
   logo depois do nome na mesma linha (…生麦店) ou uma linha vizinha do
   topo que é só o nome da filial. Fora de rede: place é o nome extraído
   linha a linha, sem filial. `store` continua sendo o texto de
   exibição: place + ' ' + branch. */
function extractPlaceInfo(rawText) {
  var text = normalizeOcr(rawText);
  var lines = text.split(/\n/);
  var flatAll = text.replace(/\s/g, '');
  for (var i = 0; i < CHAIN_NAMES.length; i++) {
    var needle = CHAIN_NAMES[i][0].replace(/\s/g, '');
    if (flatAll.indexOf(needle) < 0) continue;
    var display = CHAIN_NAMES[i][1];
    var branch = '';
    for (var j = 0; j < lines.length && !branch; j++) {
      var flatLine = lines[j].replace(/\s/g, '');
      var pos = flatLine.indexOf(needle);
      if (pos < 0) continue;
      var suffix = flatLine.slice(pos + needle.length);
      var cut = suffix.indexOf('店');
      if (cut >= 0) {
        var cand = suffix.slice(0, cut + 1);
        if (cand.length >= 2 && cand.length <= 14) branch = cand;
      }
    }
    if (!branch) {
      for (var k = 0; k < Math.min(lines.length, 8); k++) {
        var s = lines[k].trim().replace(/\s/g, '');
        if (s.length < 3 || s.length > 14) continue;
        if (!/店$/.test(s)) continue;
        if (/合計|小計|TEL|電話/.test(s)) continue;
        if (s.indexOf(needle) >= 0) continue;
        branch = s;
        break;
      }
    }
    return {
      place: display,
      branch: branch,
      store: display + (branch ? ' ' + branch : '')
    };
  }
  var store = extractStore(text);
  return { place: normalizePlaceName(store), branch: '', store: store };
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
function extractFromText(rawText) {
  var text = normalizeOcr(rawText);
  var type = classifyType(text);
  var dates = findAllDates(text);
  var money = extractMoney(text);
  var info = extractPlaceInfo(text);
  var due = null, valid = null;
  if (type === 'conta') due = findDueDate(text) || (dates.length > 1 ? dates[dates.length - 1] : null);
  if (type === 'promocao' && dates.length > 1) valid = dates[dates.length - 1];
  return {
    type: type,
    date: dates.length ? dates[0] : todayISO(),
    store: info.store,
    place: info.place,
    branch: info.branch,
    phone: extractPhone(text),
    amount: money.amount,
    tendered: money.tendered,
    change: money.change,
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
  var store = String(raw.store || '');
  /* Migração v1.4: item antigo sem `place` herda o nome da loja
     (normalizado) — nenhum dado se perde. */
  var place = normalizePlaceName(
    typeof raw.place === 'string' && raw.place ? raw.place : store);
  var phoneDigits = String(raw.phone || '').replace(/[^0-9]/g, '');
  return {
    id: String(raw.id),
    type: type,
    date: typeof raw.date === 'string' ? raw.date : todayISO(),
    store: store,
    place: place,
    branch: normalizePlaceName(raw.branch || ''),
    phone: phoneDigits.length >= 10 && phoneDigits.length <= 11
      ? String(raw.phone || '').replace(/\s/g, '-')
      : '',
    amount: Math.max(0, parseInt(raw.amount, 10) || 0),
    tendered: Math.max(0, parseInt(raw.tendered, 10) || 0),
    change: Math.max(0, parseInt(raw.change, 10) || 0),
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

/* ============ Lugares: agrupamento (funções puras) ============ */
/* Junta os recibos por lugar (place): quantas visitas, quanto somou,
   primeira/última visita, categoria mais frequente do lugar, telefone
   (o primeiro que aparecer num recibo) e a quebra por filial — a
   filial '' representa recibos sem filial identificada. yearFilter é
   'todos' ou um ano '2026'. Ordena por visitas, depois por total. */
function groupPlaces(list, yearFilter) {
  var map = {};
  (list || []).forEach(function (it) {
    if (!it || it.type !== 'recibo') return;
    var place = normalizePlaceName(it.place || it.store || '');
    if (!place) return;
    if (yearFilter && yearFilter !== 'todos' &&
        String(it.date || '').slice(0, 4) !== String(yearFilter)) return;
    var g = map[place];
    if (!g) {
      g = map[place] = {
        place: place, visits: 0, total: 0, avg: 0,
        firstDate: '', lastDate: '', category: 'Outros',
        phone: '', cats: {}, branches: {}, items: []
      };
    }
    g.visits++;
    g.total += Math.max(0, parseInt(it.amount, 10) || 0);
    if (!g.firstDate || it.date < g.firstDate) g.firstDate = it.date;
    if (!g.lastDate || it.date > g.lastDate) g.lastDate = it.date;
    var cat = it.category || 'Outros';
    g.cats[cat] = (g.cats[cat] || 0) + 1;
    var br = normalizePlaceName(it.branch || '');
    var b = g.branches[br];
    if (!b) b = g.branches[br] = { branch: br, visits: 0, total: 0 };
    b.visits++;
    b.total += Math.max(0, parseInt(it.amount, 10) || 0);
    if (!g.phone && it.phone) g.phone = it.phone;
    g.items.push(it);
  });
  var out = Object.keys(map).map(function (k) {
    var g = map[k];
    var best = 'Outros', bestN = -1;
    Object.keys(g.cats).forEach(function (c) {
      if (g.cats[c] > bestN) { bestN = g.cats[c]; best = c; }
    });
    g.category = best;
    g.avg = g.visits ? Math.round(g.total / g.visits) : 0;
    g.branchList = Object.keys(g.branches).map(function (bk) { return g.branches[bk]; })
      .sort(function (a, b) { return b.visits - a.visits || b.total - a.total; });
    g.items.sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || b.createdAt - a.createdAt;
    });
    return g;
  });
  out.sort(function (a, b) { return b.visits - a.visits || b.total - a.total; });
  return out;
}

/* Anos que têm pelo menos um recibo com lugar, do mais novo pro mais velho. */
function placeYears(list) {
  var seen = {};
  (list || []).forEach(function (it) {
    if (!it || it.type !== 'recibo') return;
    if (!normalizePlaceName(it.place || it.store || '')) return;
    var y = String(it.date || '').slice(0, 4);
    if (/^\d{4}$/.test(y)) seen[y] = true;
  });
  return Object.keys(seen).sort().reverse();
}

/* ============ Estado e DOM ============ */
var items = [];
var viewMonth = null; // {y, m} m = 0..11
var editingId = null;
var pendingPhoto = null;
var pendingLink = '';
var currentDetailId = null;
var placesYear = 'todos'; // filtro da aba Lugares
var currentPlace = ''; // lugar aberto no detalhe de lugar
var placeReturn = 'places'; // de onde o detalhe de lugar foi aberto
var detailReturn = 'history'; // de onde o detalhe do item foi aberto
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
  ['home', 'add', 'review', 'history', 'detail', 'backup', 'places', 'place'].forEach(function (v) {
    $('view-' + v).classList.toggle('hidden', v !== name);
  });
  $('tabHome').classList.toggle('on', name === 'home');
  $('tabAdd').classList.toggle('on', name === 'add' || name === 'review');
  $('tabPlaces').classList.toggle('on',
    name === 'places' || name === 'place' || (name === 'detail' && detailReturn === 'place'));
  $('tabHistory').classList.toggle('on',
    name === 'history' || (name === 'detail' && detailReturn !== 'place'));
  window.scrollTo(0, 0);
}

var MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function monthLabel(y, m) { return MONTH_NAMES[m] + ' de ' + y; }
function monthKey(y, m) { return y + '-' + pad2(m + 1); }

/* ============ Início (painel) ============ */
function renderHome() {
  var key = monthKey(viewMonth.y, viewMonth.m);
  $('monthLabel').textContent = monthLabel(viewMonth.y, viewMonth.m);

  var monthReceipts = items.filter(function (it) {
    return it.type === 'recibo' && monthKeyOf(it.date) === key;
  });
  var total = monthReceipts.reduce(function (s, it) { return s + it.amount; }, 0);

  /* --- KPIs do mês --- */
  $('monthTotal').textContent = fmtYen(total);
  $('kpiReceipts').textContent = String(monthReceipts.length);
  var monthPlaces = groupPlaces(monthReceipts, 'todos');
  $('kpiPlaces').textContent = String(monthPlaces.length);
  $('kpiAvg').textContent = monthReceipts.length
    ? fmtYen(Math.round(total / monthReceipts.length)) : '¥0';

  /* --- Gráfico 1: gasto por categoria (toca → histórico filtrado) --- */
  var byCat = {};
  monthReceipts.forEach(function (it) { byCat[it.category] = (byCat[it.category] || 0) + it.amount; });
  var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; });
  var maxCat = cats.length ? byCat[cats[0]] : 0;
  $('catBars').innerHTML = cats.length ? cats.map(function (c) {
    var pct = maxCat > 0 ? Math.round(byCat[c] / maxCat * 100) : 0;
    return '<button type="button" class="barbtn" data-cat="' + esc(c) + '">' +
      '<div class="catbar-top"><span>' + esc(c) + '</span>' +
      '<strong>' + fmtYen(byCat[c]) + '</strong></div>' +
      '<div class="catbar-track"><div class="catbar-fill" style="width:' + pct + '%"></div></div></button>';
  }).join('') : '<div class="empty">Sem gastos registrados neste mês.</div>';

  /* --- Gráfico 2: top lugares do mês (toca → detalhe do lugar) --- */
  var topPlaces = monthPlaces.slice().sort(function (a, b) { return b.total - a.total; }).slice(0, 5);
  var maxPlace = topPlaces.length ? topPlaces[0].total : 0;
  $('topPlaces').innerHTML = topPlaces.length ? topPlaces.map(function (g) {
    var pct = maxPlace > 0 ? Math.round(g.total / maxPlace * 100) : 0;
    return '<button type="button" class="barbtn" data-place="' + esc(g.place) + '">' +
      '<div class="catbar-top"><span>📍 ' + esc(g.place) + '</span>' +
      '<strong>' + fmtYen(g.total) + '</strong></div>' +
      '<div class="catbar-track"><div class="catbar-fill place-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="bar-sub">' + g.visits + (g.visits === 1 ? ' visita' : ' visitas') + '</div></button>';
  }).join('') : '<div class="empty">Nenhum lugar visitado neste mês.</div>';

  /* --- Gráfico 3: gasto por mês, últimos 6 (toca → vai pro mês) --- */
  var months = [];
  for (var back = 5; back >= 0; back--) {
    var d = new Date(viewMonth.y, viewMonth.m - back, 1);
    var mk = monthKey(d.getFullYear(), d.getMonth());
    var mt = items.filter(function (it) {
      return it.type === 'recibo' && monthKeyOf(it.date) === mk;
    }).reduce(function (s, it) { return s + it.amount; }, 0);
    months.push({ key: mk, y: d.getFullYear(), m: d.getMonth(), total: mt });
  }
  var maxMonth = Math.max.apply(null, months.map(function (x) { return x.total; }).concat([0]));
  $('monthBars').innerHTML = months.map(function (x) {
    var pct = maxMonth > 0 ? Math.round(x.total / maxMonth * 100) : 0;
    var label = MONTH_NAMES[x.m].slice(0, 3) + '/' + String(x.y).slice(2);
    return '<button type="button" class="barbtn' + (x.key === key ? ' on-month' : '') +
      '" data-monthbtn="' + x.key + '">' +
      '<div class="catbar-top"><span>' + label + '</span>' +
      '<strong>' + fmtYen(x.total) + '</strong></div>' +
      '<div class="catbar-track"><div class="catbar-fill month-fill" style="width:' + pct + '%"></div></div></button>';
  }).join('');

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
  /* Total de recibos por ano (dentro da lista já filtrada), pra linha
     de total de cada grupo de ano. */
  var yearTotals = {};
  list.forEach(function (it) {
    if (it.type !== 'recibo') return;
    var y = String(it.date || '').slice(0, 4);
    yearTotals[y] = (yearTotals[y] || 0) + (it.amount || 0);
  });
  var html = '', lastYear = '';
  list.forEach(function (it) {
    var y = String(it.date || '').slice(0, 4);
    if (y !== lastYear) {
      lastYear = y;
      html += '<div class="month-group">' + esc(y) +
        (yearTotals[y] ? ' · total do ano: ' + fmtYen(yearTotals[y]) : '') + '</div>';
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

/* Abre o histórico já filtrado por uma categoria (vindo do gráfico
   de categorias do painel). */
function openHistoryCategory(cat) {
  filters.category = cat;
  filters.type = 'todos';
  $('filterCategory').value = cat;
  $('filterType').querySelectorAll('button').forEach(function (x) {
    x.classList.toggle('on', x.getAttribute('data-type') === 'todos');
  });
  renderHistory();
  showView('history');
}

/* ============ Lugares ============ */
function placeRow(g) {
  var sub = g.visits + (g.visits === 1 ? ' visita' : ' visitas') +
    ' · última em ' + fmtDateBR(g.lastDate);
  return '<button type="button" class="item" data-place="' + esc(g.place) + '">' +
    '<div class="thumb thumb-none">📍</div>' +
    '<div class="item-main"><div class="item-title">' + esc(g.place) + '</div>' +
    '<div class="item-sub">' + sub + '</div></div>' +
    '<div class="item-amount">' + fmtYen(g.total) + '</div></button>';
}

function renderPlaces() {
  var years = placeYears(items);
  if (placesYear !== 'todos' && years.indexOf(placesYear) < 0) placesYear = 'todos';
  var seg = '<button type="button" data-year="todos"' +
    (placesYear === 'todos' ? ' class="on"' : '') + '>Todos</button>';
  years.forEach(function (y) {
    seg += '<button type="button" data-year="' + esc(y) + '"' +
      (placesYear === y ? ' class="on"' : '') + '>' + esc(y) + '</button>';
  });
  $('placeYears').innerHTML = seg;
  $('placeYears').querySelectorAll('button').forEach(function (b) {
    b.onclick = function () { placesYear = b.getAttribute('data-year'); renderPlaces(); };
  });

  var groups = groupPlaces(items, placesYear);
  if (!groups.length) {
    $('placesList').innerHTML = '<div class="card"><div class="empty">Nenhum lugar por aqui ainda. Os lugares aparecem quando você fotografa recibos — cada loja e restaurante vira um lugar com visitas e somas.</div></div>';
    return;
  }
  /* Categoria → lugares (na ordem da lista de categorias do app). */
  var byCat = {};
  groups.forEach(function (g) {
    (byCat[g.category] = byCat[g.category] || []).push(g);
  });
  var html = '';
  CATEGORIES.forEach(function (c) {
    if (!byCat[c]) return;
    html += '<div class="month-group">' + esc(c) + '</div>';
    byCat[c].forEach(function (g) { html += placeRow(g); });
  });
  $('placesList').innerHTML = html;
}

/* Detalhe do lugar: totais de todos os anos (a "agenda" do lugar),
   telefone quando algum recibo trouxe, quebra por filial quando há
   mais de um grupo de filial e os recibos do lugar. */
function renderPlaceDetail(place) {
  var groups = groupPlaces(items, 'todos');
  var g = null;
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].place === place) { g = groups[i]; break; }
  }
  if (!g) { renderPlaces(); showView('places'); return; }
  currentPlace = g.place;
  $('pTitle').textContent = '📍 ' + g.place;

  var phoneBox = $('pPhoneBox');
  if (g.phone) {
    phoneBox.innerHTML = '<a class="telbtn" href="tel:' +
      esc(g.phone.replace(/[^0-9+]/g, '')) + '">📞 ' + esc(g.phone) + '</a>';
    phoneBox.classList.remove('hidden');
  } else {
    phoneBox.innerHTML = '';
    phoneBox.classList.add('hidden');
  }

  var rows = [
    ['Categoria', g.category],
    ['Visitas', String(g.visits)],
    ['Total gasto', fmtYen(g.total)],
    ['Média por visita', fmtYen(g.avg)],
    ['Primeira visita', fmtDateBR(g.firstDate)],
    ['Última visita', fmtDateBR(g.lastDate)]
  ];
  $('pFields').innerHTML = rows.map(function (r) {
    return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
  }).join('');

  var bw = $('pBranchesWrap');
  if (g.branchList.length > 1) {
    $('pBranches').innerHTML = g.branchList.map(function (b) {
      var name = b.branch || 'Sem filial identificada';
      return '<div class="branch-row"><span>' + esc(name) + '</span>' +
        '<strong>' + b.visits + (b.visits === 1 ? ' visita' : ' visitas') +
        ' · ' + fmtYen(b.total) + '</strong></div>';
    }).join('');
    bw.classList.remove('hidden');
  } else {
    $('pBranches').innerHTML = '';
    bw.classList.add('hidden');
  }

  $('pItems').innerHTML = g.items.map(function (it) { return itemRow(it, ''); }).join('');
  showView('place');
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
  if (it.tendered > 0) rows.push(['Valor pago', fmtYen(it.tendered)]);
  if (it.change > 0) rows.push(['Troco', fmtYen(it.change)]);
  if (it.type === 'recibo') rows.push(['Categoria', it.category]);
  if (it.type === 'recibo' && it.place) {
    rows.push(['Lugar', it.place + (it.branch ? ' · ' + it.branch : '')]);
  }
  if (it.phone) rows.push(['Telefone', it.phone]);
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

/* ============ Edição (opcional, depois de salvar) ============ */
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
  $('fTendered').value = data.tendered ? data.tendered : '';
  $('fChange').value = data.change ? data.change : '';
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
  var tendered = parseInt(String($('fTendered').value).replace(/[^0-9]/g, ''), 10);
  var change = parseInt(String($('fChange').value).replace(/[^0-9]/g, ''), 10);
  var data = {
    id: editingId || newId(),
    type: formType,
    date: $('fDate').value || todayISO(),
    store: $('fStore').value.trim(),
    place: '',
    branch: '',
    phone: '',
    amount: isNaN(amount) ? 0 : amount,
    tendered: isNaN(tendered) ? 0 : tendered,
    change: isNaN(change) ? 0 : change,
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
    if (old) {
      data.paid = old.paid; data.createdAt = old.createdAt;
      data.phone = old.phone || '';
      /* Se o nome não mudou, mantém lugar/filial; se mudou, o lugar
         passa a ser o nome novo (sem filial). */
      if (data.store === old.store) {
        data.place = old.place || '';
        data.branch = old.branch || '';
      } else {
        data.place = normalizePlaceName(data.store);
        data.branch = '';
      }
    }
    items = items.map(function (x) { return x.id === editingId ? sanitizeItem(data) || data : x; });
    toast('Item atualizado ✔');
  } else {
    data.place = normalizePlaceName(data.store);
    items.push(sanitizeItem(data) || data);
    toast('Salvo ✔');
  }
  saveItems(items);
  editingId = null; pendingPhoto = null; pendingLink = '';
  viewMonth = { y: +(data.date.slice(0, 4)), m: (+(data.date.slice(5, 7))) - 1 };
  renderHome();
  showView('home');
}

/* ============ Salvamento automático (foto/QR) ============ */
/* Fotografou, salvou: o item entra na hora com o que a leitura achou —
   mesmo que não tenha achado nada (fica a foto e a data de hoje).
   Conferir e corrigir é opcional, depois, tocando no item no
   histórico (detalhe → Editar). */
function saveExtractedItem(data, photo, link) {
  var item = sanitizeItem({
    id: newId(),
    type: data.type || 'recibo',
    date: data.date || todayISO(),
    store: data.store || '',
    place: data.place || '',
    branch: data.branch || '',
    phone: data.phone || '',
    amount: data.amount != null ? data.amount : 0,
    tendered: data.tendered != null ? data.tendered : 0,
    change: data.change != null ? data.change : 0,
    category: data.type === 'recibo' ? (data.category || 'Outros') : 'Outros',
    dueDate: data.dueDate || null,
    validUntil: data.validUntil || null,
    paid: false,
    note: data.note || '',
    link: link || '',
    photo: photo || null,
    createdAt: Date.now()
  });
  items.push(item);
  saveItems(items);
  viewMonth = { y: +(item.date.slice(0, 4)), m: (+(item.date.slice(5, 7))) - 1 };
  renderHome();
  showView('home');
  var summary = 'Salvo ✔ ' + (item.store || TYPES[item.type]) +
    (item.amount > 0 ? ' · ' + fmtYen(item.amount) : '');
  toast(summary + ' — se algo estiver errado, toque no item pra corrigir.');
  return item;
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
    saveExtractedItem({ type: 'recibo', date: todayISO(), category: 'Outros' }, dataUrl, '');
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
    saveExtractedItem(data, dataUrl, '');
  }).catch(function () {
    box.classList.add('hidden');
    saveExtractedItem({ type: 'recibo', date: todayISO(), category: 'Outros' }, dataUrl, '');
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
  var isUrl = /^https?:\/\//i.test(text.trim());
  if (isUrl) {
    saveExtractedItem({ type: 'recibo', date: todayISO(), category: 'Outros' }, null, text.trim());
  } else {
    var data = extractFromText(text);
    if (data.amount == null && !data.store) data.note = text.slice(0, 300);
    saveExtractedItem(data, null, '');
  }
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
/* O backup carrega SÓ os itens. Link/chave da nuvem (rec-drive*) vivem
   em outras chaves do localStorage e nunca entram neste arquivo; na
   importação, só o campo `items` é lido (e cada item passa pela lista
   branca do sanitizeItem), então nada de configuração viaja junto. */
function buildBackupPayload() {
  return { app: 'recibos-jp', version: 1, exportedAt: new Date().toISOString(), items: items };
}
function exportBackup() {
  var payload = JSON.stringify(buildBackupPayload(), null, 1);
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
/* Junta itens vindos de fora (arquivo importado ou nuvem) por id,
   sem apagar nada local. Mesma lógica para as duas origens. */
function applyIncomingItems(incoming) {
  var res = mergeImport(items, incoming);
  items = res.items;
  saveItems(items);
  renderBackupInfo();
  return res;
}
function importBackup(file) {
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var parsed = JSON.parse(String(reader.result));
      var incoming = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(incoming)) throw new Error('formato');
      var res = applyIncomingItems(incoming);
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

/* ============ Nuvem (Google Drive) ============ */
/* Mesma ponte dos outros apps: um Apps Script na conta Google dele
   guarda UM arquivo de backup no Drive. GET ?key=&action=read devolve
   {ok, exists, updatedAt, data}; POST ?key=&action=write (corpo = o
   JSON do backup, como texto puro, pra não disparar preflight de CORS)
   devolve {ok, updatedAt}. Link e chave ficam salvos só neste aparelho
   (rec-driveUrl/rec-driveKey), fora de qualquer backup. */
function driveConfig() {
  return {
    url: String(localStorage.getItem('rec-driveUrl') || '').trim(),
    key: String(localStorage.getItem('rec-driveKey') || '').trim()
  };
}
function driveApiUrl(action) {
  var c = driveConfig();
  var sep = c.url.indexOf('?') >= 0 ? '&' : '?';
  return c.url + sep + 'key=' + encodeURIComponent(c.key) + '&action=' + action;
}
function driveSetStatus(msg) {
  var el = $('driveStatus');
  if (el) el.textContent = msg;
}
function driveFmtWhen(ts) {
  var n = Number(ts || 0);
  return n > 0 ? new Date(n).toLocaleString('pt-BR') : 'nunca';
}
function driveRenderSync() {
  var el = $('driveSync');
  if (!el) return;
  el.textContent = 'Envio: ' + driveFmtWhen(localStorage.getItem('rec-driveLastUp')) +
    ' · Baixa: ' + driveFmtWhen(localStorage.getItem('rec-driveLastDown'));
}
function driveSaveConfig() {
  localStorage.setItem('rec-driveUrl', String($('driveUrl').value || '').trim());
  localStorage.setItem('rec-driveKey', String($('driveKey').value || '').trim());
  driveSetStatus('✔️ Link e chave salvos neste aparelho.');
  driveCheckOnOpen();
}
function driveFetchJson(url, options) {
  var p;
  try { p = fetch(url, options); } catch (e) { p = Promise.reject(e); }
  return p.then(function (res) {
    return res.json().catch(function () { return null; });
  }).then(function (body) {
    if (!body || body.ok !== true) {
      if (body && body.error === 'unauthorized') throw new Error('unauthorized');
      throw new Error('network');
    }
    return body;
  }).catch(function (e) {
    if (e && e.message === 'unauthorized') throw e;
    throw new Error('network');
  });
}
function driveErrorToast(e) {
  toast(e && e.message === 'unauthorized'
    ? '❌ O script recusou a chave. Confira se a chave salva aqui é igual à chave do script.'
    : '❌ Não consegui falar com o script. Confira o link e a conexão com a internet.');
}
function driveUpload() {
  var c = driveConfig();
  if (!c.url || !c.key) { toast('Primeiro cole o link do script e a chave secreta, e toque em Salvar.'); return; }
  driveSetStatus('Enviando pra nuvem…');
  driveFetchJson(driveApiUrl('write'), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(buildBackupPayload())
  }).then(function (r) {
    localStorage.setItem('rec-driveLastUp', String(Date.now()));
    if (r.updatedAt) localStorage.setItem('rec-driveRemoteAt', String(r.updatedAt));
    driveSetStatus('✔️ Backup enviado pra nuvem com ' + items.length + (items.length === 1 ? ' item.' : ' itens.'));
    toast('Backup enviado pra nuvem ✔');
    driveRenderSync();
    driveHideNotice();
  }).catch(function (e) {
    driveSetStatus('');
    driveErrorToast(e);
  });
}
function driveDownload() {
  var c = driveConfig();
  if (!c.url || !c.key) { toast('Primeiro cole o link do script e a chave secreta, e toque em Salvar.'); return; }
  driveSetStatus('Consultando a nuvem…');
  driveFetchJson(driveApiUrl('read'), { method: 'GET' }).then(function (r) {
    if (!r.exists || !r.data) {
      driveSetStatus('Ainda não há backup na nuvem. Envie o primeiro pelo botão de enviar.');
      return;
    }
    var data = r.data;
    if (!data || typeof data !== 'object' || data.app !== 'recibos-jp' || !Array.isArray(data.items)) {
      driveSetStatus('❌ O que veio da nuvem não é um backup válido. Nada foi alterado.');
      return;
    }
    /* Mesma junção do importar arquivo: merge por id, nunca apaga. */
    var res = applyIncomingItems(data.items);
    localStorage.setItem('rec-driveLastDown', String(Date.now()));
    if (r.updatedAt) localStorage.setItem('rec-driveRemoteAt', String(r.updatedAt));
    driveSetStatus('');
    driveRenderSync();
    driveHideNotice();
    renderHome();
    toast('Baixado da nuvem: ' + res.added + ' novo(s), ' + res.updated + ' atualizado(s). Nada foi apagado.');
  }).catch(function (e) {
    driveSetStatus('');
    driveErrorToast(e);
  });
}
function driveShowNotice(iso) {
  var box = $('driveNotice'), txt = $('driveNoticeText');
  if (!box || !txt) return;
  var d = iso ? new Date(iso) : null;
  txt.textContent = '☁️ Há um backup mais novo na nuvem (de ' +
    (d && !isNaN(d.getTime()) ? d.toLocaleString('pt-BR') : String(iso || '')) +
    '). Se quiser trazer pra este aparelho, abra Backup → “Baixar da nuvem e juntar”.';
  box.classList.remove('hidden');
}
function driveHideNotice() {
  var box = $('driveNotice');
  if (box) box.classList.add('hidden');
}
function driveCheckOnOpen() {
  var c = driveConfig();
  if (!c.url || !c.key) return;
  driveFetchJson(driveApiUrl('read'), { method: 'GET' }).then(function (r) {
    if (!r.exists || !r.updatedAt) return;
    var known = String(localStorage.getItem('rec-driveRemoteAt') || '');
    if (String(r.updatedAt) !== known) driveShowNotice(r.updatedAt);
  }).catch(function () { /* silencioso: abrir o app nunca mostra erro da nuvem */ });
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
  $('tabPlaces').onclick = function () { renderPlaces(); showView('places'); };
  $('tabHistory').onclick = function () { detailReturn = 'history'; renderHistory(); showView('history'); };
  $('btnBackup').onclick = function () { renderBackupInfo(); driveRenderSync(); showView('backup'); };

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
    if (!ev.target.closest) return;
    var mb = ev.target.closest('[data-monthbtn]');
    if (mb) {
      var p = mb.getAttribute('data-monthbtn').split('-');
      viewMonth = { y: +p[0], m: (+p[1]) - 1 };
      renderHome();
      showView('home');
      return;
    }
    var cb = ev.target.closest('[data-cat]');
    if (cb) { openHistoryCategory(cb.getAttribute('data-cat')); return; }
    var pl = ev.target.closest('[data-place]');
    if (pl) {
      placeReturn = pl.closest && pl.closest('#view-home') ? 'home' : 'places';
      renderPlaceDetail(pl.getAttribute('data-place'));
      return;
    }
    var el = ev.target.closest('[data-open]');
    if (el) {
      detailReturn = el.closest && el.closest('#view-place') ? 'place' : 'history';
      renderDetail(el.getAttribute('data-open'));
    }
  });
  $('btnBackPlace').onclick = function () {
    if (placeReturn === 'home') { renderHome(); showView('home'); }
    else { renderPlaces(); showView('places'); }
  };
  $('btnBackDetail').onclick = function () {
    if (detailReturn === 'place' && currentPlace) { renderPlaceDetail(currentPlace); return; }
    renderHistory(); showView('history');
  };
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

  $('driveSave').onclick = driveSaveConfig;
  $('driveUp').onclick = driveUpload;
  $('driveDown').onclick = driveDownload;
  $('driveNoticeClose').onclick = driveHideNotice;
}

function init() {
  var rawItems = loadItems();
  var needsMigration = rawItems.some(function (r) {
    return r && typeof r === 'object' && r.place === undefined;
  });
  items = rawItems.map(sanitizeItem).filter(Boolean);
  if (needsMigration) saveItems(items); // grava place/branch/phone derivados
  var now = new Date();
  viewMonth = { y: now.getFullYear(), m: now.getMonth() };
  fillSelects();
  bindEvents();
  $('driveUrl').value = localStorage.getItem('rec-driveUrl') || '';
  $('driveKey').value = localStorage.getItem('rec-driveKey') || '';
  driveRenderSync();
  renderHome();
  showView('home');
  driveCheckOnOpen();
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
    extractAmount: extractAmount, extractMoney: extractMoney,
    extractStore: extractStore, extractPlaceInfo: extractPlaceInfo,
    extractPhone: extractPhone, normalizeOcr: normalizeOcr,
    normalizePlaceName: normalizePlaceName,
    groupPlaces: groupPlaces, placeYears: placeYears,
    findAllDates: findAllDates,
    fmtYen: fmtYen, fmtDateBR: fmtDateBR, mergeImport: mergeImport,
    sanitizeItem: sanitizeItem, CATEGORIES: CATEGORIES,
    buildBackupPayload: buildBackupPayload
  };
}
