/* Meus Recibos JP — v1.9
   Tudo fica no aparelho (localStorage, prefixo rec-). Nada é enviado a terceiros.
   A leitura de fotos (OCR) roda no aparelho com Tesseract.js (jpn).
   v1.3: extração reforçada (nome fantasia, total/valor pago/troco) e
   salvamento automático após a leitura — editar virou opcional.
   v1.4: cada item ganha lugar (place), filial (branch) e telefone; nova
   aba Lugares agrupando visitas por categoria → lugar → filial, com
   filtro por ano; histórico agrupado por ano — uma agenda pessoal de
   lugares.
   v1.5: OCR refeito — a foto é recortada na faixa do papel (fundo escuro
   virava ruído), ganha contraste e é lida em 3 passadas (PSM 4) em
   escalas/recortes diferentes, com os textos combinados; extração
   tolerante a erros típicos do OCR (0→C/Z no ano, "/"→7 na data,
   "2.900" com ponto, お預り sem o 預 legível, 9 lido como 3 etc.).
   Diagnóstico completo em test-ocr/DIAGNOSTICO-v1.5.md (fora do repo).
   v1.6: fidelidade ao recibo — o total é o 合計 impresso; 小計（税抜）
   nunca vira total (com 消費税 lido e o 合計 ilegível, o total é a
   soma dos dois componentes impressos, confirmada por outro valor
   do papel); a taxa ("8%") não é mais confundida com dinheiro; data
   no formato 年月日 com espaços entre os blocos; rede canoniza
   mesmo com kana trocado/engolido ("セブンイブン" → セブン-イレブン);
   valor picado do rodapé ("1. 06 ら 0") recompõe o お預り; e cada
   item guarda `photoAt` (data da foto, via EXIF) separado da data
   do recibo — quem manda em totais/histórico/Lugares é a do recibo.
   Diagnóstico completo em test-ocr/DIAGNOSTICO-v1.6.md (fora do repo).
   v1.7: a v1.6 passou no harness (OCR reproduzido via PIL), mas no
   iPhone o mesmo recibo do Seven salvou ¥982 de novo — cada motor de
   desenho (PIL/Skia/Safari) entrega um texto OCR diferente, e no do
   aparelho a evidência do imposto não sobreviveu nas formas que a
   extração conhecia. Correções: a linha do imposto vale também na
   forma degradada "(内費科等 8% ¥78)" (sem o 消費税 legível); a base
   "（税率N%対象 ¥X)" entra como evidência impressa do total; o
   お預り picado é recomposto também das linhas "お?り" (rótulo com o
   kanji trocado); 小計（税抜）sem imposto lido NÃO é mais salvo como
   total (era o 982); tipo/categoria/loja toleram os espaços e kana
   enfiados do OCR do aparelho. E cada item passa a guardar o texto
   bruto do OCR (`ocrText`, seção "Texto lido (OCR)" no detalhe):
   a próxima falha já nasce diagnosticável pelo backup.
   Diagnóstico completo em test-ocr/DIAGNOSTICO-v1.7.md (fora do repo).
   v1.8: duas falhas reais novas, diagnosticadas do ocrText que o
   aparelho gravou. (1) FamilyMart: a linha do 合計 não sobreviveu e
   a base saiu "( 8※X 対 象 620)" — sem o prefixo 税率 que o
   scanTaishou exigia; agora a base "N%対象" vale também com o 税
   destruído (※) e até com o 対象 destruído, se a linha curta
   começar pela taxa e trouxer o valor com ¥/\; dígito solto perto
   do お預り destruído virava "pago ¥9" — entregue/troco < ¥100 sem
   rótulo+valor limpos na mesma linha não é mais salvo; e redes com
   nome latino no cabeçalho (FamilyMart, Seven-Eleven, Lawson,
   Ministop) canonizam pro katakana + categoria. (2) Saizeriya, foto
   nova e boa: as passadas A–D leram só o topo do recibo (273
   caracteres, nada da zona de totais) — o pipeline ganhou passadas
   de RESGATE: sem marcadores de totais no texto, ou sem total
   extraído, ele relê a zona de totais em outras escalas/PSM e a
   zona da data antes de salvar. E o rodapé das telas Início e
   Backup mostra "Meus Recibos JP · versão 1.8" (APP_VERSION —
   atualizar junto com o CACHE do sw.js a cada release).
   Diagnóstico completo em test-ocr/DIAGNOSTICO-v1.8.md (fora do repo).
   v1.9: UMA regra nova de extração — o fechamento pela zona de
   pagamento (paymentZoneClose). No reteste real da v1.8, a Saizeriya
   (foto 2) salvou data e troco certos, mas total e pago zerados: no
   ocrText do aparelho o ¥2.900 aparece 4+ vezes na zona de totais
   sem NUNCA colar num 合計/小計 legível, e o ¥3.000 aparece limpo
   uma vez, numa linha "頂り" (o 預 lido como 頂). Quando nenhum
   caminho acha o total mas o troco C saiu ancorado (> 0), a regra
   procura um pago T impresso em linha com cara de pago (redondo,
   > C) tal que V = T − C apareça ≥ 2 vezes na zona de totais
   (contando as leituras degradadas: "Z,900", ",900)") ou 1 vez
   limpo com ¥/\ — a aritmética só desempata entre valores
   PRESENTES no papel; T nunca nasce de soma. Sem isso, nada muda.
   Diagnóstico completo em test-ocr/DIAGNOSTICO-v1.9.md (fora do repo). */
'use strict';

/* ============ Constantes ============ */
var APP_VERSION = '1.13';
var LS_KEY = 'rec-items';
var CATEGORIES = ['Supermercado', 'Konbini', 'Restaurante', 'Transporte', 'Moradia',
  'Contas da casa', 'Saúde', 'Farmácia', 'Compras', 'Lazer', 'Lavanderia', 'Outros'];
var TYPES = { recibo: 'Recibo', conta: 'Conta', promocao: 'Promoção' };
var TYPE_ICONS = { recibo: '🧾', conta: '📄', promocao: '🏷️' };

var CONTA_KEYWORDS = ['請求', 'お支払い', 'お支払', '払込', '期限', '振込'];
var PROMO_KEYWORDS = ['OFF', 'セール', 'クーポン', '割引'];
var CATEGORY_HINTS = [
  [/セブン|ローソン|ファミリーマート|ミニストップ|コンビニ|FamilyMart|Seven[-\s]?Eleven|Lawson|Ministop/i, 'Konbini'],
  [/ドラッグ|薬局|マツモトキヨシ|ウエルシア|スギ薬局/, 'Farmácia'],
  [/病院|クリニック|歯科|眼科/, 'Saúde'],
  [/スーパー|イオン|業務スーパー|西友|ライフ|マルエツ|サンワ|コストコ|マイバスケット|オーケー/, 'Supermercado'],
  [/サイゼリヤ|ガスト|マクドナルド|モスバーガー|すき家|吉野家|松屋|日高屋|スシロー|くら寿司|はま寿司|かっぱ寿司|コメダ|スターバックス|ドトール|タリーズ|レストラン|食堂|ラーメン|居酒屋|カフェ|STARBUCKS/i, 'Restaurante'],
  [/バーガー|burger/i, 'Restaurante'],
  [/ダイソー|セリア|キャンドゥ|3COINS|ブックオフ|ハードオフ|ドン・キホーテ/, 'Compras'],
  [/電車|バス|タクシー|Suica|PASMO|チャージ/, 'Transporte'],
  [/コインランドリー|ランドリー|クリーニング|Lavanderia/i, 'Lavanderia']
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
  /* O OCR devolve "2026 年 10 月 02 日" — espaços entre TODOS os
     blocos, inclusive entre o ano e o 年 (v1.6). */
  var re2 = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  while ((m = re2.exec(text)) !== null) {
    var y2 = +m[1], mo2 = +m[2], d2 = +m[3];
    if (mo2 >= 1 && mo2 <= 12 && d2 >= 1 && d2 <= 31) out.push(toISODate(y2, mo2, d2));
  }
  // Reiwa: 令和N年 = 2018 + N
  var re3 = /令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  while ((m = re3.exec(text)) !== null) {
    out.push(toISODate(2018 + (+m[1]), +m[2], +m[3]));
  }
  // Passada tolerante (v1.5): o OCR troca dígitos por letras parecidas
  // (0→O/C, 2→Z) e a "/" do mês/dia por "7" — ex.: "2CZ26/11720" é
  // 2026/11/20. Só entra se a forma estrita não achou a mesma data.
  var tol = findTolerantDates(text);
  for (var i = 0; i < tol.length; i++) {
    if (out.indexOf(tol[i]) < 0) out.push(tol[i]);
  }
  return out;
}

/* Ano a partir de um token "sujo" do OCR: corrige O/C/G→0 e Z→2,
   desfaz um dígito duplicado ("20226"→"2026") e exige 2015–2035.
   (v1.8: G→0 — a passada de resgate leu "2G26/11720" na Saizeriya.) */
function yearFromOcrToken(tok) {
  var d = String(tok).replace(/[OoCcGg]/g, '0').replace(/[Zz]/g, '2');
  if (!/^\d{4,5}$/.test(d)) return null;
  if (d.length === 5) d = d.replace(/(\d)\1/, '$1');
  if (d.length !== 4) return null;
  var y = parseInt(d, 10);
  return (y >= 2015 && y <= 2035) ? y : null;
}

