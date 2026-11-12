// Optional CRT mode (ported from felixweb): the 640x480 game canvas is uploaded as a WebGL texture and redrawn with
// barrel distortion, scanlines, RGB phosphor mask, bloom and vignette, inside a glossy black cabinet bezel (CSS).
(function () {
  'use strict';
  const KEY = 'qotn-crt-v1';
  const CURVE = { off: [0, 0, 1.04], small: [0.012, 0.022, 1.035], medium: [0.024, 0.044, 1.055], large: [0.035, 0.065, 1.075] };   // as in felixweb: [side, top/bottom curvature, picture zoom]
  const GLOW = { off: 0, light: 0.12, medium: 0.28, strong: 0.5 };
  const opt = { on: false, curve: 'small', glow: 'medium', scan: true };
  try { Object.assign(opt, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) {}
  const qs = new URLSearchParams(location.search);
  if (qs.has('crt')) opt.on = true; if (qs.has('nocrt')) opt.on = false;

  let cv, glc, stage, gl = null, prog, tex, U = {};

  function init() {
    if (gl || gl === false) return !!gl;
    try { gl = glc.getContext('webgl', { alpha: false, antialias: false }); } catch (e) { gl = null; }
    if (!gl) { gl = false; return false; }
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }'));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `precision highp float; varying vec2 uv; uniform sampler2D t; uniform vec2 res, curve; uniform float time, zoom, glow, scan;
        void main(){
          vec2 c = (uv*2.-1.) * zoom;
          vec2 s = vec2(c.x*(1.+curve.x*c.y*c.y), c.y*(1.+curve.y*c.x*c.x));          // barrel distortion
          vec2 a = abs(s);
          float edge = (1.-smoothstep(0.995,1.0,a.x)) * (1.-smoothstep(0.995,1.0,a.y));
          vec2 q = clamp(s*0.5+0.5, 0., 1.);
          vec3 col = texture2D(t, q).rgb;
          if (glow > 0.) {                                                              // bloom: soft taps, added back where bright
            vec2 d = vec2(2.2/640., 2.2/480.); vec3 b = vec3(0.);
            b += texture2D(t, q+vec2(d.x,0.)).rgb + texture2D(t, q-vec2(d.x,0.)).rgb + texture2D(t, q+vec2(0.,d.y)).rgb + texture2D(t, q-vec2(0.,d.y)).rgb;
            b += 0.7*(texture2D(t, q+d).rgb + texture2D(t, q-d).rgb + texture2D(t, q+vec2(d.x,-d.y)).rgb + texture2D(t, q+vec2(-d.x,d.y)).rgb);
            b /= 6.8; col += max(b - 0.2, 0.) * glow * 1.6;
          }
          if (scan > 0.) {
            float P = max(3., floor(res.y/190.));                                          // period in device pixels, aligned to the screen grid (no moire)
            float sl = mod(gl_FragCoord.y, P) < P/3. ? 0.80 : 1.0;                       // one thin dark row per P
            float px = gl_FragCoord.x;
            vec3 mask = vec3(1.) - 0.07*vec3(mod(px,3.)<1.?1.:0., mod(px,3.)>=1.&&mod(px,3.)<2.?1.:0., mod(px,3.)>=2.?1.:0.);
            col *= sl * mask * 1.16;
          }
          col = mix(vec3(dot(col,vec3(.299,.587,.114))), col, 1.12);
          col *= 1.0 - 0.38*pow(length(c*vec2(0.8,0.95)), 3.0);                         // vignette
          col *= 0.99 + 0.01*sin(time*50.);
          gl_FragColor = vec4(col*edge, 1.);
        }`));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { console.warn('CRT shader unavailable:', e); gl = false; return false; }
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    for (const n of ['res', 'time', 't', 'curve', 'zoom', 'glow', 'scan']) U[n] = gl.getUniformLocation(prog, n);
    return true;
  }

  function draw() {
    if (!opt.on || !gl) return;
    const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (glc.width !== w || glc.height !== h) { glc.width = w; glc.height = h; }
    gl.viewport(0, 0, w, h); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, cv);
    const c = CURVE[opt.curve] || CURVE.small;
    gl.uniform1i(U.t, 0); gl.uniform2f(U.res, w, h); gl.uniform1f(U.time, (performance.now() % 1000) / 1000);
    gl.uniform2f(U.curve, c[0], c[1]); gl.uniform1f(U.zoom, c[2]);
    gl.uniform1f(U.glow, GLOW[opt.glow] === undefined ? GLOW.medium : GLOW[opt.glow]); gl.uniform1f(U.scan, opt.scan ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function apply() {
    const bezel = document.getElementById('bezel'), ok = opt.on && init();
    bezel.classList.toggle('crt', opt.on); stage.classList.toggle('gl', ok);
    document.getElementById('crtbtn').textContent = 'CRT: ' + (opt.on ? 'on' : 'off');
    document.querySelectorAll('.crtopt').forEach(e => e.style.display = opt.on ? '' : 'none');
    try { localStorage.setItem(KEY, JSON.stringify(opt)); } catch (e) {}
    draw();
  }

  // cabinet decal "PLAY UP TO 20 LINES": recreated as SVG from the 20 payline patterns (ROM help screen 3)
  const COL = ['#2ee05a','#ff9a2e','#ff3b30','#3bd16f','#1fb23d','#f2e22e','#ff8a1e','#2e6bff','#a02bd6','#2a3bff','#e22bd6','#bcbcbc','#d9822e','#2ec8ff','#ff7a7a','#ff5a8a','#8a3bd6','#ff3ba0','#25c4a0','#e8e84a'];
  function stickerSVG() {
    const L = (window.QOTN && QOTN.lines) || [], x0 = 26, dx = 13.5, R = (window.QOTN && QOTN.rows) || 3, gy = Array.from({ length: R }, (_, i) => 84 + i * 76 / (R - 1)), top = 50, NL = L.length || 20;
    let s = `<svg viewBox="0 0 100 214" xmlns="http://www.w3.org/2000/svg"><path d="M2 2H98V186L50 211L2 186Z" fill="#050505" stroke="#f2c500" stroke-width="3" stroke-linejoin="round"/>
      <text x="50" y="23" text-anchor="middle" font-family="Impact,Arial Black,sans-serif" font-size="13" fill="#ff3340" stroke="#fff" stroke-width=".7" paint-order="stroke">PLAY UP TO</text>
      <text x="50" y="40" text-anchor="middle" font-family="Impact,Arial Black,sans-serif" font-size="17" fill="#ff3340" stroke="#fff" stroke-width=".7" paint-order="stroke">${NL} LINES</text>
      <rect x="22" y="${top + 8}" width="62" height="128" fill="#d9c9a5" opacity=".95"/>`;
    for (let r = 0; r < 5; r++) s += `<line x1="${x0 + dx * r}" y1="${top + 8}" x2="${x0 + dx * r}" y2="${top + 136}" stroke="#8a7a58" stroke-width=".5"/>`;
    L.forEach((rows, i) => {
      const pts = rows.map((row, r) => `${x0 + dx * r - 5 + 5},${gy[row] + ((i * 7) % 11 - 5) * 1.5}`).join(' ');
      s += `<polyline points="${pts}" fill="none" stroke="${COL[i % COL.length]}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
    gy.forEach((_, row) => {                                                  // line numbers by the row each line starts in (left edge)
      const ns = L.map((l, i) => [l[0], i + 1]).filter(p => p[0] === row).map(p => p[1]);
      s += `<text x="19" y="${gy[row] - 14}" text-anchor="end" font-family="Arial,sans-serif" font-size="5.2" font-weight="700" fill="#e8d8b0">${ns.map((n, k) => `<tspan x="19" dy="${k ? 6 : 0}">${n}</tspan>`).join('')}</text>`;
    });
    return s + '<text x="50" y="203" text-anchor="middle" font-family="Arial,sans-serif" font-size="5" fill="#f2c500">' + String((window.QOTN && QOTN.title) || 'Queen of the Nile').toUpperCase().replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text></svg>';
  }

  window.QotnCRT = {
    draw, opt,
    // where on the game canvas (fractions 0..1, from the top left) the point at fractions fx, fy of the stage lies: the shader's own mapping (barrel distortion and zoom),
    // so touches on a curved picture reach the right place; the point itself when the effect is off
    unwarp(fx, fy) {
      if (!stage || !stage.classList.contains('gl')) return [fx, fy];
      const c = CURVE[opt.curve] || CURVE.small, X = (fx * 2 - 1) * c[2], Y = ((1 - fy) * 2 - 1) * c[2];
      const sx = X * (1 + c[0] * Y * Y), sy = Y * (1 + c[1] * X * X);
      return [sx * 0.5 + 0.5, 1 - (sy * 0.5 + 0.5)];
    },
    setup(canvas, glCanvas, stageEl) {
      cv = canvas; glc = glCanvas; stage = stageEl;
      const st = document.createElement('div'); st.id = 'sticker'; st.innerHTML = stickerSVG(); document.getElementById('bezel').appendChild(st);
      const $ = id => document.getElementById(id);
      $('crtbtn').onclick = () => { opt.on = !opt.on; apply(); };
      $('crtcurve').value = opt.curve; $('crtglow').value = opt.glow; $('crtscan').checked = opt.scan;
      $('crtcurve').onchange = e => { opt.curve = e.target.value; apply(); };
      $('crtglow').onchange = e => { opt.glow = e.target.value; apply(); };
      $('crtscan').onchange = e => { opt.scan = e.target.checked; apply(); };
      apply();
    },
  };
})();
