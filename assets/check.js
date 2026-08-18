/* Kursova24 — інтерфейс перевірки тексту */
(function () {
  'use strict';

  var MAX_CHARS = 5000000;
  var SOFT_WARN = 1500000;

  var $ = function (id) { return document.getElementById(id); };
  var worker = null;
  var lastResult = null;
  var sources = []; // {name, text}

  // ------------------------------------------------------------ читання файлів

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Не вдалося завантажити модуль: ' + url)); };
      document.head.appendChild(s);
    });
  }

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('Помилка читання файлу ' + file.name)); };
      fr.readAsText(file, 'utf-8');
    });
  }

  function readArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('Помилка читання файлу ' + file.name)); };
      fr.readAsArrayBuffer(file);
    });
  }

  function extractFile(file) {
    var name = (file.name || '').toLowerCase();
    if (/\.(txt|md|csv|tex|rtf|html?)$/.test(name)) {
      return readAsText(file).then(function (t) {
        if (/\.html?$/.test(name)) {
          var d = document.createElement('div');
          d.innerHTML = t;
          return d.textContent || '';
        }
        if (/\.rtf$/.test(name)) return t.replace(/\\'([0-9a-f]{2})/gi, ' ').replace(/\{\\[^{}]*\}/g, ' ').replace(/\\[a-z]+-?\d* ?/gi, ' ').replace(/[{}]/g, ' ');
        return t;
      });
    }
    if (/\.docx$/.test(name)) {
      return loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js')
        .then(function () { return readArrayBuffer(file); })
        .then(function (buf) { return window.mammoth.extractRawText({ arrayBuffer: buf }); })
        .then(function (r) { return r.value || ''; });
    }
    if (/\.pdf$/.test(name)) {
      return loadScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js')
        .then(function () {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
          return readArrayBuffer(file);
        })
        .then(function (buf) { return window.pdfjsLib.getDocument({ data: buf }).promise; })
        .then(function (pdf) {
          var chain = Promise.resolve('');
          for (var p = 1; p <= pdf.numPages; p++) {
            (function (page) {
              chain = chain.then(function (acc) {
                return pdf.getPage(page).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
                  return acc + tc.items.map(function (i) { return i.str; }).join(' ') + '\n\n';
                });
              });
            })(p);
          }
          return chain;
        });
    }
    if (/\.doc$/.test(name)) return Promise.reject(new Error('Старий формат .doc не читається у браузері — збережіть як .docx або .txt'));
    return readAsText(file);
  }

  function extractFiles(files) {
    var chain = Promise.resolve([]);
    Array.prototype.forEach.call(files, function (f) {
      chain = chain.then(function (acc) {
        return extractFile(f).then(function (text) {
          acc.push({ name: f.name, text: text });
          return acc;
        });
      });
    });
    return chain;
  }

  // ------------------------------------------------------------ інтерфейс

  function showError(msg) {
    var el = $('error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(function () { el.style.display = 'none'; }, 9000);
  }

  function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function updateCounter() {
    var len = $('text').value.length;
    var el = $('counter');
    el.textContent = fmt(len) + ' символів · приблизно ' + (len / 1800).toFixed(1) + ' стор.';
    el.style.color = len > SOFT_WARN ? '#b45309' : '';
  }

  function renderSources() {
    var box = $('sourceList');
    if (!sources.length) {
      box.innerHTML = '<p class="hint">Джерел не додано. Аналіз виконається лише за внутрішніми повторами.</p>';
      return;
    }
    box.innerHTML = sources.map(function (s, i) {
      return '<div class="src-item"><div class="row"><strong style="font-size:.9rem">' + escapeHtml(s.name) + '</strong>' +
        '<button class="btn btn-sec btn-sm" data-del="' + i + '">Видалити</button></div>' +
        '<div class="hint">' + fmt(s.text.length) + ' символів</div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        sources.splice(parseInt(b.getAttribute('data-del'), 10), 1);
        renderSources();
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function levelColor(risk) {
    return risk >= 66 ? 'var(--bad)' : risk >= 33 ? 'var(--warn)' : 'var(--ok)';
  }

  // ------------------------------------------------------------ рендер результатів

  function render(r) {
    var s = r.stats, p = r.plagiarism, ai = r.ai;

    $('kpis').innerHTML =
      kpi(fmt(s.words), 'слів') +
      kpi(fmt(s.chars), 'символів') +
      kpi(s.pages, 'сторінок (≈1800 зн.)') +
      kpi(fmt(s.sentences), 'речень') +
      kpi(fmt(s.paragraphs), 'абзаців') +
      kpi(s.avgSentence + ' ± ' + s.sentenceStd, 'слів у реченні') +
      kpi(s.ttr + '%', 'різноманітність (TTR)') +
      kpi(s.mtld ? s.mtld : 'н/д', 'MTLD');

    // антиплагіат
    var uq = p.internalUniqueness;
    var uqLevel = uq >= 92 ? 'ok' : uq >= 80 ? 'warn' : 'bad';
    $('plagDial').className = 'dial bg-' + uqLevel;
    $('plagDial').innerHTML = '<span class="n">' + Math.round(uq) + '%</span><span class="u">унікальність</span>';
    $('plagSummary').innerHTML =
      '<p><strong>Внутрішні повтори:</strong> ' + p.internalCoverage + '% тексту дублює інші фрагменти цієї ж роботи ' +
      '(' + fmt(p.duplicateShingles) + ' повторних послідовностей із ' + fmt(p.totalShingles) + ').</p>' +
      '<p class="hint">Це самоплагіат і «водянисті» повтори — саме те, що знижує оригінальність у Unicheck та StrikePlagiarism. Показник не враховує зовнішні джерела з інтернету.</p>';

    $('blocks').innerHTML = p.blocks.length
      ? p.blocks.map(function (b) {
          var meta = 'Повтор ' + b.words + ' слів';
          meta += b.occurrences > 1
            ? ' · повторюється ' + (b.occurrences + 1) + ' раз(и) у тексті'
            : ' · позиції ' + fmt(b.firstAt) + ' та ' + fmt(b.repeatAt);
          return '<div class="frag"><div class="meta">' + meta + '</div>' + escapeHtml(b.text) + '</div>';
        }).join('')
      : '<p class="hint">Довгих дослівних повторів не знайдено.</p>';

    $('topWords').innerHTML = p.topWords.map(function (w) {
      return '<tr><td>' + escapeHtml(w.word) + '</td><td>' + w.count + '</td><td>' + ((w.count / s.words) * 100).toFixed(2) + '%</td></tr>';
    }).join('');

    // AI-детектор
    $('aiDial').className = 'dial bg-' + ai.verdict.level;
    $('aiDial').innerHTML = '<span class="n">' + ai.score + '</span><span class="u">AI-score / 100</span>';
    $('aiVerdict').innerHTML = '<span class="badge badge-' + ai.verdict.level + '">' + ai.verdict.label + '</span>' +
      '<p class="hint" style="margin-top:8px">Оцінка складається з 12 стилометричних ознак. Це евристика, а не доказ: людський «сухий» академічний текст теж може отримати високий бал.</p>';

    $('signals').innerHTML = ai.signals.slice().sort(function (a, b) { return b.risk - a.risk; }).map(function (g) {
      return '<tr><td><strong>' + escapeHtml(g.name) + '</strong><div class="hint">' + escapeHtml(g.display) + '</div></td>' +
        '<td style="width:120px"><div class="bar"><span style="width:' + g.risk + '%;background:' + levelColor(g.risk) + '"></span></div>' +
        '<div class="hint">' + g.risk + '/100</div></td>' +
        '<td class="hint" style="width:44%">' + escapeHtml(g.hint) + '</td></tr>';
    }).join('');

    $('paraRisk').innerHTML = ai.paragraphRisk.length
      ? ai.paragraphRisk.map(function (pr) {
          return '<div class="frag" style="border-left-color:' + levelColor(pr.score) + '">' +
            '<div class="meta">Абзац ' + pr.index + ' · ' + pr.words + ' слів · ризик ' + pr.score + '/100</div>' +
            escapeHtml(pr.preview) + '</div>';
        }).join('')
      : '<p class="hint">Замало абзаців для покомпонентної оцінки.</p>';

    $('cliches').innerHTML = ai.cliches.length
      ? ai.cliches.map(function (c) { return '<tr><td>' + escapeHtml(c.phrase) + '</td><td>' + c.count + '</td></tr>'; }).join('')
      : '<tr><td colspan="2" class="hint">Шаблонних фраз не знайдено — добре.</td></tr>';

    // джерела
    if (r.sources) {
      $('sourcesResult').style.display = 'block';
      var ov = r.sources.overall * 100;
      var ovLevel = ov >= 20 ? 'bad' : ov >= 8 ? 'warn' : 'ok';
      $('srcDial').className = 'dial bg-' + ovLevel;
      $('srcDial').innerHTML = '<span class="n">' + ov.toFixed(1) + '%</span><span class="u">збіг із джерелами</span>';
      $('srcTable').innerHTML = r.sources.perSource.map(function (x) {
        return '<tr><td>' + escapeHtml(x.name) + '</td><td>' + (x.coverage * 100).toFixed(1) + '%</td><td>' +
          (x.jaccard * 100).toFixed(1) + '%</td><td>' + fmt(x.sourceWords) + '</td></tr>';
      }).join('');
      $('srcFragments').innerHTML = r.sources.fragments.length
        ? r.sources.fragments.map(function (f) {
            return '<div class="frag" style="border-left-color:var(--bad)"><div class="meta">' + f.words + ' слів · джерело: ' + escapeHtml(f.source) + (f.occurrences > 1 ? ' · зустрічається ' + f.occurrences + ' раз(и)' : '') + '</div>' + escapeHtml(f.text) + '</div>';
          }).join('')
        : '<p class="hint">' + (ov > 0.5
            ? 'Довгих дослівних блоків немає, але ' + ov.toFixed(1) + '% тексту складається з коротких збігів (по ' + (r.sources.shingle || 5) + ' слів) — це типово для перефразованих запозичень.'
            : 'Дослівних збігів із доданими джерелами не знайдено.') + '</p>';
    } else {
      $('sourcesResult').style.display = 'none';
    }

    // зовнішня перевірка
    $('extSentences').innerHTML = (r.external.sentences.length ? '' : '<p class="hint">Не вдалося підібрати достатньо інформативних речень — текст закороткий або надто однотипний.</p>') + r.external.sentences.map(function (t) {
      var q = encodeURIComponent('"' + t.slice(0, 220) + '"');
      return '<div class="frag" style="border-left-color:var(--brand)">' + escapeHtml(t) +
        '<div class="list-links" style="margin-top:6px">' +
        '<a target="_blank" rel="noopener" href="https://www.google.com/search?q=' + q + '">Google</a>' +
        '<a target="_blank" rel="noopener" href="https://www.bing.com/search?q=' + q + '">Bing</a>' +
        '<a target="_blank" rel="noopener" href="https://duckduckgo.com/?q=' + q + '">DuckDuckGo</a>' +
        '<a target="_blank" rel="noopener" href="https://scholar.google.com/scholar?q=' + q + '">Scholar</a></div></div>';
    }).join('');

    $('recommendations').innerHTML = buildRecommendations(r).map(function (x) { return '<li>' + escapeHtml(x) + '</li>'; }).join('');

    $('results').style.display = 'block';
  }

  function kpi(v, l) {
    return '<div class="kpi"><div class="val">' + v + '</div><div class="lab">' + l + '</div></div>';
  }

  function buildRecommendations(r) {
    var out = [];
    var p = r.plagiarism, ai = r.ai;
    if (p.internalCoverage > 8) out.push('Перепишіть повторювані блоки: ' + p.internalCoverage + '% тексту дублюється всередині роботи. Почніть із найдовших фрагментів у списку нижче.');
    if (r.sources && r.sources.overall > 0.08) out.push('Збіг із доданими джерелами становить ' + (r.sources.overall * 100).toFixed(1) + '%. Перефразуйте виділені фрагменти або оформіть їх як цитати з посиланням.');
    var byKey = {};
    ai.signals.forEach(function (s) { byKey[s.name] = s; });
    ai.signals.forEach(function (s) { if (s.risk >= 60) out.push(s.name + ' — ' + s.hint); });
    if (ai.cliches.length >= 3) out.push('Приберіть або замініть шаблонні фрази: ' + ai.cliches.slice(0, 5).map(function (c) { return '«' + c.phrase + '»'; }).join(', ') + '.');
    if (ai.paragraphRisk.length && ai.paragraphRisk[0].score >= 60) out.push('Найризикованіший абзац №' + ai.paragraphRisk[0].index + ' (ризик ' + ai.paragraphRisk[0].score + '/100) — переписати вручну першим.');
    if (!out.length) out.push('Критичних проблем не виявлено. Все одно перевірте роботу в системі свого університету перед здачею.');
    out.push('Прогоніть 5–10 речень зі списку «Речення для зовнішньої перевірки» через пошук — так знаходять дослівні збіги з інтернетом.');
    return out;
  }

  // ------------------------------------------------------------ звіт

  function buildReport(r) {
    var s = r.stats, p = r.plagiarism, ai = r.ai;
    var L = [];
    L.push('# Звіт перевірки тексту — Kursova24');
    L.push('');
    L.push('Дата: ' + new Date().toLocaleString('uk-UA'));
    L.push('');
    L.push('## Статистика');
    L.push('- Символів: ' + s.chars + ' (без пробілів: ' + s.charsNoSpaces + ')');
    L.push('- Слів: ' + s.words + ', унікальних: ' + s.uniqueWords);
    L.push('- Речень: ' + s.sentences + ', абзаців: ' + s.paragraphs);
    L.push('- Сторінок (≈1800 знаків): ' + s.pages);
    L.push('- Середня довжина речення: ' + s.avgSentence + ' ± ' + s.sentenceStd + ' слів');
    L.push('- TTR: ' + s.ttr + '%, MTLD: ' + s.mtld);
    L.push('');
    L.push('## Антиплагіат (внутрішні повтори)');
    L.push('- Умовна внутрішня унікальність: ' + p.internalUniqueness + '%');
    L.push('- Дубльовано тексту: ' + p.internalCoverage + '%');
    L.push('- Повторних послідовностей: ' + p.duplicateShingles + ' з ' + p.totalShingles);
    if (p.blocks.length) {
      L.push('');
      L.push('### Найдовші повтори');
      p.blocks.forEach(function (b, i) { L.push((i + 1) + '. (' + b.words + ' слів' + (b.occurrences > 1 ? ', ×' + (b.occurrences + 1) : '') + ') ' + b.text); });
    }
    if (r.sources) {
      L.push('');
      L.push('## Порівняння з джерелами');
      L.push('- Загальний збіг: ' + (r.sources.overall * 100).toFixed(1) + '%');
      r.sources.perSource.forEach(function (x) {
        L.push('- ' + x.name + ': покриття ' + (x.coverage * 100).toFixed(1) + '%, Jaccard ' + (x.jaccard * 100).toFixed(1) + '%');
      });
      if (r.sources.fragments.length) {
        L.push('');
        L.push('### Фрагменти-збіги');
        r.sources.fragments.forEach(function (f, i) { L.push((i + 1) + '. [' + f.source + ', ' + f.words + ' слів' + (f.occurrences > 1 ? ', ×' + f.occurrences : '') + '] ' + f.text); });
      }
    }
    L.push('');
    L.push('## AI-детектор');
    L.push('- AI-score: ' + ai.score + '/100 — ' + ai.verdict.label);
    L.push('');
    L.push('| Ознака | Значення | Ризик |');
    L.push('|---|---|---|');
    ai.signals.forEach(function (g) { L.push('| ' + g.name + ' | ' + g.display + ' | ' + g.risk + '/100 |'); });
    if (ai.cliches.length) {
      L.push('');
      L.push('### Шаблонні фрази');
      ai.cliches.forEach(function (c) { L.push('- «' + c.phrase + '» — ' + c.count + ' раз(и)'); });
    }
    if (ai.paragraphRisk.length) {
      L.push('');
      L.push('### Абзаци з найвищим ризиком');
      ai.paragraphRisk.forEach(function (pr) { L.push('- Абзац ' + pr.index + ' (' + pr.words + ' слів): ризик ' + pr.score + '/100 — ' + pr.preview); });
    }
    L.push('');
    L.push('## Рекомендації');
    buildRecommendations(r).forEach(function (x) { L.push('- ' + x); });
    L.push('');
    L.push('## Речення для зовнішньої перевірки');
    r.external.sentences.forEach(function (t, i) { L.push((i + 1) + '. ' + t); });
    L.push('');
    L.push('---');
    L.push('Звіт створено локально у браузері. Це не заміна офіційним системам (Unicheck, StrikePlagiarism) і не юридичний доказ авторства.');
    return L.join('\n');
  }

  // ------------------------------------------------------------ запуск

  function run() {
    var text = $('text').value;
    if (text.trim().length < 200) { showError('Вставте більше тексту — потрібно щонайменше 200 символів.'); return; }
    if (text.length > MAX_CHARS) { showError('Текст завеликий (' + fmt(text.length) + ' символів). Максимум — ' + fmt(MAX_CHARS) + '.'); return; }

    if (worker) { worker.terminate(); worker = null; }
    try {
      worker = new Worker('assets/analyzer.worker.js');
    } catch (e) {
      showError('Браузер не дозволив запустити фоновий аналіз. Спробуйте інший браузер.');
      return;
    }

    $('runBtn').disabled = true;
    $('progressWrap').style.display = 'block';
    $('results').style.display = 'none';
    setProgress(2, 'Старт');

    worker.onmessage = function (e) {
      var d = e.data;
      if (d.type === 'progress') setProgress(d.percent, d.stage);
      else if (d.type === 'done') {
        lastResult = d.result;
        setProgress(100, 'Готово');
        render(d.result);
        $('runBtn').disabled = false;
        setTimeout(function () { $('progressWrap').style.display = 'none'; }, 600);
        worker.terminate(); worker = null;
        $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (d.type === 'error') {
        showError(d.message);
        $('runBtn').disabled = false;
        $('progressWrap').style.display = 'none';
        worker.terminate(); worker = null;
      }
    };
    worker.onerror = function () {
      showError('Помилка фонового аналізу. Перезавантажте сторінку і спробуйте ще раз.');
      $('runBtn').disabled = false;
      $('progressWrap').style.display = 'none';
    };

    worker.postMessage({
      cmd: 'analyze',
      text: text,
      options: {
        shingle: parseInt($('sensitivity').value, 10),
        minBlock: parseInt($('sensitivity').value, 10) + 2,
        crossShingle: Math.max(4, parseInt($('sensitivity').value, 10) - 1),
        checkSentences: 12,
        sources: sources
      }
    });
  }

  function setProgress(pc, stage) {
    $('progressBar').style.width = pc + '%';
    $('progressLabel').textContent = stage + ' — ' + pc + '%';
  }

  // ------------------------------------------------------------ ініціалізація

  document.addEventListener('DOMContentLoaded', function () {
    updateCounter();
    renderSources();

    $('text').addEventListener('input', updateCounter);
    $('runBtn').addEventListener('click', run);

    $('mainFile').addEventListener('change', function (e) {
      var files = e.target.files;
      if (!files || !files.length) return;
      $('mainFileHint').textContent = 'Читаю файли…';
      extractFiles(files).then(function (list) {
        var joined = list.map(function (x) { return x.text; }).join('\n\n');
        $('text').value = joined;
        updateCounter();
        $('mainFileHint').textContent = 'Завантажено: ' + list.map(function (x) { return x.name; }).join(', ');
      }).catch(function (err) {
        $('mainFileHint').textContent = '';
        showError(err.message);
      });
      e.target.value = '';
    });

    $('srcFile').addEventListener('change', function (e) {
      var files = e.target.files;
      if (!files || !files.length) return;
      $('srcFileHint').textContent = 'Читаю файли…';
      extractFiles(files).then(function (list) {
        list.forEach(function (x) { if (x.text.trim().length > 50) sources.push(x); });
        renderSources();
        $('srcFileHint').textContent = 'Додано джерел: ' + list.length;
      }).catch(function (err) {
        $('srcFileHint').textContent = '';
        showError(err.message);
      });
      e.target.value = '';
    });

    $('addSrcText').addEventListener('click', function () {
      var t = $('srcText').value.trim();
      if (t.length < 50) { showError('Текст джерела закороткий — потрібно щонайменше 50 символів.'); return; }
      sources.push({ name: 'Вставлений текст ' + (sources.length + 1), text: t });
      $('srcText').value = '';
      renderSources();
    });

    $('clearSrc').addEventListener('click', function () { sources = []; renderSources(); });

    $('downloadReport').addEventListener('click', function () {
      if (!lastResult) return;
      var blob = new Blob([buildReport(lastResult)], { type: 'text/markdown;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'kursova24-zvit-perevirky.md';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    });

    $('copyReport').addEventListener('click', function () {
      if (!lastResult) return;
      var txt = buildReport(lastResult);
      if (navigator.clipboard) {
        navigator.clipboard.writeText(txt).then(function () {
          $('copyReport').textContent = 'Скопійовано';
          setTimeout(function () { $('copyReport').textContent = 'Копіювати звіт'; }, 2000);
        });
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        var target = t.getAttribute('data-panel');
        Array.prototype.forEach.call(document.querySelectorAll('[data-panel-body]'), function (b) {
          b.style.display = b.getAttribute('data-panel-body') === target ? 'block' : 'none';
        });
      });
    });
  });
})();