function findTolerantDates(text) {
  var out = [];
  var m;
  var reA = /([0-9OoCcGgZz]{4,5})\s*[\/.-]\s*(\d{1,2})\s*[\/.-]\s*(\d{1,2})/g;
  while ((m = reA.exec(text)) !== null) {
    var y = yearFromOcrToken(m[1]);
    if (y === null) continue;
    var mo = +m[2], da = +m[3];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) out.push(toISODate(y, mo, da));
  }
  // "/" entre mês e dia lida como "7": "2026/11720" = 2026/11/20
  var reB = /([0-9OoCcGgZz]{4,5})\s*[\/.-]\s*(\d{2})[7](\d{2})(?!\d)/g;
  while ((m = reB.exec(text)) !== null) {
    var y2 = yearFromOcrToken(m[1]);
    if (y2 === null) continue;
    var mo2 = +m[2], da2 = +m[3];
    if (mo2 >= 1 && mo2 <= 12 && da2 >= 1 && da2 <= 31) out.push(toISODate(y2, mo2, da2));
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

/* Converte um token numérico do OCR: "2,900" e "2.900" (ponto como
   separador de milhar, comum em recibo térmico) viram 2900; um token
   com ponto decimal ("22.46") fica com a parte inteira. */
function parseNumToken(tok) {
  tok = String(tok);
  if (/^\d{1,3}([.,]\d{3})+$/.test(tok)) {
    return parseInt(tok.replace(/[.,]/g, ''), 10);
  }
  var v = parseInt(tok.split('.')[0].replace(/,/g, ''), 10);
  return isNaN(v) ? null : v;
}

/* Todos os números de uma linha (sem ¥ nem vírgulas). */
function numbersInLine(line) {
  var out = [];
  var re = /[0-9][0-9,.]*[0-9]|[0-9]/g, m;
  while ((m = re.exec(String(line))) !== null) {
    var v = parseNumToken(m[0]);
    if (v !== null) out.push(v);
  }
  return out;
}

/* Versão tolerante, só para linhas de dinheiro: letras que o OCR troca
   por dígitos entram no token (O/U→0, I/l→1) — "fIUU" vira 100 e
   "2.90O" vira 2900. Tokens sem nenhum dígito de verdade e curtos
   ("No", "TEL") são ignorados. */
function numbersInLineFuzzy(line) {
  var out = [];
  var re = /[0-9OoUuIl][0-9OoUuIl,.]*[0-9OoUuIl]|[0-9OoUuIl]/g, m;
  var s = String(line);
  while ((m = re.exec(s)) !== null) {
    var tok = m[0];
    if (!/[0-9]/.test(tok) && tok.length < 3) continue;
    var mapped = tok.replace(/[OoUu]/g, '0').replace(/[Il]/g, '1');
    var v = parseNumToken(mapped);
    if (v !== null) out.push(v);
  }
  return out;
}

/* Tira as taxas percentuais ("8%", "10％") de uma linha antes de
   procurar dinheiro: o número da taxa NÃO é valor — era ele que
   virava o "total" quando o OCR perdia a coluna de valores
   ("小計(税抜8%)" devolvia 8). */
function stripRates(s) {
  return String(s).replace(/\d{1,2}\s*[%％]/g, ' ');
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
      var nums = numbersInLineFuzzy(stripRates(stripped.slice(pos + keywords[k].length)));
      if (!nums.length) nums = numbersInLineFuzzy(stripRates(lines[i]));
      if (!nums.length && i + 1 < lines.length) nums = numbersInLineFuzzy(stripRates(lines[i + 1]));
      if (nums.length) return Math.max.apply(null, nums);
    }
  }
  return null;
}

var TOTAL_KEYWORDS = ['合計金額', '税込合計', 'お買上計', 'お買い上げ',
  '請求金額', 'お支払金額', 'お支払い金額', '合計'];
var TENDERED_KEYWORDS = ['お預かり金', 'お預かり', 'お預り', '預り金', '預り'];
var CHANGE_KEYWORDS = ['お釣り', 'おつり', '釣銭', '釣り銭'];

/* Linhas "お?り": o recibo imprime お預り (valor entregue) e depois
   お釣り (troco), mas o OCR troca o kanji do meio (お聞り, お約り…).
   Devolve as linhas nesse formato, em ordem, com os valores lidos. */
function ojiriLines(lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i].replace(/\s/g, '');
    if (/^お.り/.test(s)) out.push({ idx: i, nums: numbersInLineFuzzy(lines[i]) });
  }
  return out;
}

/* Valores candidatos de uma linha de troco: além do número lido, um
   token como "1IUU" pode ser o "¥" colado no valor (¥100 lido como
   1100) — gera também a variante sem o primeiro dígito. */
function changeCandidates(line) {
  var out = numbersInLineFuzzy(line);
  var extra = [];
  for (var i = 0; i < out.length; i++) {
    if (out[i] >= 1000 && out[i] % 1000 !== 0) extra.push(out[i] % 1000);
  }
  for (var j = 0; j < extra.length; j++) {
    if (extra[j] > 0 && out.indexOf(extra[j]) < 0) out.push(extra[j]);
  }
  return out;
}

/* Observações de 小計 no texto inteiro: as passadas repetem a mesma
   linha com ruídos diferentes — agrupa por valor (o mais frequente
   vence) e anota o qualificador: 税抜 em QUALQUER leitura daquele
   valor marca o subtotal como "sem imposto". */
function scanSubtotals(lines) {
  var byVal = {}, order = [];
  for (var i = 0; i < lines.length; i++) {
    var st = lines[i].replace(/\s/g, '');
    var pos = st.indexOf('小計');
    if (pos < 0) continue;
    var nums = numbersInLineFuzzy(stripRates(st.slice(pos + 2)));
    if (!nums.length) nums = numbersInLineFuzzy(stripRates(lines[i]));
    if (!nums.length && i + 1 < lines.length) nums = numbersInLineFuzzy(stripRates(lines[i + 1]));
    if (!nums.length) continue;
    var v = Math.max.apply(null, nums);
    if (!byVal[v]) { byVal[v] = { value: v, taxExcluded: false, count: 0 }; order.push(v); }
    byVal[v].count++;
    if (st.indexOf('税抜') >= 0) byVal[v].taxExcluded = true;
  }
  var best = null;
  for (var j = 0; j < order.length; j++) {
    if (!best || byVal[order[j]].count > best.count) best = byVal[order[j]];
  }
  return best;
}

/* Observações de 消費税: separa a linha "solta" (a que é SOMADA ao
   小計（税抜）pra formar o total) da linha "（内…）" (que só informa
   quanto de imposto já está incluso num total 税込）.
   v1.7: a linha interna vale também na forma degradada que o OCR do
   aparelho entrega — "(内費科等 8% ¥78)", sem o 消費税 legível (o 消
   some e o 税 vira 科）: 内…等 com % e valor é a linha do imposto. */
function scanTaxes(lines) {
  var loose = [], inner = [];
  for (var i = 0; i < lines.length; i++) {
    var st = lines[i].replace(/\s/g, '');
    var pos = st.indexOf('消費税');
    var degradedInner = pos < 0 && /^\(?内.*等/.test(st) && st.indexOf('%') >= 0;
    if (pos < 0 && !degradedInner) continue;
    /* Fragmento de linha (ex.: "(内消費税等 8 え" — sobrou o dígito
       da TAXA, sem % nem ¥) não é linha de dinheiro: sem nenhum
       símbolo de valor, o número é ruído, não o imposto. */
    if (st.indexOf('%') < 0 && st.indexOf('¥') < 0 && st.indexOf('￥') < 0 &&
        st.indexOf('\\') < 0 && st.indexOf('円') < 0) continue;
    var nums = numbersInLineFuzzy(stripRates(pos >= 0 ? st.slice(pos + 3) : st));
    if (!nums.length) nums = numbersInLineFuzzy(stripRates(lines[i]));
    /* v1.7: NADA de procurar o valor na linha seguinte — nas
       leituras degradadas, a linha seguinte à do imposto é a do
       合計 destruída ou a do お預り, e os fragmentos dela ("1. 06")
       viravam um "imposto" de ¥1/¥6 que fechava um total errado
       (982 + 1 = 983). Linha de imposto de verdade traz o valor
       nela mesma, em todos os recibos observados. */
    if (!nums.length) continue;
    var v = Math.max.apply(null, nums);
    if (degradedInner || st.indexOf('内消費税') >= 0) inner.push(v); else loose.push(v);
  }
  return { loose: loose, inner: inner };
}

/* Linhas "（税率N%対象 ¥X)": o valor é a base COM imposto daquela
   taxa — em recibo de taxa única, é o próprio 合計 impresso; com
   duas taxas (8%/10%), a soma das bases é o 合計. É evidência
   impressa e rotulada do total, e no aparelho foi a linha que
   sobreviveu quando a do 合計 não foi lida. Devolve os valores
   distintos, em ordem de aparição.
   v1.8: o aparelho leu a base do FamilyMart como "( 8※X 対 象 620)"
   — sem o prefixo 税率 (o "%" virou ※ e sobrou um X): a linha vale
   se trouxer 税率, um "%", OU a taxa (dígito + %/％/※) antes do
   対象. E quando até o 対象 é destruído, a linha curta que COMEÇA
   pela taxa e traz o valor com ¥/\ ("8 % 記 家 \620)") é a mesma
   linha degradada — vale como candidata, com o valor marcado. */
function scanTaishou(lines) {
  var byVal = {}, order = [];
  function push(v) {
    if (v !== null && v >= 100 && !byVal[v]) { byVal[v] = true; order.push(v); }
  }
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i].replace(/\s/g, '');
    if (raw.indexOf('対象') < 0) continue;
    var pos = raw.indexOf('対象');
    var pre = raw.slice(0, pos);
    if (raw.indexOf('税率') < 0 && raw.indexOf('%') < 0 &&
        !/\d\s*[%％※]/.test(pre)) continue;
    var nums = numbersInLineFuzzy(stripRates(raw.slice(pos + 2)));
    if (!nums.length) nums = numbersInLineFuzzy(stripRates(raw));
    for (var j = 0; j < nums.length; j++) push(nums[j]);
  }
  for (var k = 0; k < lines.length; k++) {
    var st = lines[k].replace(/\s/g, '');
    if (st.indexOf('対象') >= 0) continue;
    if (!/^\(?\d{1,2}\s*[%％※]/.test(st)) continue;
    if (st.length > 16) continue;
    if (/小計|合計|消費税|値引|割引/.test(st)) continue;
    var vm = /[¥\\]\s*([0-9][0-9,.]*)/.exec(st);
    if (!vm) continue;
    push(parseNumToken(vm[1]));
  }
  return order;
}

