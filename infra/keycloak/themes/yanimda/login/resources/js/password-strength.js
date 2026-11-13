/*
 * T-081 (ASVS 2.1.8) parola gücü göstergesi. Bağımlılıksız; yalnız kayıt ve parola güncelleme formlarında.
 * Kural (sunucu politikasıyla tutarlı, yalnız yol gösterir; asıl denetim Keycloak'ta: length(12), kara liste):
 *   - en az `min` (12) karakter yoksa 0
 *   - uzunluk ≥ min: 1, ≥ min+4: 2, ≥ min+8: 3; en az 3 karakter sınıfı veya 3+ sözcüklü cümle: +1
 *   - yaygın sözcük, klavye/rakam sırası, tekrar (aaa) veya az çeşitli karakter: −2
 * Metinler window.YANIMDA_STRENGTH_I18N'den (strength-i18n.js, packages/messages/tr.json'dan üretilir).
 */
(function (root) {
  'use strict';

  var COMMON = [
    'password',
    'passw0rd',
    'parola',
    'sifre',
    'şifre',
    'qwerty',
    'yanimda',
    'yanımda',
    'admin',
    'welcome',
    'letmein',
    'iloveyou',
    'seniseviyorum',
    'galatasaray',
    'fenerbahce',
    'fenerbahçe',
    'besiktas',
    'beşiktaş',
    'trabzonspor',
    'istanbul',
    'turkiye',
    'türkiye',
    'ataturk',
    'atatürk',
    'bismillah',
  ];
  var SEQUENCES = [
    '01234567890',
    'abcdefghijklmnopqrstuvwxyz',
    'qwertyuiop',
    'qwertyuıopğü',
    'asdfghjkl',
    'asdfghjklşi',
    'zxcvbnm',
    'zxcvbnmöç',
    '1qaz2wsx3edc4rfv',
    '1q2w3e4r5t6y7u8i9o0p',
  ];

  function hasSequence(lower) {
    for (var i = 0; i < SEQUENCES.length; i++) {
      var s = SEQUENCES[i];
      var r = s.split('').reverse().join('');
      for (var j = 0; j + 4 <= s.length; j++) {
        if (lower.indexOf(s.substr(j, 4)) >= 0 || lower.indexOf(r.substr(j, 4)) >= 0) return true;
      }
    }
    return false;
  }

  function score(password, min) {
    var chars = Array.from(password || '');
    var len = chars.length;
    var result = { score: 0, short: len < min, weak: false };
    if (!len) return result;
    var lower = password.toLocaleLowerCase('tr');
    var unique = new Set(chars).size;
    result.weak =
      /(.)\1\1/u.test(password) ||
      hasSequence(lower) ||
      unique < Math.ceil(len / 3) ||
      COMMON.some(function (w) {
        return lower.indexOf(w) >= 0;
      });
    if (result.short) return result;
    var s = 1;
    if (len >= min + 4) s++;
    if (len >= min + 8) s++;
    var classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u].filter(function (re) {
      return re.test(password);
    }).length;
    var words = password.trim().split(/\s+/).length;
    if (classes >= 3 || words >= 3) s++;
    if (result.weak) s -= 2;
    result.score = Math.max(0, Math.min(4, s));
    return result;
  }

  function fill(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] !== undefined ? String(vars[k]) : '{' + k + '}';
    });
  }

  function attach(doc, input, t) {
    var group = input.closest('.pf-v5-c-form__group') || input.parentElement;
    var box = doc.createElement('div');
    box.className = 'yanimda-strength';
    box.setAttribute('data-score', '0');
    box.setAttribute('data-empty', 'true');
    var bar = doc.createElement('div');
    bar.className = 'yanimda-strength__bar';
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '4');
    bar.setAttribute('aria-valuenow', '0');
    for (var i = 0; i < 4; i++) bar.appendChild(doc.createElement('span'));
    var text = doc.createElement('div');
    text.className = 'yanimda-strength__text';
    text.setAttribute('aria-live', 'polite');
    var hint = doc.createElement('div');
    hint.className = 'yanimda-strength__hint';
    hint.textContent = t.hintGeneral;
    box.appendChild(bar);
    box.appendChild(text);
    box.appendChild(hint);
    group.appendChild(box);
    input.setAttribute(
      'aria-describedby',
      ((input.getAttribute('aria-describedby') || '') + ' yanimda-strength').trim(),
    );
    text.id = 'yanimda-strength';

    function update() {
      var r = score(input.value, t.min);
      var level = t['level' + r.score];
      box.setAttribute('data-score', String(r.score));
      box.setAttribute('data-empty', input.value ? 'false' : 'true');
      bar.setAttribute('aria-valuenow', String(r.score));
      bar.setAttribute('aria-valuetext', level);
      text.textContent = input.value ? fill(t.label, { level: level }) : '';
      hint.textContent = !input.value
        ? t.hintGeneral
        : r.short
          ? fill(t.hintLength, { min: t.min })
          : r.weak
            ? t.hintCommon
            : r.score < 4
              ? t.hintGeneral
              : '';
    }
    input.addEventListener('input', update);
    update();
  }

  function init(doc, t) {
    var input =
      doc.querySelector('#kc-register-form input#password') ||
      doc.querySelector('#kc-passwd-update-form input#password-new');
    if (input && t) attach(doc, input, t);
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { score: score, fill: fill };
  } else if (root && root.document) {
    var start = function () {
      init(root.document, root.YANIMDA_STRENGTH_I18N);
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof window !== 'undefined' ? window : undefined);
