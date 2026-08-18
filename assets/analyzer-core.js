/*!
 * Kursova24 — рушій аналізу тексту
 * Антиплагіат (внутрішні повтори + порівняння з джерелами) та AI-детектор.
 * Повністю офлайн, працює у Web Worker, розрахований на великі тексти (до ~5 млн символів).
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- утиліти

  var TOKEN_RE = /[A-Za-zА-Яа-яЁёЇїІіЄєҐґ0-9][A-Za-zА-Яа-яЁёЇїІіЄєҐґ0-9'’\-]*/g;

  function normalize(text) {
    return String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u2018\u2019\u02bc]/g, '’')
      .replace(/[\u201c\u201d\u00ab\u00bb]/g, '"');
  }

  function tokenize(text) {
    var out = [];
    var m;
    TOKEN_RE.lastIndex = 0;
    var lower = text.toLowerCase();
    while ((m = TOKEN_RE.exec(lower)) !== null) out.push(m[0]);
    return out;
  }

  // FNV-1a 32-bit
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function shingleHashes(words, n) {
    var total = words.length - n + 1;
    if (total <= 0) return new Uint32Array(0);
    var wh = new Uint32Array(words.length);
    for (var i = 0; i < words.length; i++) wh[i] = hashStr(words[i]);
    var res = new Uint32Array(total);
    for (var s = 0; s < total; s++) {
      var h = 0x811c9dc5;
      for (var k = 0; k < n; k++) {
        h = (h ^ wh[s + k]) >>> 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
      res[s] = h;
    }
    return res;
  }

  function clamp01(x) {
    if (!isFinite(x)) return 0;
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  function mean(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function stdev(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr), s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / (arr.length - 1));
  }

  function round(x, d) {
    var p = Math.pow(10, d || 0);
    return Math.round(x * p) / p;
  }

  // ------------------------------------------------- сегментація тексту

  var ABBREV = ['т.д', 'т.п', 'т.ін', 'ін', 'див', 'напр', 'проф', 'доц', 'акад', 'рис', 'табл', 'рр', 'вид', 'обл'];

  function splitSentences(text) {
    var out = [];
    var buf = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      buf += ch;
      if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
        // проглядаємо далі: кінець речення = розділовий + пробіл/перенос
        var j = i + 1;
        while (j < text.length && (text[j] === '.' || text[j] === '!' || text[j] === '?' || text[j] === '…' || text[j] === '"' || text[j] === ')')) {
          buf += text[j];
          j++;
        }
        var next = text[j];
        if (next === undefined || /\s/.test(next)) {
          var tail = buf.replace(/[^A-Za-zА-Яа-яЁёЇїІіЄєҐґ.]/g, '').toLowerCase();
          var isAbbrev = false;
          for (var a = 0; a < ABBREV.length; a++) {
            if (tail.slice(-(ABBREV[a].length + 1)) === ABBREV[a] + '.') { isAbbrev = true; break; }
          }
          if (!isAbbrev) {
            var t = buf.trim();
            if (t) out.push(t);
            buf = '';
          }
        }
        i = j - 1;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(function (s) { return /[A-Za-zА-Яа-яЁёЇїІіЄєҐґ]/.test(s); });
  }

  function splitParagraphs(text) {
    var parts = text.split(/\n\s*\n+/);
    if (parts.length < 3) parts = text.split(/\n+/);
    return parts.map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 0; });
  }

  // ------------------------------------------------- словники маркерів

  var CLICHE = [
    'у сучасному світі', 'в сучасному світі', 'в современном мире', 'у сучасних умовах',
    'важливо відзначити', 'важливо зазначити', 'слід зазначити', 'варто зазначити',
    'необхідно відзначити', 'необхідно зазначити', 'слід підкреслити', 'варто підкреслити',
    'підводячи підсумок', 'підсумовуючи вищесказане', 'на підставі вищевикладеного',
    'у рамках даного дослідження', 'в рамках даного дослідження', 'даній роботі',
    'комплексний підхід', 'відіграє важливу роль', 'відіграє ключову роль',
    'грає важливу роль', 'невід’ємною частиною', 'невідємною частиною',
    'не втрачає своєї актуальності', 'набуває особливої актуальності',
    'постійно зростаюч*', 'динамічно розвиваєтьс*', 'стрімкий розвиток',
    'у контексті вищезазначеного', 'з огляду на вищезазначене',
    'таким чином, можна зробити висновок', 'отже, можна зробити висновок',
    'слід також враховувати', 'важливим аспектом є', 'ключовим аспектом є',
    'сучасні реалії', 'широкий спектр', 'цілий ряд факторів', 'багатогранн*',
    'in conclusion', 'it is important to note', 'it is worth noting', 'furthermore',
    'moreover', 'in today’s world', "in today's world", 'delve into', 'tapestry',
    'landscape of', 'plays a crucial role', 'play a crucial role', 'a testament to',
    'navigate the complexities', 'ever-evolving', 'multifaceted', 'holistic approach',
    'shed light on', 'it is essential to', 'when it comes to'
  ];

  var DISCOURSE = [
    'таким чином', 'отже', 'крім того', 'окрім того', 'по-перше', 'по-друге', 'по-третє',
    'зокрема', 'водночас', 'проте', 'однак', 'натомість', 'відповідно', 'внаслідок',
    'у результаті', 'загалом', 'зрештою', 'насамперед', 'передусім', 'до того ж',
    'з іншого боку', 'з одного боку', 'разом з тим', 'при цьому', 'на додаток',
    'therefore', 'however', 'additionally', 'consequently', 'in addition', 'firstly',
    'secondly', 'overall', 'nevertheless', 'thus'
  ];

  var HEDGES = ['може', 'можливо', 'ймовірно', 'зазвичай', 'як правило', 'часто', 'здебільшого', 'певною мірою', 'у деяких випадках', 'потенційно'];

  var FIRST_PERSON = ['я', 'мною', 'мій', 'моя', 'моє', 'мої', 'ми', 'нами', 'наш', 'наша', 'наше', 'наші', 'вважаю', 'вважаємо', 'на мою думку', 'на наш погляд', 'на нашу думку', 'переконані'];

  var WORD_CH = 'A-Za-zА-Яа-яЁёЇїІіЄєҐґ0-9';

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  var regexCache = new Map();

  function phraseRegex(list) {
    var key = list.length + '|' + list[0];
    if (regexCache.has(key)) return regexCache.get(key);
    var alts = list.slice().sort(function (a, b) { return b.length - a.length; }).map(function (p) {
      var stem = p.charAt(p.length - 1) === '*';
      var body = escapeRe(stem ? p.slice(0, -1) : p).replace(/\\?\s+/g, '[\\s]+');
      return body + (stem ? '[' + WORD_CH + ']*' : '');
    });
    var re = new RegExp('(^|[^' + WORD_CH + '])(' + alts.join('|') + ')(?![' + WORD_CH + '])', 'gi');
    regexCache.set(key, re);
    return re;
  }

  // Підрахунок фраз із урахуванням меж слів (щоб «системи» не рахувалось як «ми»).
  function countPhrases(lowerText, list) {
    var re = phraseRegex(list);
    re.lastIndex = 0;
    var counts = new Map();
    var total = 0;
    var m;
    while ((m = re.exec(lowerText)) !== null) {
      var hit = m[2].replace(/\s+/g, ' ').toLowerCase();
      counts.set(hit, (counts.get(hit) || 0) + 1);
      total++;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    var found = [];
    counts.forEach(function (v, k) { found.push({ phrase: k, count: v }); });
    found.sort(function (a, b) { return b.count - a.count; });
    return { total: total, found: found };
  }

  // ------------------------------------------------- лексична різноманітність

  function lexicalStats(words) {
    var freq = new Map();
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    var hapax = 0;
    freq.forEach(function (v) { if (v === 1) hapax++; });
    var top = [];
    freq.forEach(function (v, k) { if (k.length > 4) top.push([k, v]); });
    top.sort(function (a, b) { return b[1] - a[1]; });
    return {
      unique: freq.size,
      hapax: hapax,
      hapaxRatio: words.length ? hapax / words.length : 0,
      ttr: words.length ? freq.size / words.length : 0,
      topWords: top.slice(0, 15).map(function (p) { return { word: p[0], count: p[1] }; })
    };
  }

  // MTLD (moving-average type-token ratio, factor 0.72)
  function mtld(words, threshold) {
    threshold = threshold || 0.72;
    if (words.length < 50) return 0;
    function pass(seq) {
      var factors = 0, types = new Set(), tokens = 0;
      for (var i = 0; i < seq.length; i++) {
        tokens++;
        types.add(seq[i]);
        var ttr = types.size / tokens;
        if (ttr <= threshold) {
          factors++;
          types = new Set();
          tokens = 0;
        }
      }
      if (tokens > 0) {
        var partial = types.size / tokens;
        factors += (1 - partial) / (1 - threshold);
      }
      return factors > 0 ? seq.length / factors : seq.length;
    }
    var rev = words.slice().reverse();
    return (pass(words) + pass(rev)) / 2;
  }

  // ------------------------------------------------- внутрішні повтори

  function internalDuplication(words, n, minBlock) {
    n = n || 6;
    minBlock = minBlock || 8;
    var hashes = shingleHashes(words, n);
    if (!hashes.length) {
      return { shingles: 0, duplicateShingles: 0, coverage: 0, blocks: [] };
    }
    var first = new Map();
    var pairs = [];
    for (var i = 0; i < hashes.length; i++) {
      var h = hashes[i];
      if (first.has(h)) pairs.push([first.get(h), i]);
      else first.set(h, i);
    }
    // покриття словами
    var covered = new Uint8Array(words.length);
    for (var p = 0; p < pairs.length; p++) {
      var start = pairs[p][1];
      for (var k = 0; k < n; k++) covered[start + k] = 1;
      var s2 = pairs[p][0];
      for (var k2 = 0; k2 < n; k2++) covered[s2 + k2] = 1;
    }
    var cov = 0;
    for (var c = 0; c < covered.length; c++) if (covered[c]) cov++;

    // склеювання блоків
    var blocks = [];
    var cur = null;
    for (var q = 0; q < pairs.length; q++) {
      var src = pairs[q][0], dup = pairs[q][1];
      if (cur && dup === cur.dup + cur.len - n + 1 && src === cur.src + cur.len - n + 1) {
        cur.len++;
      } else {
        if (cur && cur.len >= minBlock) blocks.push(cur);
        cur = { src: src, dup: dup, len: n };
      }
    }
    if (cur && cur.len >= minBlock) blocks.push(cur);
    blocks.sort(function (a, b) { return b.len - a.len; });

    // прибираємо блоки, що перекриваються (щоб не показувати те саме зі зсувом на слово)
    var chosen = [];
    for (var b1 = 0; b1 < blocks.length && chosen.length < 300; b1++) {
      var cand = blocks[b1];
      var overlap = false;
      for (var b2 = 0; b2 < chosen.length; b2++) {
        var c2 = chosen[b2];
        var a1 = cand.dup, a2 = cand.dup + cand.len;
        var d1 = c2.dup, d2 = c2.dup + c2.len;
        if (a1 < d2 && d1 < a2) { overlap = true; break; }
        var e1 = cand.src, e2 = cand.src + cand.len;
        if (e1 < d2 && d1 < e2) { overlap = true; break; }
      }
      if (!overlap) chosen.push(cand);
    }

    return {
      shingles: hashes.length,
      duplicateShingles: pairs.length,
      coverage: words.length ? cov / words.length : 0,
      blocks: groupBlocks(chosen, words)
    };
  }


  // Групуємо однакові за текстом повтори, щоб не показувати той самий фрагмент багато разів.
  function groupBlocks(chosen, words) {
    var map = new Map();
    for (var i = 0; i < chosen.length; i++) {
      var b = chosen[i];
      var full = words.slice(b.dup, b.dup + b.len).join(' ');
      var key = full.slice(0, 160);
      if (map.has(key)) {
        var g = map.get(key);
        g.occurrences++;
        if (g.positions.length < 6) g.positions.push(b.dup);
        if (b.len > g.words) g.words = b.len;
      } else {
        map.set(key, {
          words: b.len,
          text: full.slice(0, 400) + (full.length > 400 ? ' …' : ''),
          firstAt: b.src,
          repeatAt: b.dup,
          occurrences: 1,
          positions: [b.dup]
        });
      }
    }
    var out = [];
    map.forEach(function (v) { out.push(v); });
    out.sort(function (a, b) { return (b.words * b.occurrences) - (a.words * a.occurrences); });
    return out.slice(0, 20);
  }

  // ------------------------------------------------- порівняння з джерелами

  function compareWithSources(words, sources, n) {
    n = n || 5;
    var mine = shingleHashes(words, n);
    if (!mine.length) return { overall: 0, matchedWords: 0, perSource: [], fragments: [] };

    var mineSet = new Set();
    for (var i = 0; i < mine.length; i++) mineSet.add(mine[i]);

    var covered = new Uint8Array(words.length);
    var ownerAt = new Int16Array(mine.length);
    for (var z = 0; z < ownerAt.length; z++) ownerAt[z] = -1;

    var perSource = [];
    for (var s = 0; s < sources.length; s++) {
      var srcWords = tokenize(normalize(sources[s].text));
      var srcHashes = shingleHashes(srcWords, n);
      var srcSet = new Set();
      for (var j = 0; j < srcHashes.length; j++) srcSet.add(srcHashes[j]);

      var hits = 0;
      var localCovered = new Uint8Array(words.length);
      for (var m = 0; m < mine.length; m++) {
        if (srcSet.has(mine[m])) {
          hits++;
          if (ownerAt[m] === -1) ownerAt[m] = s;
          for (var k = 0; k < n; k++) { covered[m + k] = 1; localCovered[m + k] = 1; }
        }
      }
      var lc = 0;
      for (var c = 0; c < localCovered.length; c++) if (localCovered[c]) lc++;

      var inter = 0;
      srcSet.forEach(function (h) { if (mineSet.has(h)) inter++; });
      var union = mineSet.size + srcSet.size - inter;

      perSource.push({
        name: sources[s].name,
        sourceWords: srcWords.length,
        containment: mine.length ? hits / mine.length : 0,
        coverage: words.length ? lc / words.length : 0,
        jaccard: union ? inter / union : 0
      });
    }
    perSource.sort(function (a, b) { return b.coverage - a.coverage; });

    var totalCov = 0;
    for (var t = 0; t < covered.length; t++) if (covered[t]) totalCov++;

    // фрагменти-збіги
    var fragments = [];
    var cur = null;
    for (var f = 0; f < mine.length; f++) {
      if (ownerAt[f] !== -1) {
        if (cur && f === cur.end + 1 && ownerAt[f] === cur.owner) cur.end = f;
        else {
          if (cur) fragments.push(cur);
          cur = { start: f, end: f, owner: ownerAt[f] };
        }
      }
    }
    if (cur) fragments.push(cur);
    fragments = fragments.map(function (fr) {
      var len = fr.end - fr.start + n;
      return {
        words: len,
        source: sources[fr.owner] ? sources[fr.owner].name : '—',
        text: words.slice(fr.start, fr.start + Math.min(len, 45)).join(' ') + (len > 45 ? ' …' : '')
      };
    }).filter(function (fr) { return fr.words >= n; })
      .sort(function (a, b) { return b.words - a.words; });

    // однакові фрагменти згортаємо в один рядок із кількістю повторень
    var fragMap = new Map();
    for (var fi = 0; fi < fragments.length; fi++) {
      var f0 = fragments[fi];
      var fkey = f0.source + '|' + f0.text;
      if (fragMap.has(fkey)) fragMap.get(fkey).occurrences++;
      else { f0.occurrences = 1; fragMap.set(fkey, f0); }
    }
    fragments = [];
    fragMap.forEach(function (v) { fragments.push(v); });
    fragments.sort(function (a, b) { return (b.words * b.occurrences) - (a.words * a.occurrences); });
    fragments = fragments.slice(0, 25);

    return {
      shingle: n,
      overall: words.length ? totalCov / words.length : 0,
      matchedWords: totalCov,
      perSource: perSource,
      fragments: fragments
    };
  }

  // ------------------------------------------------- AI-детектор

  function aiSignals(ctx) {
    var per1000 = function (n) { return ctx.wordCount ? (n / ctx.wordCount) * 1000 : 0; };
    var sig = [];

    // 1. Burstiness — варіативність довжин речень
    var cv = ctx.sentMean ? ctx.sentStd / ctx.sentMean : 0;
    sig.push({
      key: 'burstiness',
      name: 'Варіативність довжин речень (burstiness)',
      display: round(cv, 2) + ' (норма людини ≈ 0.45–0.75)',
      score: clamp01((0.52 - cv) / 0.32),
      weight: 20,
      hint: 'AI пише реченнями однакової довжини. Додайте короткі (3–7 слів) і довгі речення поряд.'
    });

    // 2. Середня довжина речення
    sig.push({
      key: 'avgSent',
      name: 'Середня довжина речення',
      display: round(ctx.sentMean, 1) + ' слів',
      score: clamp01((ctx.sentMean - 17) / 11),
      weight: 8,
      hint: 'Понад 24 слова в середньому — типова ознака машинного академічного стилю.'
    });

    // 3. Hapax legomena
    sig.push({
      key: 'hapax',
      name: 'Частка слів, вжитих один раз',
      display: round(ctx.lex.hapaxRatio * 100, 1) + '%',
      score: clamp01((0.40 - ctx.lex.hapaxRatio) / 0.18),
      weight: 12,
      hint: 'Низька частка унікальних слів = бідний словник, характерний для генерації.'
    });

    // 4. MTLD
    sig.push({
      key: 'mtld',
      name: 'Лексична різноманітність (MTLD)',
      display: ctx.mtldValue ? round(ctx.mtldValue, 1) : 'н/д',
      score: ctx.mtldValue ? clamp01((72 - ctx.mtldValue) / 38) : 0,
      weight: 10,
      hint: 'MTLD нижче 55 означає повторюваний лексикон.'
    });

    // 5. Шаблонні фрази
    var clicheDensity = per1000(ctx.cliche.total);
    sig.push({
      key: 'cliche',
      name: 'Щільність шаблонних фраз',
      display: round(clicheDensity, 2) + ' на 1000 слів (' + ctx.cliche.total + ' збігів)',
      score: clamp01(clicheDensity / 5),
      weight: 16,
      hint: 'Приберіть кліше «у сучасному світі», «важливо зазначити», «відіграє важливу роль».'
    });

    // 6. Дискурсивні маркери
    var discDensity = per1000(ctx.discourse.total);
    sig.push({
      key: 'discourse',
      name: 'Щільність зв’язок («отже», «таким чином»)',
      display: round(discDensity, 2) + ' на 1000 слів',
      score: clamp01((discDensity - 7) / 14),
      weight: 10,
      hint: 'Надлишок службових зв’язок на початку речень — почерк моделі.'
    });

    // 7. Різноманітність пунктуації
    sig.push({
      key: 'punct',
      name: 'Різноманітність пунктуації',
      display: ctx.punctVariety + ' з 8 типів',
      score: clamp01((5 - ctx.punctVariety) / 4),
      weight: 8,
      hint: 'Живий текст містить тире, дужки, двокрапки, лапки, питальні знаки.'
    });

    // 8. Однорідність абзаців
    var pcv = ctx.paraMean ? ctx.paraStd / ctx.paraMean : 0;
    sig.push({
      key: 'paragraphs',
      name: 'Однорідність абзаців',
      display: ctx.paragraphCount >= 4 ? round(pcv, 2) + ' (варіація)' : 'мало абзаців',
      score: ctx.paragraphCount >= 4 ? clamp01((0.45 - pcv) / 0.35) : 0,
      weight: 8,
      hint: 'Абзаци однакового розміру — ознака шаблонної генерації.'
    });

    // 9. Повторюваність триграм
    sig.push({
      key: 'trigrams',
      name: 'Повторюваність 3-грам',
      display: round(ctx.trigramRepeat * 100, 2) + '%',
      score: clamp01((ctx.trigramRepeat - 0.015) / 0.06),
      weight: 8,
      hint: 'Модель часто повторює однакові трислівні конструкції.'
    });

    // 10. Конкретика: числа, дати, посилання
    var factDensity = per1000(ctx.numbers + ctx.citations);
    sig.push({
      key: 'facts',
      name: 'Щільність конкретики (числа, дати, посилання)',
      display: round(factDensity, 2) + ' на 1000 слів',
      score: clamp01((9 - factDensity) / 9),
      weight: 10,
      hint: 'Додайте статистику, роки, назви джерел — генерований текст зазвичай абстрактний.'
    });

    // 11. Авторський голос
    var fpDensity = per1000(ctx.firstPerson);
    sig.push({
      key: 'voice',
      name: 'Авторський голос і оцінки',
      display: round(fpDensity, 2) + ' на 1000 слів',
      score: clamp01((1.6 - fpDensity) / 1.6) * 0.8,
      weight: 6,
      hint: 'Власні висновки («вважаємо, що…», «на нашу думку») знижують «машинність».'
    });

    // 12. Ідеальність форматування (відсутність людських нерівностей)
    sig.push({
      key: 'irregular',
      name: 'Людські нерівності тексту',
      display: ctx.irregularities + ' знайдено',
      score: clamp01((2 - ctx.irregularities) / 2) * 0.7,
      weight: 4,
      hint: 'Ідеально рівний текст без жодних відхилень трапляється рідко.'
    });

    return sig;
  }

  function scoreFromSignals(signals) {
    var w = 0, s = 0;
    for (var i = 0; i < signals.length; i++) {
      w += signals[i].weight;
      s += signals[i].weight * signals[i].score;
    }
    return w ? (s / w) * 100 : 0;
  }

  function verdictFor(score) {
    if (score >= 72) return { level: 'bad', label: 'Висока ймовірність AI-генерації' };
    if (score >= 52) return { level: 'warn', label: 'Ймовірно AI або сильно відредагований AI-текст' };
    if (score >= 32) return { level: 'warn', label: 'Змішані ознаки: частина тексту виглядає машинною' };
    return { level: 'ok', label: 'Ознаки AI слабо виражені' };
  }

  function paragraphRisk(paragraphs) {
    var res = [];
    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i];
      var words = tokenize(p);
      if (words.length < 40) continue;
      var sents = splitSentences(p).map(function (s) { return tokenize(s).length; }).filter(function (x) { return x > 0; });
      var m = mean(sents), sd = stdev(sents);
      var cv = m ? sd / m : 0;
      var lex = lexicalStats(words);
      var lower = p.toLowerCase();
      var cl = countPhrases(lower, CLICHE).total;
      var score = 0;
      score += clamp01((0.5 - cv) / 0.35) * 40;
      score += clamp01((m - 17) / 12) * 15;
      score += clamp01((0.55 - lex.ttr) / 0.25) * 20;
      score += clamp01(cl / 2) * 25;
      res.push({
        index: i + 1,
        words: words.length,
        score: Math.round(score),
        preview: p.slice(0, 180).replace(/\s+/g, ' ') + (p.length > 180 ? '…' : '')
      });
    }
    res.sort(function (a, b) { return b.score - a.score; });
    return res.slice(0, 10);
  }

  // ------------------------------------------------- речення для зовнішньої перевірки

  var STOP = new Set(('і та й в у на з із зі до для що як це той ця те них він вона воно ми ви вони не ні але або чи бути є був була були буде щоб про при від над під між по за через але також так тому щодо якщо коли the a an of and to in is are was were for on with that this by as at from be or it its'.split(/\s+/)));

  function pickCheckSentences(sentences, limit) {
    limit = limit || 12;
    var scored = [];
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      var w = tokenize(s);
      if (w.length < 8 || w.length > 30) continue;
      if (/[0-9]{4}/.test(s) === false && w.length < 10) continue;
      var content = 0, longW = 0;
      for (var j = 0; j < w.length; j++) {
        if (!STOP.has(w[j])) content++;
        if (w[j].length >= 9) longW++;
      }
      var score = content / w.length + longW * 0.08 + (/[0-9]/.test(s) ? 0.25 : 0);
      scored.push({ text: s.replace(/\s+/g, ' ').trim(), score: score, at: i });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    // рівномірно по тексту: беремо найкращі, але не поспіль
    var seen = new Set();
    var used = [];
    var out = [];

    function tryTake(item, checkAdjacent) {
      if (out.length >= limit) return;
      var key = item.text.toLowerCase().replace(/[^a-zа-яёїієґ0-9 ]/gi, '');
      if (seen.has(key)) return;
      if (checkAdjacent) {
        for (var u = 0; u < used.length; u++) if (Math.abs(used[u] - item.at) < 3) return;
      }
      seen.add(key);
      used.push(item.at);
      out.push(item.text);
    }

    for (var k = 0; k < scored.length && out.length < limit; k++) tryTake(scored[k], true);
    for (var k2 = 0; k2 < scored.length && out.length < limit; k2++) tryTake(scored[k2], false);
    return out;
  }

  // ------------------------------------------------- головний аналіз

  function analyze(rawText, options, progress) {
    options = options || {};
    progress = progress || function () {};
    var text = normalize(rawText);

    progress(5, 'Підготовка тексту');
    var words = tokenize(text);
    var wordCount = words.length;
    if (wordCount < 30) throw new Error('Замало тексту для аналізу — потрібно щонайменше 30 слів.');

    progress(15, 'Розбір на речення та абзаци');
    var sentences = splitSentences(text);
    var paragraphs = splitParagraphs(text);
    var sentLens = sentences.map(function (s) { return tokenize(s).length; }).filter(function (x) { return x > 0; });
    var paraLens = paragraphs.map(function (p) { return tokenize(p).length; }).filter(function (x) { return x > 0; });

    progress(30, 'Лексична статистика');
    var lex = lexicalStats(words);
    var mtldValue = wordCount <= 400000 ? mtld(words) : 0;

    progress(45, 'Пошук шаблонних конструкцій');
    var lower = text.toLowerCase();
    var cliche = countPhrases(lower, CLICHE);
    var discourse = countPhrases(lower, DISCOURSE);
    var hedges = countPhrases(lower, HEDGES);
    var firstPerson = countPhrases(lower, FIRST_PERSON).total;

    var punctTypes = ['—', '–', ';', ':', '(', '«', '?', '!'];
    var punctVariety = 0;
    for (var pi = 0; pi < punctTypes.length; pi++) if (text.indexOf(punctTypes[pi]) !== -1) punctVariety++;
    var numbers = (text.match(/\b\d[\d.,]*\b/g) || []).length;
    var citations = (text.match(/\[\s*\d+\s*\]|\(\s*[А-ЯA-Z][^()]{2,40}\s*,\s*\d{4}\s*\)/g) || []).length;
    var irregularities = (text.match(/ {2,}/g) || []).length + (text.match(/,[^\s]/g) || []).length + (text.match(/!\?|\?!/g) || []).length;

    progress(58, 'Аналіз повторюваності n-грам');
    var tri = shingleHashes(words, 3);
    var triSeen = new Set();
    var triRepeat = 0;
    for (var t = 0; t < tri.length; t++) {
      if (triSeen.has(tri[t])) triRepeat++;
      else triSeen.add(tri[t]);
    }

    progress(70, 'Пошук внутрішніх повторів (антиплагіат)');
    var dup = internalDuplication(words, options.shingle || 6, options.minBlock || 8);

    progress(85, 'Оцінка AI-ознак');
    var ctx = {
      wordCount: wordCount,
      sentMean: mean(sentLens),
      sentStd: stdev(sentLens),
      paraMean: mean(paraLens),
      paraStd: stdev(paraLens),
      paragraphCount: paragraphs.length,
      lex: lex,
      mtldValue: mtldValue,
      cliche: cliche,
      discourse: discourse,
      hedges: hedges,
      firstPerson: firstPerson,
      punctVariety: punctVariety,
      numbers: numbers,
      citations: citations,
      irregularities: irregularities,
      trigramRepeat: tri.length ? triRepeat / tri.length : 0
    };
    var signals = aiSignals(ctx);
    var aiScore = scoreFromSignals(signals);

    progress(94, 'Формування звіту');
    var uniqueness = Math.max(0, 100 - dup.coverage * 100);

    var result = {
      stats: {
        chars: text.length,
        charsNoSpaces: text.replace(/\s/g, '').length,
        words: wordCount,
        uniqueWords: lex.unique,
        sentences: sentences.length,
        paragraphs: paragraphs.length,
        avgSentence: round(ctx.sentMean, 1),
        sentenceStd: round(ctx.sentStd, 1),
        ttr: round(lex.ttr * 100, 1),
        mtld: round(mtldValue, 1),
        pages: round(text.length / 1800, 1),
        readingMinutes: Math.max(1, Math.round(wordCount / 180))
      },
      plagiarism: {
        internalCoverage: round(dup.coverage * 100, 2),
        internalUniqueness: round(uniqueness, 2),
        duplicateShingles: dup.duplicateShingles,
        totalShingles: dup.shingles,
        blocks: dup.blocks,
        topWords: lex.topWords
      },
      ai: {
        score: Math.round(aiScore),
        verdict: verdictFor(aiScore),
        signals: signals.map(function (s) {
          return { name: s.name, display: s.display, risk: Math.round(s.score * 100), weight: s.weight, hint: s.hint };
        }),
        cliches: cliche.found.slice(0, 15),
        discourse: discourse.found.slice(0, 10),
        paragraphRisk: paragraphRisk(paragraphs)
      },
      external: {
        sentences: pickCheckSentences(sentences, options.checkSentences || 12)
      }
    };

    if (options.sources && options.sources.length) {
      progress(97, 'Порівняння з джерелами');
      result.sources = compareWithSources(words, options.sources, options.crossShingle || 5);
    }

    progress(100, 'Готово');
    return result;
  }

  var api = {
    analyze: analyze,
    tokenize: tokenize,
    splitSentences: splitSentences,
    splitParagraphs: splitParagraphs,
    internalDuplication: internalDuplication,
    compareWithSources: compareWithSources,
    normalize: normalize
  };

  global.KursovaAnalyzer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