/* v1.13: o valor aparece impresso numa linha de "計" do papel
   (合計/総合計, mesmo degradada — "総台計"), fora das linhas de
   対象 (que carregam a base, não o total)? A leitura G→6 é local
   a esta checagem: o "G18" da linha do 総合計 é o 618 com a
   primeira casa trocada pelo OCR. */
function totalPrintedOnKeLine(lines, v) {
  for (var i = 0; i < lines.length; i++) {
    var st = lines[i].replace(/\s/g, '');
    if (st.indexOf('計') < 0 || st.indexOf('対象') >= 0) continue;
    var mapped = st.replace(/[Gg]/g, '6');
    if (numbersInLineFuzzy(mapped).indexOf(v) >= 0) return true;
  }
  return false;
}

/* Todos os números "de dinheiro" do texto (sem taxas), como conjunto
   — usado pra confirmar candidatos: uma soma 小計＋消費税 só é
   aceita de olhos fechados quando o próprio papel traz esse valor
   impresso em outra linha （対象, お預り…). */
function collectAllNumbers(lines) {
  var set = {};
  for (var i = 0; i < lines.length; i++) {
    numbersInLineFuzzy(stripRates(lines[i])).forEach(function (v) { set[v] = true; });
  }
  return set;
}

/* Recompõe um valor "picado" do rodapé térmico: os grupos de dígitos
   depois do rótulo, concatenados em ordem ("1. 06 ら 0" → 1060).
   Só com 2+ grupos e 3–7 dígitos no total — fora disso é chute. */
function digitConcatValue(s) {
  var mapped = String(s).replace(/[OoUu]/g, '0').replace(/[Il]/g, '1');
  var runs = mapped.match(/\d+/g);
  if (!runs || runs.length < 2) return null;
  var joined = runs.join('');
  if (joined.length < 3 || joined.length > 7) return null;
  var v = parseInt(joined, 10);
  return v > 0 ? v : null;
}

/* Candidatos picados das linhas de entregue (預） e troco （釣）:
   o valor depois do kanji do rótulo, com os dígitos concatenados. */
function labelConcatCandidates(lines, tOut, cOut) {
  for (var i = 0; i < lines.length; i++) {
    var st = lines[i].replace(/\s/g, '');
    var p = st.lastIndexOf('預');
    if (p >= 0) {
      var vt = digitConcatValue(st.slice(p + 1).replace(/^り/, ''));
      if (vt !== null && tOut.indexOf(vt) < 0) tOut.push(vt);
    }
    var q = st.lastIndexOf('釣');
    if (q >= 0) {
      var vc = digitConcatValue(st.slice(q + 1).replace(/^り/, ''));
      if (vc !== null && cOut.indexOf(vc) < 0) cOut.push(vc);
    }
  }
}

/* Evidência forte de um valor pequeno (< ¥100) de entregue/troco:
   a linha tem o rótulo e, depois dele, SÓ o valor (com ¥/円 no
   máximo) — "お釣り ¥45" limpo. Se depois do rótulo tem lixo junto
   ("お預り ーー り 9. ログ 2"), o dígito é fragmento, não dinheiro:
   foi assim que o aparelho salvou "pago ¥9" no FamilyMart (v1.8). */
function strongLabelValue(lines, keywords, v) {
  for (var i = 0; i < lines.length; i++) {
    var st = lines[i].replace(/\s/g, '');
    for (var k = 0; k < keywords.length; k++) {
      var pos = st.indexOf(keywords[k]);
      if (pos < 0) continue;
      var rest = st.slice(pos + keywords[k].length).replace(/[¥￥\\円]/g, '');
      if (/^\d+$/.test(rest) && parseInt(rest, 10) === v) return true;
    }
  }
  return false;
}

/* v1.9: conta as ocorrências de um valor V no texto, incluindo as
   leituras degradadas equivalentes: o token fuzzy com Z→2 ("Z,900"
   e "%Z.900" são o 2900 — o Z já é corrigido pra 2 nas datas) e o
   fragmento de cauda ",900"/".900" (o dígito da frente destruído:
   a cauda é só CONSISTENTE com a do valor procurado — dígito
   nenhum é inventado, porque o V inteiro vem da aritmética de quem
   chama). cleanMarked conta as ocorrências como token completo
   com ¥ ou \ colado antes: a forma "limpa e marcada" do impresso. */
function countValueOccurrences(lines, v) {
  var count = 0, cleanMarked = 0;
  var tail = v >= 1000 ? ('00' + (v % 1000)).slice(-3) : null;
  for (var i = 0; i < lines.length; i++) {
    var s = String(lines[i]);
    var re = /[0-9ZzOoUuIl][0-9ZzOoUuIl,.]*/g, m;
    while ((m = re.exec(s)) !== null) {
      var tok = m[0];
      if (!/[0-9]/.test(tok) && tok.length < 3) continue;
      var mapped = tok.replace(/[OoUu]/g, '0').replace(/[Il]/g, '1')
        .replace(/[Zz]/g, '2');
      if (parseNumToken(mapped) !== v) continue;
      count++;
      if (/[¥\\]$/.test(s.slice(0, m.index).replace(/\s/g, ''))) cleanMarked++;
    }
    if (tail) {
      var reT = /(^|[^0-9ZzOoUuIl,.])[.,](\d{3})(?!\d)/g, m2;
      while ((m2 = reT.exec(s)) !== null) {
        if (m2[2] === tail) count++;
      }
    }
  }
  return { count: count, cleanMarked: cleanMarked };
}

/* v1.9: valores em linhas com "cara de pago" — o rótulo お預り sai
   destruído de várias formas (お移り, 上頂り…), mas a linha guarda
   um kanji da família 預/頂/移/交 seguido de り, ou a forma お?り
   das linhas de entregue/troco. É o ÚNICO lugar onde um candidato
   a "pago" pode nascer pro fechamento da zona de pagamento: fora
   daí, número redondo solto no texto não é evidência de pagamento. */
function paymentLineValues(lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var st = lines[i].replace(/\s/g, '');
    if (!(/[預頂移交]り/.test(st) || /^お.り/.test(st) ||
          st.indexOf('預') >= 0)) continue;
    numbersInLineFuzzy(lines[i]).forEach(function (v) {
      if (out.indexOf(v) < 0) out.push(v);
    });
  }
  return out;
}

/* v1.9: fechamento pela zona de pagamento. Só é chamado quando
   NENHUM caminho achou o total, mas o troco C saiu ancorado (> 0).
   A conta fecha com três evidências impressas ao mesmo tempo:
   (1) um candidato a pago T em linha com cara de pago, redondo
   (múltiplo de ¥100), maior que o troco e — se um entregue já foi
   lido por outro caminho — igual a ele (a regra não contradiz
   leitura ancorada); (2) V = T − C ≥ ¥100 e diferente de qualquer
   imposto lido no texto; (3) V aparece na zona de totais ≥ 2 vezes
   (contando as leituras degradadas equivalentes) ou 1 vez como
   valor limpo marcado com ¥/\. A aritmética só desempata entre
   candidatos PRESENTES no papel — T nunca nasce de soma. Se mais
   de um V distinto fechar, é ambíguo: não chuta (devolve null). */
function paymentZoneClose(lines, change, knownTendered) {
  var taxes = scanTaxes(lines);
  var taxSet = {};
  taxes.loose.concat(taxes.inner).forEach(function (v) { taxSet[v] = true; });
  var cands = paymentLineValues(lines);
  var found = {};
  for (var i = 0; i < cands.length; i++) {
    var t = cands[i];
    if (t <= change || t % 100 !== 0 || t > 100000) continue;
    if (knownTendered !== null && t !== knownTendered) continue;
    var v = t - change;
    if (v < 100 || taxSet[v]) continue;
    var occ = countValueOccurrences(lines, v);
    if (occ.count >= 2 || occ.cleanMarked >= 1) found[v] = t;
  }
  var vs = Object.keys(found);
  if (vs.length !== 1) return null;
  return { amount: +vs[0], tendered: found[vs[0]] };
}

