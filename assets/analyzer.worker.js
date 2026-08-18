/* Kursova24 — воркер аналізу. Уся важка обробка тут, щоб інтерфейс не підвисав. */
self.importScripts('analyzer-core.js');

self.onmessage = function (e) {
  var data = e.data || {};
  if (data.cmd !== 'analyze') return;
  try {
    var result = self.KursovaAnalyzer.analyze(data.text, data.options || {}, function (percent, stage) {
      self.postMessage({ type: 'progress', percent: percent, stage: stage });
    });
    self.postMessage({ type: 'done', result: result });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || 'Невідома помилка аналізу' });
  }
};
