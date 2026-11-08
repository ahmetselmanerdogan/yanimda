const tr = require('./tr.json');
const catalogs = { tr };
module.exports = {
  catalogs,
  t: (code, lang = 'tr', vars = {}) => {
    const tpl = (catalogs[lang] || tr)[code];
    if (!tpl) throw new Error(`Mesaj kataloğunda yok: ${code}`);
    return tpl.text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
  },
};