/* v1.11: total por repetição + imposto consistente. Recibo de
   lanchonete quase todo em inglês (caso real do aparelho,
   2026-11-22): TODAS as linhas rotuladas morreram — sem 合計，
   sem 対象， o "¥" virou "\" e o total só sobreviveu repetido nas
   passadas ("5,220" ×4, mais a forma "5.220") ao lado do imposto
   impresso (¥474). Um valor V vira o total quando fecha TRÊS
   evidências do próprio papel ao mesmo tempo: (1) V aparece
   ≥ 3 vezes no texto, contando as leituras degradadas
   equivalentes (countValueOccurrences); (2) o imposto de V —
   floor(V × taxa/(100+taxa)), taxa 10 ou 8 — está impresso numa
   linha com 税 (a conta é a do recibo 税込： ¥5.220 → ¥474);
   (3) V é o ÚNICO valor que fecha (1) e (2) — dois candidatos =
   ambíguo, não chuta. A aritmética não cria valor nenhum: V e o
   imposto estão impressos; ela só confere um contra o outro.
   Preço de item repetido (o hambúrguer de ¥1.980 sai 3×) não
   fecha porque o imposto dele (¥180/¥146) não está no papel. */
function repeatedTaxTotal(lines) {
  var taxSet = {};
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('税') < 0) continue;
    numbersInLineFuzzy(stripRates(lines[i])).forEach(function (v) {
      if (v >= 20) taxSet[v] = true;
    });
  }
  if (!Object.keys(taxSet).length) return null;
  var all = collectAllNumbers(lines);
  var found = [];
  for (var k in all) {
    var v = +k;
    if (v < 300 || taxSet[v]) continue;
    var okTax = taxSet[Math.floor(v * 10 / 110)] ||
      taxSet[Math.floor(v * 8 / 108)];
    if (!okTax) continue;
    if (countValueOccurrences(lines, v).count >= 3) found.push(v);
  }
  return found.length === 1 ? found[0] : null;
}

/* Extrai total, valor entregue (お預かり) e troco (お釣り) do texto.
   tendered/change ficam null quando não aparecem no papel.
   v1.5: total também via 小計 e, em último caso, via um 計 solto;
   tendered/change combinam palavra-chave, linhas お?り e a conta
   tendered − total = troco quando as evidências concordam.
   v1.6: fidelidade ao recibo — o 合計 impresso manda; 小計（税抜）
   nunca é o total (com 消費税 lido, o total é a soma dos dois
   componentes impressos); 小計 税込/sem qualificador já é o total.
   v1.7: sem o imposto lido, a base "（税率N%対象 ¥X)" — impressa e
   rotulada — fecha o total do recibo 税抜 (conferida contra o
   subtotal: tem que excedê-lo por no máximo o imposto de ~10%);
   e 小計（税抜）sozinho NÃO vira mais o total: foi assim que o
   aparelho salvou ¥982 sem imposto na v1.6. Sem evidência do total,
   amount fica null (salva 0, editável) — número errado é pior. */
function extractMoney(rawText) {
  var text = normalizeOcr(rawText);
  var lines = text.split(/\n/);
  var amount = moneyByKeywords(lines, TOTAL_KEYWORDS);
  var sub = null;
  if (amount === null) {
    sub = scanSubtotals(lines);
    if (sub && !sub.taxExcluded) {
      amount = sub.value;
    } else if (sub && sub.taxExcluded) {
      /* 小計（税抜）+ 消費税： o total é a soma dos dois valores
         impressos. Entre os candidatos de imposto, prefere o que
         faz a soma aparecer impressa em outra linha do papel. */
      var taxes = scanTaxes(lines);
      var taxCands = [];
      taxes.loose.concat(taxes.inner).forEach(function (v) {
        if (taxCands.indexOf(v) < 0) taxCands.push(v);
      });
      if (taxCands.length) {
        var allNums = collectAllNumbers(lines);
        var chosenTax = null;
        for (var ti = 0; ti < taxCands.length; ti++) {
          if (allNums[sub.value + taxCands[ti]]) { chosenTax = taxCands[ti]; break; }
        }
        if (chosenTax === null) chosenTax = taxCands[0];
        amount = sub.value + chosenTax;
      } else {
        /* Imposto não lido: a base 対象 (com imposto) fecha o
           total se exceder o subtotal por no máximo ~10% + 1. */
        var tsh0 = scanTaishou(lines);
        if (tsh0.length) {
          var tsum0 = tsh0.reduce(function (s2, v2) { return s2 + v2; }, 0);
          if (tsum0 > sub.value && tsum0 <= Math.round(sub.value * 1.11) + 1) {
            amount = tsum0;
          }
        }
      }
    }
  }
  /* v1.13: guarda do total impossível — um candidato a total MENOR
     que a maior base 対象 impressa não pode ser o total: a base já
     é parte do total (com imposto, é parcela dele; sem imposto, é
     menor que ele). Caso real do aparelho (Starbucks, 2026-11-22):
     a linha do 合計 saiu destruída ("合計 ... ら 7 い") e o
     fragmento "7" virou o total, com a base "(8%対象 ¥573)"
     legível no mesmo papel. Candidato impossível é descartado e
     a cadeia de reservas abaixo roda. */
  if (amount !== null) {
    var tshGuard = scanTaishou(lines);
    if (tshGuard.length && amount < Math.max.apply(null, tshGuard)) {
      amount = null;
    }
  }
  if (amount === null) {
    /* Sem subtotal aproveitável: a soma das bases 対象 é o total
       (taxa única: a própria base; duas taxas: a soma delas). */
    var tsh = scanTaishou(lines);
    if (tsh.length) {
      var tsum = tsh.reduce(function (s3, v3) { return s3 + v3; }, 0);
      if (tsum >= 100 && (!sub || !sub.taxExcluded || tsum > sub.value)) {
        amount = tsum;
        /* v1.13: arbitragem da base SEM imposto — cadeias como a
           Starbucks imprimem a base 対象 sem o imposto ("(8%対象
           ¥573 消費税 ¥45)") e o total é base + imposto. Com UMA
           base só, se o fechamento base+imposto (a 8% ou a 10%)
           aparece impresso numa linha de 計 do papel, é ELE o
           total, não a base. Sem essa confirmação impressa, vale
           a soma das bases (leitura com imposto) — a aritmética
           não cria valor, só desempata entre valores impressos. */
        if (tsh.length === 1) {
          var baseV = tsh[0];
          var closures13 = [baseV + Math.floor(baseV * 8 / 100),
                            baseV + Math.floor(baseV * 10 / 100)];
          var confirmed13 = [];
          for (var ci = 0; ci < closures13.length; ci++) {
            if (closures13[ci] === tsum) continue;
            if (totalPrintedOnKeLine(lines, closures13[ci])) {
              confirmed13.push(closures13[ci]);
            }
          }
          if (confirmed13.length === 1) amount = confirmed13[0];
        }
      }
    }
  }
  if (amount === null) {
    for (var i = 0; i < lines.length; i++) {
      var st = lines[i].replace(/\s/g, '');
      if (st.indexOf('計') < 0 || st.indexOf('対象計') >= 0) continue;
      var ns = numbersInLineFuzzy(lines[i]).filter(function (v) {
        return v >= 100 && v < 50000;
      });
      if (ns.length) { amount = Math.max.apply(null, ns); break; }
    }
  }
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

  var tenderedKw = moneyByKeywords(lines, TENDERED_KEYWORDS);
  var changeKw = moneyByKeywords(lines, CHANGE_KEYWORDS);
  /* v1.8: guarda anti-lixo — entregue/troco < ¥100 vindo de linha
     com o rótulo destruído é fragmento (o "9" do FamilyMart), não
     dinheiro. Só sobrevive com rótulo+valor limpos na mesma linha. */
  if (tenderedKw !== null && tenderedKw > 0 && tenderedKw < 100 &&
      !strongLabelValue(lines, TENDERED_KEYWORDS, tenderedKw)) tenderedKw = null;
  if (changeKw !== null && changeKw > 0 && changeKw < 100 &&
      !strongLabelValue(lines, CHANGE_KEYWORDS, changeKw)) changeKw = null;
  var ojiri = ojiriLines(lines);
  var concatT = [], concatC = [];
  labelConcatCandidates(lines, concatT, concatC);
  /* v1.7: o valor picado também é recomposto das linhas "お?り"
     quando o kanji do rótulo foi trocado (お上り por お預り — o
     labelConcatCandidates só enxerga 預/釣 legíveis). O candidato
     só é usado como entregue se cobrir o total, então uma linha de
     troco lida no lugar não contamina. */
  var ojiriConcat = [];
  ojiri.forEach(function (o) {
    var st = lines[o.idx].replace(/\s/g, '');
    var v = digitConcatValue(st.slice(3));
    if (v !== null && ojiriConcat.indexOf(v) < 0) ojiriConcat.push(v);
  });

  /* Valor entregue e troco: as linhas お?り das várias passadas se
     misturam (cada passada traz o seu par お預り/お釣り). Com o total
     conhecido, separa pelo valor: candidato a entregue cobre o total;
     candidato a troco é menor que o total. Sem total, vale a ordem do
     papel: a primeira linha お?り é a do entregue. */
  var tendered = null;
  var cCands = [];
  var hasChangeLine = changeKw !== null;
  if (amount !== null) {
    var tPool = [];
    if (tenderedKw !== null && tenderedKw >= amount) tPool.push(tenderedKw);
    ojiri.forEach(function (o) {
      o.nums.forEach(function (v) {
        if (v >= amount) { if (tPool.indexOf(v) < 0) tPool.push(v); }
      });
      changeCandidates(lines[o.idx]).forEach(function (v) {
        if (v > 0 && v < amount && cCands.indexOf(v) < 0) cCands.push(v);
      });
      if (o.nums.length) hasChangeLine = true;
    });
    if (tPool.length) tendered = Math.min.apply(null, tPool);
    concatT.forEach(function (v) {
      if (v >= amount && (tendered === null || v < tendered)) tendered = v;
    });
    ojiriConcat.forEach(function (v) {
      if (v >= amount && (tendered === null || v < tendered)) tendered = v;
    });
    /* v1.8: par redondo — com os rótulos お預り/お釣り destruídos
       (a Saizeriya refeita só leu "{2 3,000 計" na zona de
       pagamento), o entregue pode ser um valor REDONDO (múltiplo de
       ¥100) maior que o total cujo troco (ele − total) TAMBÉM está
       impresso no papel: os dois valores impressos fecham a conta
       um do outro, como a soma 小計+消費税 da v1.6. Sem o par, não
       entra — número solto maior que o total pode ser telefone,
       registro, qualquer coisa. */
    if (tendered === null) {
      var allNumsR = collectAllNumbers(lines);
      var roundCands = [];
      for (var rk in allNumsR) {
        var rv = +rk;
        if (rv > amount && rv <= amount + 10000 && rv % 100 === 0 &&
            allNumsR[rv - amount]) roundCands.push(rv);
      }
      if (roundCands.length) {
        tendered = Math.min.apply(null, roundCands);
        var rDiff = tendered - amount;
        if (rDiff > 0 && cCands.indexOf(rDiff) < 0) cCands.push(rDiff);
        hasChangeLine = true;
      }
    }
    concatC.forEach(function (v) {
      if (v > 0 && v < amount && cCands.indexOf(v) < 0) cCands.push(v);
    });
    if (concatC.length) hasChangeLine = true;
    if (changeKw !== null && changeKw < amount && cCands.indexOf(changeKw) < 0) {
      cCands.push(changeKw);
    }
  } else {
    if (tenderedKw !== null) tendered = tenderedKw;
    else if (ojiri.length && ojiri[0].nums.length) {
      /* Sem total conhecido, só valores plausíveis de entregue
         (≥ ¥100): dígito solto de linha "お?り" não é dinheiro. */
      var bigNums = ojiri[0].nums.filter(function (v) { return v >= 100; });
      if (bigNums.length) tendered = Math.max.apply(null, bigNums);
    }
    if (changeKw !== null) cCands.push(changeKw);
    for (var o = 1; o < ojiri.length; o++) {
      hasChangeLine = true;
      changeCandidates(lines[ojiri[o].idx]).forEach(function (v) {
        if (v > 0 && cCands.indexOf(v) < 0) cCands.push(v);
      });
    }
  }

  /* Troco: pagou EXATO (entregue = total) → troco é 0 por definição,
     não é chute. Se algum candidato bate com tendered − total, ele
     vence; senão, um candidato único é aceito como lido; senão, a
     aritmética vale quando há linha de troco e o resultado é
     plausível (troco menor que o total). */
  var expected = (tendered !== null && amount !== null && tendered >= amount)
    ? tendered - amount : null;
  /* v1.8: candidato de troco < ¥100 só vale se for o troco exato da
     conta (expected) ou tiver rótulo+valor limpos — fragmento solto
     de linha お?り (o "10" de um ¥10.020 destruído) não é troco. */
  cCands = cCands.filter(function (v) {
    return v >= 100 || v === expected ||
      strongLabelValue(lines, CHANGE_KEYWORDS, v);
  });
  var change = null;
  if (expected !== null && expected === 0) change = 0;
  else if (expected !== null && cCands.indexOf(expected) >= 0) change = expected;
  else if (cCands.length === 1) change = cCands[0];
  else if (expected !== null && hasChangeLine && expected < amount && expected <= 5000) change = expected;
  else if (cCands.length) change = cCands[0];

  /* v1.9: sem total por nenhum caminho, mas com o troco ancorado,
     a zona de pagamento pode fechar a conta (paymentZoneClose) —
     foi o caso da Saizeriya no aparelho: 合計 e お預り ilegíveis
     como rótulo, mas o troco ¥100 ancorado na linha "お移り", o
     pago ¥3.000 impresso na linha "頂り" e o ¥2.900 repetido na
     zona de totais (3.000 − 100 = 2.900, os três no papel). */
  if (amount === null && change !== null && change > 0) {
    var pz = paymentZoneClose(lines, change, tendered);
    if (pz) { amount = pz.amount; tendered = pz.tendered; }
  }

  /* v1.11: último recurso — sem total por nenhum caminho rotulado,
     o total pode fechar por repetição + imposto consistente
     (repeatedTaxTotal). Pagamento foi por cartão no caso real,
     então entregue/troco continuam null: nada é inventado. */
  if (amount === null) {
    var rt = repeatedTaxTotal(lines);
    if (rt !== null) amount = rt;
  }

  return { amount: amount, tendered: tendered, change: change };
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
  if (t.indexOf('%') >= 0 || t.indexOf('％') >= 0) {
    /* Recibo de restaurante/supermercado traz "10%対象計" — o "%"
       sozinho não faz dele promoção; só vira promoção se o papel não
       tiver cara de recibo. Os marcadores são testados SEM espaços:
       o OCR do aparelho devolve "小 計" e a v1.6 marcava promoção.
       v1.8: 消費税/税率/登録番号 também são cara de recibo — nas
       passadas de resgate da Saizeriya só o rodapé "軽減税率対象品目"
       sobreviveu, e o texto virava "promocao" sem eles. */
    if (!/合計|小計|領収|お預|お釣|釣銭|消費税|税率|登録番号/.test(t.replace(/\s/g, ''))) return 'promocao';
  }
  return 'recibo';
}

