// Display settings shared by play.html and games.html: the title banner and the CREDIT / BET / WIN LCD, each shown or hidden,
// the banner as the name over the attract art, the name alone or the art alone, the LCD in one of five backlight colours.
// games.html sets them for play.html (how a game opens); its own strip is only the totals LCD. One localStorage key (mk6-ui) holds them all; every read and write is wrapped, so a browser without storage still gets the defaults.
// The defaults show the banner (name over the art) and the green LCD. UIPREFS.apply() sets classes on #marquee and #lcd (ui/marquee.css
// does the rest) and fires a 'mk6-ui' event on the document so a page can refit its layout; UIPREFS.panel(host) adds the ⚙ Display control.
(function () {
  'use strict';
  const KEY = 'mk6-ui';
  const DEFAULTS = Object.freeze({ banner: true, bannerStyle: 'art', lcd: true, lcdTheme: 'green' });
  const BANNER_STYLES = ['art', 'name', 'artonly'], LCD_THEMES = ['green', 'amber', 'blue', 'white', 'red'];
  const clean = o => {
    const p = Object.assign({}, DEFAULTS, o && typeof o === 'object' ? o : {});
    p.banner = !!p.banner; p.lcd = !!p.lcd;
    if (!BANNER_STYLES.includes(p.bannerStyle)) p.bannerStyle = DEFAULTS.bannerStyle;
    if (!LCD_THEMES.includes(p.lcdTheme)) p.lcdTheme = DEFAULTS.lcdTheme;
    return p;
  };
  const load = () => { try { return clean(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return clean(null); } };
  const save = p => { try { localStorage.setItem(KEY, JSON.stringify(clean(p))); } catch (e) {} };
  const apply = p => {
    p = clean(p || load());
    const mq = document.getElementById('marquee'), lcd = document.getElementById('lcd');
    // games.html (data-list): the settings are for how a game opens; the list itself keeps only its totals LCD, no banner
    const list = !!(mq && mq.dataset.list);
    if (mq && list) { mq.classList.add('nobanner'); mq.classList.remove('noart', 'notitle', 'nolcd'); }
    if (mq && !list) {
      mq.classList.toggle('nobanner', !p.banner);
      mq.classList.toggle('noart', p.banner && p.bannerStyle === 'name');
      mq.classList.toggle('notitle', p.banner && p.bannerStyle === 'artonly');
      mq.classList.toggle('nolcd', !p.lcd);
    }
    if (lcd) { lcd.hidden = !p.lcd && !list; if (p.lcdTheme === 'green') lcd.removeAttribute('data-theme'); else lcd.dataset.theme = p.lcdTheme; }
    document.dispatchEvent(new CustomEvent('mk6-ui', { detail: p }));
    return p;
  };
  // the control: a ⚙ Display button with a small panel under it; the page puts it where its other controls are
  const CSS = `.uiprefs { position:relative; display:inline-block; }
  .uiprefs > summary { list-style:none; cursor:pointer; user-select:none; }
  .uiprefs > summary::-webkit-details-marker { display:none; }
  .uiprefs .pane { position:absolute; z-index:30; top:calc(100% + 6px); right:0; min-width:230px; padding:10px 12px; border-radius:8px; background:#1a0f06; color:#f2e3bd;
    border:1px solid #6b4318; box-shadow:0 10px 30px rgba(0,0,0,.6); font:13px/1.5 system-ui, sans-serif; text-align:left; }
  .uiprefs .pane label { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:2px 0; cursor:pointer; white-space:nowrap; }
  .uiprefs .pane select { font:inherit; color:inherit; background:#0f0804; border:1px solid #6b4318; border-radius:5px; padding:2px 5px; max-width:150px; }
  .uiprefs .pane input[type=checkbox] { margin:0; accent-color:#ffd862; }
  .uiprefs .pane hr { border:0; border-top:1px solid #3b2814; margin:7px 0; }
  .uiprefs .pane button { font:inherit; color:inherit; background:#2a1a0c; border:1px solid #6b4318; border-radius:5px; padding:2px 9px; cursor:pointer; }
  .uiprefs .pane h5 { margin:0 0 4px; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:#b9a37a; }`;
  const panel = (host, opts) => {
    opts = opts || {};
    if (!document.getElementById('uiprefs-css')) { const st = document.createElement('style'); st.id = 'uiprefs-css'; st.textContent = CSS; document.head.appendChild(st); }
    const d = document.createElement('details'); d.className = 'uiprefs'; d.id = 'uiprefs';
    d.innerHTML = `<summary class="${opts.summaryClass || ''}" title="${opts.list ? 'How a game opens (banner and LCD) and the statistics' : 'Banner and LCD display settings'}, remembered in this browser" aria-label="${opts.list ? 'Menu' : 'Display settings'}"><span aria-hidden="true">${opts.list ? '☰' : '⚙'}</span><span class="lbl"> ${opts.list ? 'Menu' : 'Display'}</span></summary>
      <div class="pane"><h5>${opts.list ? 'When a game opens' : 'Display'}</h5>
      <label>Banner <input type="checkbox" id="ui-banner"></label>
      <label>Banner shows <select id="ui-bannerstyle"><option value="art">Name over the art</option><option value="name">Name only</option><option value="artonly">Art only</option></select></label>
      <hr><label>LCD panel <input type="checkbox" id="ui-lcd"></label>
      <label>LCD colour <select id="ui-lcdtheme"><option value="green">Green</option><option value="amber">Amber</option><option value="blue">Blue</option><option value="white">White</option><option value="red">Red</option></select></label>
      <hr><label><span>${opts.list ? 'Display settings' : 'Saved in this browser'}</span><button type="button" id="ui-reset">Reset</button></label></div>`;
    host.appendChild(d);
    const $ = id => d.querySelector('#' + id);
    const show = p => { $('ui-banner').checked = p.banner; $('ui-bannerstyle').value = p.bannerStyle; $('ui-bannerstyle').disabled = !p.banner; $('ui-lcd').checked = p.lcd; $('ui-lcdtheme').value = p.lcdTheme; $('ui-lcdtheme').disabled = !p.lcd; };
    const read = () => ({ banner: $('ui-banner').checked, bannerStyle: $('ui-bannerstyle').value, lcd: $('ui-lcd').checked, lcdTheme: $('ui-lcdtheme').value });
    d.addEventListener('change', () => { const p = read(); save(p); show(apply(p)); });
    $('ui-reset').onclick = () => { save(DEFAULTS); show(apply(DEFAULTS)); };
    document.addEventListener('pointerdown', e => { if (d.open && !d.contains(e.target)) d.open = false; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && d.open) d.open = false; });
    show(load());
    return d;
  };
  window.UIPREFS = { KEY, DEFAULTS, load, save, apply, panel };
})();