function guessCategory(text) {
  /* O OCR enfia espaços e até dígitos no meio dos nomes ("サイ ゼ リ
     ヤ", "サイ1ゼリヤ") — testa o texto cru, sem espaços, sem
     símbolos e, por fim, só kana/kanji. A prioridade é da DICA (a
     identidade da rede — セブン, サイゼリヤ…) sobre a variante: uma
     palavra genérica ("カフェ") lida no texto cru cheio de ruído não
     pode vencer o nome da rede que só aparece numa variante limpa
     (era o que fazia o Seven virar "Restaurante" no OCR do aparelho). */
  var raw = String(text || '');
  var variants = [raw, raw.replace(/\s/g, ''),
    raw.replace(/[^ぁ-んァ-ヶー一-龯A-Za-z0-9]/g, ''),
    raw.replace(/[^ぁ-んァ-ヶー一-龯]/g, '')];
  for (var i = 0; i < CATEGORY_HINTS.length; i++) {
    for (var v = 0; v < variants.length; v++) {
      if (CATEGORY_HINTS[i][0].test(variants[v])) return CATEGORY_HINTS[i][1];
    }
  }
  return 'Outros';
}

/* Procura o nome de uma rede no texto, tolerante ao ruído do OCR:
   compara o texto sem espaços, a versão sem símbolos e a versão só
   kana/kanji (que apaga até dígito enfiado no meio do nome). */
function chainHit(text, needle) {
  var n1 = String(needle).replace(/\s/g, '');
  if (String(text).replace(/\s/g, '').indexOf(n1) >= 0) return true;
  /* Nome latino (v1.8): o cabeçalho pode trazer "FamilyMart" em
     letras latinas, com a capitalização que o OCR enxergou —
     compara sem caixa nos dois lados. */
  if (/[A-Za-z]/.test(n1)) {
    if (String(text).replace(/\s/g, '').toLowerCase()
        .indexOf(n1.toLowerCase()) >= 0) return true;
  }
  var n2 = n1.replace(/[^ぁ-んァ-ヶー一-龯A-Za-z0-9]/g, '');
  var clean = String(text).replace(/[^ぁ-んァ-ヶー一-龯A-Za-z0-9]/g, '');
  if (n2.length >= 2 && clean.indexOf(n2) >= 0) return true;
  var nK = n1.replace(/[^ぁ-んァ-ヶー一-龯]/g, '');
  var cleanK = String(text).replace(/[^ぁ-んァ-ヶー一-龯]/g, '');
  if (nK.length >= 2 && cleanK.indexOf(nK) >= 0) return true;
  /* Passada difusa (v1.6): o OCR troca kana "vizinhos" (ブ↔フ↔プ,
     レ↔ル) e às vezes engole um kana do nome ("セブンイブン" por
     セブンイレブン). Normaliza os dois lados pro mesmo "esqueleto"
     e aceita também o nome com um kana a menos. Só pra nomes com
     5+ kana no esqueleto — curto demais viraria falso positivo. */
  var skN = kanaSkeleton(n1);
  if (skN.length >= 5) {
    var skT = kanaSkeleton(text);
    if (skT.indexOf(skN) >= 0) return true;
    for (var d = 0; d < skN.length; d++) {
      var cut = skN.slice(0, d) + skN.slice(d + 1);
      if (cut.length >= 4 && skT.indexOf(cut) >= 0) return true;
    }
    /* E o caminho inverso (v1.7): o OCR também ENFIA um kana no
       nome — no aparelho, セブンイレブン saiu "セブンイレルブン"
       (um ル a mais) e a loja não canonizava. Procura o esqueleto
       do nome em janelas do texto com um caractere a mais, apagando
       uma posição por vez. */
    for (var w = 0; w + skN.length + 1 <= skT.length; w++) {
      var win = skT.slice(w, w + skN.length + 1);
      for (var del = 0; del < win.length; del++) {
        if (win.slice(0, del) + win.slice(del + 1) === skN) return true;
      }
    }
  }
  return false;
}

/* "Esqueleto" kana de um texto: só kana/kanji, sem o "ー", com os
   pares que o OCR confunde dobrados pro mesmo sinal (ハ行 com e sem
   dakuten vira ハ行; ル vira レ). Aplicado dos dois lados da
   comparação, então o nome certo continua casando consigo mesmo. */
function kanaSkeleton(s) {
  var t = String(s).replace(/[^ぁ-んァ-ヶー一-龯]/g, '');
  t = t.replace(/[バビブベボパピプペポ]/g, function (c) {
    return 'ハヒフヘホ'[ 'バビブベボパピプペポ'.indexOf(c) % 5 ];
  });
  t = t.replace(/ル/g, 'レ');
  t = t.replace(/ー/g, '');
  return t;
}

/* Redes conhecidas: [trecho procurado no texto sem espaços, nome exibido].
   O recibo costuma trazer o nome fantasia em destaque e a razão social
   (株式会社…) miúda no rodapé — por isso a rede é procurada no texto
   inteiro antes de olhar linha a linha. */
var CHAIN_NAMES = [
  ['セブン-イレブン', 'セブン-イレブン'], ['セブンイレブン', 'セブン-イレブン'],
  ['Seven-Eleven', 'セブン-イレブン'], ['SevenEleven', 'セブン-イレブン'],
  ['ファミリーマート', 'ファミリーマート'], ['ファミマ', 'ファミリーマート'],
  ['FamilyMart', 'ファミリーマート'],
  ['ローソン', 'ローソン'], ['Lawson', 'ローソン'],
  ['ミニストップ', 'ミニストップ'], ['Ministop', 'ミニストップ'],
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
  if (/領収書|領収証|レシート|いらっしゃいませ|ありがとう/.test(s)) return true;
  /* v1.12: linha com "#" (店舗 # 0005, レシート # 410178) é linha
     de número/terminal, e linha com ¥/\ é linha de dinheiro ou
     item ("SE1 CorOona EXtra \OoOU") — nenhuma das duas é o nome
     da loja. No reteste do recibo da lanchonete (2026-11-22) eram
     essas as linhas que sobravam no topo depois dos descartes da
     v1.11, e uma delas virava o "nome". */
  if (/#/.test(s)) return true;
  if (/[¥￥\\]/.test(s)) return true;
  if (/TEL|電話|〒|郵便|登録番号/.test(s)) return true;
  if (/合計|小計/.test(s)) return true;
  if (/^[0-9¥%.,:：\/\-\s]+$/.test(s)) return true;
  var flat = s.replace(/\s/g, '');
  if (/^\d{4}[\/.-]?\d{1,2}[\/.-]?\d{1,2}/.test(flat)) return true;
  if (/\d{4}年\s*\d{1,2}月\s*\d{1,2}日/.test(s)) return true;
  /* v1.11: linha com hora (13:17) é a linha da data/hora do recibo,
     mesmo com a data destruída pelo OCR ("20267 衝 722( 日 )
     13:17") — nome de loja não tem relógio. */
  if (/\d{1,2}:\d{2}/.test(s)) return true;
  /* v1.11: telefone sem o rótulo TEL ("EL 04.-503-2330"), linha de
     imposto ("(内 費 科 等 8% ¥78)") e código solto sem kana
     ("2Z33U") viraram "nome da loja" nas passadas cruas quando a
     linha certa era descartada — nenhum dos três é nome. */
  if (/0\d{1,4}[-.]\d{1,4}[-.]\d{4}/.test(s) || /\d{9,}/.test(s)) return true;
  if (/消費税|税等|対象|内消費/.test(s)) return true;
  if (/[%％]/.test(s)) return true;
  var flatAll = s.replace(/\s/g, '');
  if (!/[ぁ-んァ-ヶ一-龯]/.test(flatAll) && /\d/.test(flatAll) &&
      /[A-Za-z]/.test(flatAll) && !/\s/.test(s.trim())) return true;
  return false;
}

/* v1.11: linha fragmentada — o OCR de um nome/logo ilegível
   devolve kanji e kana SOLTOS, separados por espaço ("大 間 。
   呈 由 番 弓 1 4 っ", "ンー 0 考"): todos os tokens têm 1–2
   caracteres. Nome de verdade não vem assim — e rede conhecida
   já casou antes, no chainHit que ignora espaços (um nome com
   kana espaçado de verdade, "サイ ゼリ ヤ", tem a sequência de
   3+ kana ao juntar, e não é marcado). O que não se lê com
   segurança fica em branco, não vira "nome da loja". */
function isFragmentedLine(s) {
  var toks = s.trim().split(/\s+/);
  if (toks.length < 3) return false;
  for (var i = 0; i < toks.length; i++) if (toks[i].length > 2) return false;
  if (toks.length >= 4) return true;
  var flat = s.replace(/\s/g, '');
  return !/[ぁ-んァ-ヶ一-龯]{3,}/.test(flat) && !/[A-Za-z]{3,}/.test(s);
}

/* v1.11: linha de ITEM não é nome da loja — em recibo em inglês,
   a primeira linha "limpa" do topo pode ser um prato do cardápio
   ("Avocado cheeSe burger", sem preço naquela passada). Se a
   mesma linha aparece em outra passada COM preço (≥ ¥100), ela
   é item: nome de loja nunca é vendido no próprio recibo. */
function isPricedItemLine(lines, cand) {
  var c = cand.replace(/\s/g, '').toLowerCase();
  if (c.length < 4) return false;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].replace(/\s/g, '').toLowerCase();
    if (l.length <= c.length || l.indexOf(c) !== 0) continue;
    var nums = numbersInLineFuzzy(lines[i]);
    for (var j = 0; j < nums.length; j++) if (nums[j] >= 100) return true;
  }
  return false;
}

function extractStore(rawText) {
  var text = normalizeOcr(rawText);
  for (var i = 0; i < CHAIN_NAMES.length; i++) {
    if (chainHit(text, CHAIN_NAMES[i][0])) return CHAIN_NAMES[i][1];
  }
  var lines = text.split(/\n/);
  var legalFallback = '';
  for (var j = 0; j < Math.min(lines.length, 8); j++) {
    var s = lines[j].trim();
    if (s.length < 2 || s.length > 30) continue;
    if (isJunkStoreLine(s)) continue;
    if (isFragmentedLine(s)) continue;
    if (isPricedItemLine(lines, s)) continue;
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
  /* Tolerante (v1.5): separador lido como "." ou espaço no meio do
     grupo e letras trocadas por dígitos (O/U→0) — ex.: "045-503 2 33U".
     Reconstrói o número pelos dígitos, no agrupamento japonês comum. */
  var m2 = /0[0-9OoUu][0-9OoUu .-]{6,}[0-9OoUu]/.exec(text);
  if (m2) {
    var digs = m2[0].replace(/[Oo]/g, '0').replace(/[Uu]/g, '0').replace(/[^0-9]/g, '');
    if (digs.length === 10) {
      if (/^0[36]/.test(digs)) return digs.slice(0, 2) + '-' + digs.slice(2, 6) + '-' + digs.slice(6);
      return digs.slice(0, 3) + '-' + digs.slice(3, 6) + '-' + digs.slice(6);
    }
    if (digs.length === 11) {
      return digs.slice(0, 3) + '-' + digs.slice(3, 7) + '-' + digs.slice(7);
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
  for (var i = 0; i < CHAIN_NAMES.length; i++) {
    var needle = CHAIN_NAMES[i][0].replace(/\s/g, '');
    if (!chainHit(text, CHAIN_NAMES[i][0])) continue;
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
      /* Linha do cabeçalho que é SÓ o nome da filial, terminando em
         店 (ex.: 横浜京急生麦駅前店) — vale mais que um recorte
         parcial da mesma linha. */
      for (var k = 0; k < Math.min(lines.length, 8); k++) {
        var s = lines[k].trim().replace(/\s/g, '');
        if (s.length < 3 || s.length > 14) continue;
        if (!/店$/.test(s)) continue;
        /* Só kana/kanji: linha de cabeçalho de documento (領収証…)
           lida errado pelo OCR não é filial. */
        if (!/^[ぁ-んァ-ヶー一-龯]+店$/.test(s)) continue;
        if (/合計|小計|TEL|電話|領収|請求|頁/.test(s)) continue;
        if (s.indexOf(needle) >= 0) continue;
        branch = s;
        break;
      }
    }
    if (!branch) {
      /* Filial "…駅前" (ex.: 生麦駅前) numa linha do cabeçalho. */
      for (var e = 0; e < Math.min(lines.length, 10) && !branch; e++) {
        var se = lines[e].replace(/\s/g, '');
        var me = /[ぁ-んァ-ヶー一-龯]{1,4}駅前/.exec(se);
        if (me) branch = me[0];
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

/* ============ Data da foto (photoAt) ============
   `date` é a data IMPRESSA no recibo — é ela que vale pra totais,
   histórico e Lugares. `photoAt` é outra coisa: o dia em que a foto
   foi tirada/importada, guardado separado pra conferência. */

/* ms → 'YYYY-MM-DD' (data local). */
function isoFromMs(ms) {
  var d = new Date(ms);
  if (isNaN(d.getTime())) return todayISO();
  return toISODate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/* Lê a data de captura do EXIF de um JPEG (bytes crus do arquivo).
   Parser mínimo: segmentos JPEG → APP1 "Exif" → TIFF (II ou MM) →
   ExifIFD (ponteiro 0x8769) → DateTimeOriginal (0x9003); sem ele,
   vale o DateTime do IFD0 (0x0132). TEM que ler do arquivo original:
   o canvas do downscale apaga o EXIF. Devolve 'YYYY-MM-DD' ou null. */
function parseExifDate(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  var pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xFF) return null;
    var marker = bytes[pos + 1];
    if (marker === 0xDA || marker === 0xD9) return null;
    var len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (len < 2) return null;
    if (marker === 0xE1 && pos + 10 <= bytes.length &&
        bytes[pos + 4] === 0x45 && bytes[pos + 5] === 0x78 &&
        bytes[pos + 6] === 0x69 && bytes[pos + 7] === 0x66 &&
        bytes[pos + 8] === 0 && bytes[pos + 9] === 0) {
      return exifDateFromTiff(bytes, pos + 10);
    }
    pos += 2 + len;
  }
  return null;
}

function exifDateFromTiff(b, t0) {
  if (t0 + 8 > b.length) return null;
  var little = b[t0] === 0x49 && b[t0 + 1] === 0x49;
  var big = b[t0] === 0x4D && b[t0 + 1] === 0x4D;
  if (!little && !big) return null;
  function u16(o) {
    return little ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
  }
  function u32(o) {
    return little
      ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0)
      : (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  }
  if (u16(t0 + 2) !== 42) return null;
  function readIfd(off) {
    var entries = {};
    if (off < t0 || off + 2 > b.length) return entries;
    var n = u16(off), i, e;
    for (i = 0; i < n; i++) {
      e = off + 2 + i * 12;
      if (e + 12 > b.length) break;
      entries[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valOff: e + 8, raw: u32(e + 8) };
    }
    return entries;
  }
  function asciiOf(ent) {
    if (!ent || ent.type !== 2 || !ent.count) return null;
    var start = ent.count <= 4 ? ent.valOff : t0 + ent.raw;
    if (start < 0 || start >= b.length) return null;
    var s = '';
    for (var i = 0; i < ent.count && start + i < b.length; i++) {
      var c = b[start + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  function toISODateStr(s) {
    if (!s) return null;
    var m = /(\d{4}):(\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return toISODate(y, mo, d);
  }
  var ifd0 = readIfd(t0 + u32(t0 + 4));
  var ptr = ifd0[0x8769];
  if (ptr) {
    var dto = toISODateStr(asciiOf(readIfd(t0 + ptr.raw)[0x9003]));
    if (dto) return dto;
  }
  return toISODateStr(asciiOf(ifd0[0x0132]));
}

/* Prioridade da data da foto: EXIF → lastModified do arquivo → agora. */
function resolvePhotoAt(exifISO, lastModified, nowMs) {
  if (exifISO) return exifISO;
  if (lastModified) return isoFromMs(lastModified);
  return isoFromMs(nowMs || Date.now());
}

/* Lê o EXIF do arquivo escolhido (antes de qualquer canvas) e
   resolve o photoAt; qualquer falha cai pro lastModified/agora. */
function readPhotoAt(file, cb) {
  var finish = function (exifISO) {
    cb(resolvePhotoAt(exifISO, file && file.lastModified, Date.now()));
  };
  if (!file || typeof file.arrayBuffer !== 'function') { finish(null); return; }
  file.arrayBuffer().then(function (buf) {
    var iso = null;
    try { iso = parseExifDate(new Uint8Array(buf)); } catch (e) { iso = null; }
    finish(iso);
  }, function () { finish(null); });
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
  var createdAt = raw.createdAt || Date.now();
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
    /* Migração v1.6: item antigo sem `photoAt` herda o dia do
       `createdAt` — a melhor aproximação do dia da foto. */
    photoAt: (typeof raw.photoAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.photoAt))
      ? raw.photoAt : isoFromMs(createdAt),
    /* v1.7: o texto bruto do OCR que gerou o item (passadas
       combinadas, até ~6.000 caracteres). É diagnóstico — não entra
       em nenhum cálculo — e viaja no backup pra qualquer falha
       futura ser investigável sem simular o aparelho. Item antigo
       ou vindo de QR/formulário fica ''. */
    ocrText: typeof raw.ocrText === 'string' ? raw.ocrText.slice(0, 6000) : '',
    createdAt: createdAt
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
var pendingPhotoAt = null; // data da foto do arquivo em leitura (EXIF)
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
    ['Data do recibo', fmtDateBR(it.date)],
    ['Valor', it.amount > 0 ? fmtYen(it.amount) : '—']
  ];
  if (it.photoAt) rows.push(['Foto', fmtDateBR(it.photoAt)]);
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

  /* v1.7: o texto bruto do OCR, recolhível — diagnóstico quando
     algum campo saiu errado. Item sem leitura (QR, manual, antigo)
     não mostra a seção. (Com guarda: um index.html antigo em cache
     não pode quebrar o detalhe.) */
  var ow = $('dOcrWrap');
  if (ow && it.ocrText) {
    $('dOcrText').textContent = it.ocrText;
    ow.classList.remove('hidden');
  } else if (ow) ow.classList.add('hidden');

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
      data.photoAt = old.photoAt || null; // foto não muda na edição
      data.ocrText = old.ocrText || ''; // leitura original não muda na edição
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
    photoAt: data.photoAt || null,
    ocrText: data.ocrText || '',
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
/* ============ Preparação da foto pro OCR (v1.5) ============
   A foto crua reprova: o recibo é uma faixa clara e estreita sobre
   um fundo escuro e texturizado, e o Tesseract perde a segmentação
   (o fundo vira páginas de ruído e o texto miúdo some). A preparação:
   1. acha a faixa do papel pelo brilho médio das colunas/linhas;
   2. gera variantes em cinza com contraste esticado e borda branca,
      em escalas e recortes diferentes (cabeçalho, recibo inteiro,
      zona dos totais) — cada passada lê melhor uma parte;
   3. lê as variantes com PSM 4 e junta os textos pra extração. */

/* Acha a caixa do papel (recorte "solto" e "folgado") ou null.
   Analisa uma cópia de 200px de largura: papel é a maior sequência
   de colunas/linhas com brilho médio acima do meio-termo. */
function detectPaperBoxes(img) {
  var W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) return null;
  var aw = 200, ah = Math.max(1, Math.round(H * aw / W));
  var cv = document.createElement('canvas');
  cv.width = aw; cv.height = ah;
  var cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0, aw, ah);
  var data;
  try {
    data = cx.getImageData(0, 0, aw, ah).data;
  } catch (e) { return null; }
  function lum(x, y) {
    var p = (y * aw + x) * 4;
    return (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  function axisRun(means) {
    var mn = Infinity, mx = -Infinity, i;
    for (i = 0; i < means.length; i++) {
      if (means[i] < mn) mn = means[i];
      if (means[i] > mx) mx = means[i];
    }
    if (mx < 140) return null;
    var thr = (mn + mx) / 2;
    var best = null, cur = null;
    for (i = 0; i < means.length; i++) {
      if (means[i] > thr && cur === null) cur = i;
      if ((means[i] <= thr || i === means.length - 1) && cur !== null) {
        var end = (means[i] <= thr) ? i : i + 1;
        if (!best || end - cur > best[1] - best[0]) best = [cur, end];
        cur = null;
      }
    }
    if (!best) return null;
    var len = best[1] - best[0];
    if (len < means.length * 0.25 || len >= means.length * 0.97) return null;
    return best;
  }
  var colMeans = [], rowMeans = [], x, y, s;
  for (x = 0; x < aw; x++) {
    s = 0;
    for (y = 0; y < ah; y++) s += lum(x, y);
    colMeans.push(s / ah);
  }
  for (y = 0; y < ah; y++) {
    s = 0;
    for (x = 0; x < aw; x++) s += lum(x, y);
    rowMeans.push(s / aw);
  }
  var runX = axisRun(colMeans), runY = axisRun(rowMeans);
  function toBox(rx, ry, padFrac) {
    var x0 = rx ? rx[0] : 0, x1 = rx ? rx[1] : aw;
    var y0 = ry ? ry[0] : 0, y1 = ry ? ry[1] : ah;
    var px = Math.round((x1 - x0) * padFrac), py = Math.round((y1 - y0) * padFrac);
    x0 = Math.max(0, x0 - px); x1 = Math.min(aw, x1 + px);
    y0 = Math.max(0, y0 - py); y1 = Math.min(ah, y1 + py);
    return {
      x: Math.round(x0 / aw * W), y: Math.round(y0 / ah * H),
      w: Math.round((x1 - x0) / aw * W), h: Math.round((y1 - y0) / ah * H)
    };
  }
  if (!runX && !runY) return null;
  return { tight: toBox(runX, runY, 0.06), wide: toBox(runX, runY, 0.12) };
}

/* Desenha o recorte em cinza, com contraste esticado (mín/máx) e
   borda branca, escalado pra largura alvo (altura máx. 3600px). */
function makeOcrVariant(img, box, targetW) {
  var scale = targetW / box.w;
  if (box.h * scale > 3600) scale = 3600 / box.h;
  var w = Math.max(50, Math.round(box.w * scale));
  var h = Math.max(50, Math.round(box.h * scale));
  var cv = document.createElement('canvas');
  cv.width = w + 48; cv.height = h + 48;
  var cx = cv.getContext('2d');
  cx.fillStyle = '#ffffff';
  cx.fillRect(0, 0, cv.width, cv.height);
  cx.drawImage(img, box.x, box.y, box.w, box.h, 24, 24, w, h);
  var id = cx.getImageData(0, 0, cv.width, cv.height);
  var d = id.data;
  var mn = 255, mx = 0, i, g;
  for (i = 0; i < d.length; i += 4) {
    g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = g;
    if (g < mn) mn = g;
    if (g > mx) mx = g;
  }
  var range = mx - mn;
  for (i = 0; i < d.length; i += 4) {
    var v = d[i];
    if (range >= 30) v = Math.max(0, Math.min(255, (v - mn) * 255 / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  cx.putImageData(id, 0, 0);
  return cv.toDataURL('image/jpeg', 0.9);
}

function loadImageEl(src) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () { resolve(img); };
    img.onerror = reject;
    img.src = src;
  });
}

/* Lê as variantes com um worker só, trocando o PSM por passada. */
function ocrPasses(variants, onPass) {
  return Tesseract.createWorker('jpn', 1, {
    logger: function (m) {
      if (m.status === 'recognizing text' && onPass) onPass(m.progress);
    }
  }).then(function (worker) {
    var text = '';
    var chain = Promise.resolve();
    variants.forEach(function (v, idx) {
      chain = chain.then(function () {
        if (onPass) onPass(0, idx + 1, variants.length);
        return worker.setParameters({ tessedit_pageseg_mode: v.psm })
          .then(function () { return worker.recognize(v.img); })
          .then(function (res) {
            text += '\n' + ((res && res.data && res.data.text) || '');
          });
      });
    });
    return chain.then(function () {
      return worker.terminate().then(function () { return text; });
    }, function (err) {
      try { worker.terminate(); } catch (e) {}
      throw err;
    });
  });
}

/* Marcadores da zona de totais: se nenhum aparece no texto
   combinado, as passadas não leram a metade de baixo do recibo. */
function hasTotalsMarkers(text) {
  return /合計|小計|対象|預|釣|税/.test(String(text || '').replace(/\s/g, ''));
}

/* Passadas de RESGATE (v1.8): a foto nova da Saizeriya — reta, bem
   iluminada — rendeu só 273 caracteres nas passadas A–D: a zona de
   totais não foi lida em nenhuma escala/PSM delas. O resgate relê
   a zona de totais em outras combinações (PSM 6 lê o bloco térmico
   denso melhor que o PSM 4 em vários motores; 1100px às vezes vence
   2200px) e a zona da data (a linha do TEL/data fica no meio do
   recibo, fora dos recortes de totais). Só roda quando precisa:
   sem marcador de totais no texto OU sem total extraído — marcador
   sozinho não basta, porque o rodapé "軽減税率対象品目" carrega
   税/対象 sem a zona de totais ter sido lida. */
function rescueVariants(img, boxes) {
  var full = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  var tight = boxes ? boxes.tight : full;
  function zone(y0, y1) {
    return {
      x: tight.x, y: Math.round(tight.y + tight.h * y0),
      w: tight.w, h: Math.round(tight.h * (y1 - y0))
    };
  }
  var totals = zone(0.53, 1);
  return [
    { img: makeOcrVariant(img, totals, 1500), psm: '6' },
    { img: makeOcrVariant(img, totals, 2200), psm: '4' },
    { img: makeOcrVariant(img, totals, 2200), psm: '6' },
    { img: makeOcrVariant(img, totals, 1100), psm: '6' },
    { img: makeOcrVariant(img, zone(0.12, 0.52), 2000), psm: '6' }
  ];
}

/* Pipeline completo: prepara as variantes e lê. Se o telefone não
   sair nas passadas PSM 4, tenta uma passada extra em PSM automático
   na variante folgada (ela lê melhor a linha do TEL). Se a zona de
   totais não tiver sido lida (ou o total não tiver saído), roda as
   passadas de resgate antes de devolver o texto. */
function prepareAndOcr(dataUrl) {
  return loadImageEl(dataUrl).then(function (img) {
    var boxes = detectPaperBoxes(img);
    var full = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    var tight = boxes ? boxes.tight : full;
    var wide = boxes ? boxes.wide : full;
    var totals = {
      x: tight.x, y: Math.round(tight.y + tight.h * 0.53),
      w: tight.w, h: Math.round(tight.h * 0.47)
    };
    var variants = [
      { img: makeOcrVariant(img, tight, 1100), psm: '4' },
      { img: makeOcrVariant(img, wide, 1650), psm: '4' },
      { img: makeOcrVariant(img, totals, 1500), psm: '4' }
    ];
    var totalPasses = variants.length;
    return ocrPasses(variants, function (progress, passIdx, passCount) {
      if (passIdx) {
        $('ocrStatus').textContent = 'Lendo a foto… parte ' + passIdx + ' de ' + passCount;
        $('ocrBar').style.width = Math.round((passIdx - 1) / passCount * 100) + '%';
      } else if (typeof progress === 'number') {
        $('ocrBar').style.width = Math.min(99, Math.round(progress * 100)) + '%';
      }
    }).then(function (merged) {
      if (extractPhone(merged)) return merged;
      var extra = [{ img: makeOcrVariant(img, wide, 1100), psm: '3' }];
      return ocrPasses(extra, null).then(function (t) {
        return merged + '\n' + t;
      }, function () { return merged; });
    }).then(function (merged) {
      if (hasTotalsMarkers(merged) && extractMoney(merged).amount !== null) {
        return merged;
      }
      $('ocrStatus').textContent = 'Lendo a foto… parte extra (totais)';
      return ocrPasses(rescueVariants(img, boxes), null).then(function (t) {
        return merged + '\n' + t;
      }, function () { return merged; });
    });
  });
}

function runOCR(dataUrl) {
  var box = $('ocrBox');
  box.classList.remove('hidden');
  $('ocrStatus').textContent = 'Preparando a foto…';
  $('ocrBar').style.width = '5%';
  if (typeof Tesseract === 'undefined' || !Tesseract.createWorker) {
    box.classList.add('hidden');
    saveExtractedItem({ type: 'recibo', date: todayISO(), category: 'Outros', photoAt: pendingPhotoAt }, dataUrl, '');
    return;
  }
  prepareAndOcr(dataUrl).then(function (text) {
    box.classList.add('hidden');
    var data = extractFromText(text);
    data.photoAt = pendingPhotoAt;
    data.ocrText = text;
    saveExtractedItem(data, dataUrl, '');
  }).catch(function () {
    /* Plano B: leitura simples, como era antes da v1.5. */
    Tesseract.recognize(dataUrl, 'jpn', {
      logger: function (m) {
        if (m.status === 'recognizing text') {
          $('ocrBar').style.width = Math.round(m.progress * 100) + '%';
          $('ocrStatus').textContent = 'Lendo a foto… ' + Math.round(m.progress * 100) + '%';
        }
      }
    }).then(function (res) {
      box.classList.add('hidden');
      var text = (res && res.data && res.data.text) || '';
      var data = extractFromText(text);
      data.photoAt = pendingPhotoAt;
      data.ocrText = text;
      saveExtractedItem(data, dataUrl, '');
    }).catch(function () {
      box.classList.add('hidden');
      saveExtractedItem({ type: 'recibo', date: todayISO(), category: 'Outros', photoAt: pendingPhotoAt }, dataUrl, '');
    });
  });
}
function handlePhotoFile(file) {
  if (!file) return;
  /* EXIF primeiro: o downscale (canvas) apaga os metadados. */
  readPhotoAt(file, function (photoAt) {
    pendingPhotoAt = photoAt;
    downscaleImage(file, function (dataUrl) { runOCR(dataUrl); });
  });
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

/* Rodapé de versão (v1.8): "Meus Recibos JP · versão X.Y" no fim
   das telas Início e Backup — é assim que o usuário confirma que a
   atualização chegou (nos outros apps ele confere a versão em
   Ajustes). A fonte única é APP_VERSION. O texto é preenchido pelo
   JS e, se o HTML em cache for antigo e não tiver o elemento, ele
   é criado aqui — a linha aparece mesmo com HTML velho. */
function renderVersionFooter(doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || !d.getElementById || !d.createElement) return '';
  var text = 'Meus Recibos JP · versão ' + APP_VERSION;
  var views = ['view-home', 'view-backup'];
  for (var i = 0; i < views.length; i++) {
    var view = d.getElementById(views[i]);
    if (!view || !view.appendChild) continue;
    var found = null;
    if (view.querySelectorAll) {
      var kids = view.querySelectorAll('.app-version');
      if (kids && kids.length) found = kids[0];
    }
    if (!found) {
      found = d.createElement('div');
      found.className = 'app-version';
      view.appendChild(found);
    }
    found.textContent = text;
  }
  return text;
}

function init() {
  var rawItems = loadItems();
  var needsMigration = rawItems.some(function (r) {
    return r && typeof r === 'object' && (r.place === undefined || r.photoAt === undefined);
  });
  items = rawItems.map(sanitizeItem).filter(Boolean);
  if (needsMigration) saveItems(items); // grava place/branch/phone/photoAt derivados
  var now = new Date();
  viewMonth = { y: now.getFullYear(), m: now.getMonth() };
  fillSelects();
  bindEvents();
  renderVersionFooter();
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
    parseExifDate: parseExifDate, resolvePhotoAt: resolvePhotoAt,
    isoFromMs: isoFromMs,
    groupPlaces: groupPlaces, placeYears: placeYears,
    findAllDates: findAllDates,
    fmtYen: fmtYen, fmtDateBR: fmtDateBR, mergeImport: mergeImport,
    sanitizeItem: sanitizeItem, CATEGORIES: CATEGORIES,
    buildBackupPayload: buildBackupPayload,
    APP_VERSION: APP_VERSION, renderVersionFooter: renderVersionFooter,
    hasTotalsMarkers: hasTotalsMarkers
  };
}
