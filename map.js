// 交通データ夜景図の描画エンジン（WebGL）。
//
// 描くのは鉄道597路線の折れ線と、バス停・シェアサイクルポート・港・空港など
// 約30万点。2D Canvas の fillRect では拡大時に描画が詰まるため、
// 頂点バッファを一度GPUへ送り、以降はユニフォームだけを更新する。
// 1フレームあたりの描画命令は十数回で済む。
(function () {
  'use strict';

  // 状態は色で表す。交通機関の別は形と大きさで表す。
  var STATUS = ['通年オープン', '期間限定', 'ODPT外にあり', 'データなし'];
  var RGB = {
    '通年オープン': [0.294, 0.859, 0.969],
    '期間限定': [0.961, 0.722, 0.333],
    'ODPT外にあり': [0.557, 0.482, 0.878],
    'データなし': [0.227, 0.337, 0.439]
  };
  // 画面に出す名前。データ側のキーは触らず、表示だけを「所在」の言い方に揃える
  var LABEL = {
    '通年オープン': 'ODPT',
    '期間限定': 'ODPT（期間限定）',
    'ODPT外にあり': 'ODPT外',
    'データなし': 'なし'
  };
  var HEX = {
    '通年オープン': '#4BDBF7', '期間限定': '#F5B855',
    'ODPT外にあり': '#8E7BE0', 'データなし': '#3A5670'
  };

  function mx(lon) { return (lon + 180) / 360; }
  function my(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  function decode(flat) {
    // 差分整数（緯度, 経度）から投影済み座標へ
    var n = flat.length / 2, a = new Float32Array(n * 2), la = 0, lo = 0;
    for (var i = 0; i < n; i++) {
      la += flat[i * 2];
      lo += flat[i * 2 + 1];
      a[i * 2] = mx(lo / 1e4);
      a[i * 2 + 1] = my(la / 1e4);
    }
    return a;
  }

  // ── データ ────────────────────────────────────────────
  var RAIL = JSON.parse(document.getElementById('rail').textContent).features.map(function (f) {
    var bb = [1, 1, 0, 0];
    var parts = f.geometry.coordinates.map(function (ln) {
      var a = new Float32Array(ln.length * 2);
      for (var i = 0; i < ln.length; i++) {
        var x = mx(ln[i][0]), y = my(ln[i][1]);
        a[i * 2] = x; a[i * 2 + 1] = y;
        if (x < bb[0]) bb[0] = x;
        if (y < bb[1]) bb[1] = y;
        if (x > bb[2]) bb[2] = x;
        if (y > bb[3]) bb[3] = y;
      }
      return a;
    });
    return { p: f.properties, parts: parts, bb: bb };
  });

  var BUS_RANK = ['通年オープン', '期間限定', 'ODPT外にあり', 'データなし'];
  var SUMMARY = JSON.parse(document.getElementById('summary').textContent);
  var BUSPTS = {}, BUS_NAMES = {};
  (function () {
    var raw = JSON.parse(document.getElementById('bus').textContent);
    var tab = raw.optab || [];
    Object.keys(raw.pts).forEach(function (k) {
      var st = BUS_RANK[+k];
      BUSPTS[st] = decode(raw.pts[k]);
      BUS_NAMES[st] = (raw.ops[k] || []).map(function (i) { return tab[i] || ''; });
    });
  })();
  var LAYERS = JSON.parse(document.getElementById('layers').textContent);

  // 海岸線。背景地図タイルは読めないので、日本の形は自前で敷く
  var COAST = decode(JSON.parse(document.getElementById('coast').textContent));
  // 県境（内陸部分のみ）。海岸線と二重に描かないよう、海に近い線は落としてある
  var PREF = decode(JSON.parse(document.getElementById('pref').textContent));

  // 交通機関ごとの表示定義。
  // n は所在別の実数 [ODPT, ODPT（期間限定）, ODPT外, なし]。
  // total が null のモードは全国の母集団が無く、割合を出せない。
  var MODES = [
    { id: 'rail', label: '鉄道', type: 'line' },
    { id: 'bus', label: 'バス', type: 'point', size: 1.3 },
    { id: 'air', label: '航空', type: 'point', size: 5.5, ring: true, halo: true },
    { id: 'cycle', label: 'シェアサイクル', type: 'point', size: 1.6 },
    { id: 'ferry', label: 'フェリー', type: 'point', size: 4.5, ring: true, halo: true },
    { id: 'demand', label: 'デマンド交通', type: 'point', size: 3.0, ring: true, halo: true },
    { id: 'coast', label: '海岸線・県境', type: 'base', unit: '', n: null, total: null }
  ];

  MODES.forEach(function (m) {
    var d = SUMMARY[m.id];
    if (d) { m.n = d.n; m.total = d.total; m.unit = d.unit; }
  });
  var on = {};
  MODES.forEach(function (m) { on[m.id] = true; });

  // ── WebGL ──────────────────────────────────────────────
  var cv = document.getElementById('map');
  // preserveDrawingBuffer を立てておく。無いと合成後にバッファが消え、
  // 画像として保存できない（右クリックで保存も、資料用の書き出しもできない）。
  // 静止画を描き直す使い方なので、速度の代償はほぼ無い。
  var GLOPT = { antialias: true, alpha: false, premultipliedAlpha: false,
                preserveDrawingBuffer: true };
  var gl = cv.getContext('webgl', GLOPT) || cv.getContext('experimental-webgl', GLOPT);
  if (!gl) {
    cv.style.display = 'none';
    document.getElementById('fallback').style.display = 'grid';
    return;
  }

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('シェーダのコンパイルに失敗:', gl.getShaderInfoLog(s));
    }
    return s;
  }
  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('シェーダのリンクに失敗:', gl.getProgramInfoLog(p));
    }
    return p;
  }

  var VS = [
    'attribute vec2 a_pos;',
    'uniform vec2 u_center;',
    'uniform float u_scale;',   // メルカトル単位あたりのCSSピクセル
    'uniform vec2 u_res;',      // CSSピクセルでのキャンバス寸法
    'uniform vec2 u_off;',      // 太さを稼ぐための微小オフセット（px）
    'uniform float u_size;',
    'void main(){',
    '  vec2 px = (a_pos - u_center) * u_scale + u_res * 0.5 + u_off;',
    '  vec2 cl = vec2(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0);',
    '  gl_Position = vec4(cl, 0.0, 1.0);',
    '  gl_PointSize = u_size;',
    '}'
  ].join('\n');

  var FS_POINT = [
    'precision mediump float;',
    'uniform vec4 u_color;',
    'uniform float u_round;',
    'void main(){',
    '  if (u_round > 0.5) {',
    '    vec2 d = gl_PointCoord - vec2(0.5);',
    '    if (dot(d, d) > 0.25) discard;',
    '  }',
    '  gl_FragColor = u_color;',
    '}'
  ].join('\n');

  var prog = program(VS, FS_POINT);
  var A_POS = gl.getAttribLocation(prog, 'a_pos');
  var U = {};
  ['u_center', 'u_scale', 'u_res', 'u_off', 'u_size', 'u_color', 'u_round'].forEach(function (n) {
    U[n] = gl.getUniformLocation(prog, n);
  });

  function buffer(arr) {
    var b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    return { buf: b, n: arr.length / 2 };
  }

  // 鉄道は GL_LINES 用に線分の対へ展開する
  var RAIL_BUF = {};
  STATUS.forEach(function (s) {
    var segs = [];
    RAIL.forEach(function (f) {
      if (f.p.s !== s) return;
      f.parts.forEach(function (a) {
        for (var i = 0; i + 3 < a.length; i += 2) {
          segs.push(a[i], a[i + 1], a[i + 2], a[i + 3]);
        }
      });
    });
    if (segs.length) RAIL_BUF[s] = buffer(new Float32Array(segs));
  });
  var HOVER_BUF = { buf: gl.createBuffer(), n: 0 };
  var COAST_BUF = COAST.length ? buffer(COAST) : null;
  var PREF_BUF = PREF.length ? buffer(PREF) : null;

  var PT_BUF = { bus: {}, air: {}, cycle: {}, ferry: {}, demand: {} };
  Object.keys(BUSPTS).forEach(function (s) {
    if (BUSPTS[s].length) PT_BUF.bus[s] = buffer(BUSPTS[s]);
  });
  // 点の実体（投影済み座標と名前）。ホバーで名前を出すために保持する
  var PT_DATA = { bus: {}, air: {}, cycle: {}, ferry: {}, demand: {} };
  var RANK_KEY = { '0': '通年オープン', '1': '期間限定', '2': 'ODPT外にあり', '3': 'データなし' };
  ['air', 'cycle', 'ferry', 'demand'].forEach(function (id) {
    var L = LAYERS[id];
    if (!L) return;
    Object.keys(L.pts).forEach(function (k) {
      var a = decode(L.pts[k]);
      if (!a.length) return;
      var st = RANK_KEY[k];
      PT_BUF[id][st] = buffer(a);
      PT_DATA[id][st] = { xy: a, names: (L.names && L.names[k]) || [] };
    });
  });
  Object.keys(BUSPTS).forEach(function (st) {
    if (BUSPTS[st].length) PT_DATA.bus[st] = { xy: BUSPTS[st], names: BUS_NAMES[st] || [] };
  });

  // ── チャレンジで使える、公共交通以外のデータ ──────────────
  // ほこナビと PLATEAU。**所在の4分類には載せない。**
  // ODPT にあるか否かという問いの外側にあるデータで、母集団も定義できない。
  // 別の色で「あるかないか」だけを示す。
  // 連携先（気象庁・警察庁・e-Stat 等）は全国一律なので地図にしても真っ白になる。
  var EXTRA = JSON.parse(document.getElementById('extra').textContent);
  var EXTRA_IDS = ['hokonavi', 'plateau'];
  var EXTRA_ST = '—';        // ORDER4 に無いキー。所在の絞り込みを素通りする
  var EXTRA_HEX = { hokonavi: '#4FC98A', plateau: '#DB6EA8' };
  var EXTRA_RGB = { hokonavi: [0.310, 0.788, 0.541], plateau: [0.859, 0.431, 0.659] };
  EXTRA_IDS.forEach(function (id) {
    var a = decode(EXTRA[id].pts);
    on[id] = true;
    PT_BUF[id] = {};
    PT_DATA[id] = {};
    if (!a.length) return;
    PT_BUF[id][EXTRA_ST] = buffer(a);
    PT_DATA[id][EXTRA_ST] = { xy: a, names: EXTRA[id].names || [] };
  });

  // ── 観光資源のエリアと、データ空白の重なり ──────────────
  // 国土数値情報 P12 の面・線を輪郭として描き、周囲2km に通年で使える
  // 交通データがあるかで塗り分ける。**「観光地なのにデータが無い」**を言うため。
  // P12 は入込客数を持たないので、人気の大小は言わない。
  var TOUR = JSON.parse(document.getElementById('tourism').textContent);
  // **「データが無い空白」と「交通が無い空白」は別。** 3つに分ける。
  //   data … 近くにオープンデータがある（ODPT 通年・期間限定・ODPT外のいずれか）
  //   gap  … バス停や駅はあるが、データが無い ← 公開されれば案内できる
  //   none … バス停も駅も無い。データの問題ではない
  var TOUR_IDS = ['gap', 'none', 'data'];      // 描く順。主役の gap を最後に
  var TOUR_HEX = { gap: '#FF7A6B', none: '#C2707C', data: '#55707E' };
  var TOUR_RGB = {
    gap: [1.0, 0.478, 0.420], none: [0.761, 0.439, 0.486], data: [0.333, 0.439, 0.494]
  };
  var TOUR_SEG = {};
  TOUR_IDS.forEach(function (id) {
    var seg = decode(TOUR[id].segs);
    if (seg.length) TOUR_SEG[id] = buffer(seg);
    var a = decode(TOUR[id].pts);
    PT_BUF['tour_' + id] = {};
    PT_DATA['tour_' + id] = {};
    on['tour_' + id] = false;   // 表示と同じトグルで開け閉めする
    if (!a.length) return;
    // 輪郭だけだと全国表示では細すぎて見えない。代表点も一緒に描く
    PT_BUF['tour_' + id][EXTRA_ST] = buffer(a);
    PT_DATA['tour_' + id][EXTRA_ST] = { xy: a, names: TOUR[id].names || [] };
  });

  // 画面上で最も近い点を拾う。格子はメルカトル座標で切る
  var PCELL = 0.0012;
  var PIDX = {};
  Object.keys(PT_DATA).forEach(function (id) {
    Object.keys(PT_DATA[id]).forEach(function (st) {
      var a = PT_DATA[id][st].xy;
      for (var i = 0; i < a.length; i += 2) {
        var k = Math.floor(a[i] / PCELL) + ':' + Math.floor(a[i + 1] / PCELL);
        (PIDX[k] || (PIDX[k] = [])).push([id, st, i]);
      }
    });
  });
  var TOUCH_TOL = 20;      // 指は太い。当たり判定を広げる
  function pickPoint(px, py, tolPx) {
    var tol = (tolPx || 8) / view.k;
    var wx = (px - W / 2) / view.k + view.x, wy = (py - H / 2) / view.k + view.y;
    var cy = Math.floor(wx / PCELL), cx = Math.floor(wy / PCELL);
    var best = null, bd = tol * tol;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var list = PIDX[(cy + dy) + ':' + (cx + dx)];
        if (!list) continue;
        for (var n = 0; n < list.length; n++) {
          var id = list[n][0], st = list[n][1], i = list[n][2];
          if (!on[id] || offStatus[st]) continue;
          var a = PT_DATA[id][st].xy;
          var ex = wx - a[i], ey = wy - a[i + 1], d = ex * ex + ey * ey;
          if (d < bd) {
            bd = d;
            best = { mode: id, status: st, name: PT_DATA[id][st].names[i / 2] || '', idx: i / 2 };
          }
        }
      }
    }
    return best;
  }

  // ── 表示状態 ────────────────────────────────────────────
  var W = 0, H = 0, dpr = 1;
  var view = { x: 0, y: 0, k: 1 };
  var hover = null, hoverPt = null, hoverPtKey = null;
  var offStatus = {};      // 状態ごとの絞り込み

  function envelope(list) {
    return list.reduce(function (b, f) {
      return [Math.min(b[0], f.bb[0]), Math.min(b[1], f.bb[1]),
              Math.max(b[2], f.bb[2]), Math.max(b[3], f.bb[3])];
    }, [1, 1, 0, 0]);
  }
  // 沖縄は本土から遠く、まとめて収めると本土が小さくなりすぎる
  var MAIN = envelope(RAIL.filter(function (f) { return f.bb[1] < my(30.5); }));

  var headerEl = document.querySelector('header');
  var sideEl = document.getElementById('side');
  function resize() {
    // ヘッダの高さは文字数やフォント読み込みで変わる。CSSで決め打ちせず実測して、
    // 地図と左パネルがちょうど残りを埋めるようにする。
    var used = headerEl ? headerEl.getBoundingClientRect().height : 0;
    var h = Math.max(300, Math.round(window.innerHeight - used));
    cv.style.height = h + 'px';
    if (sideEl && window.innerWidth > 900) sideEl.style.height = h + 'px';
    else if (sideEl) sideEl.style.height = '';
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = cv.clientWidth || 800;
    H = cv.clientHeight || 500;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    gl.viewport(0, 0, cv.width, cv.height);
  }
  function baseScale() {
    return Math.min((W - 40) / (MAIN[2] - MAIN[0]), (H - 40) / (MAIN[3] - MAIN[1]));
  }
  function fit() {
    var pad = Math.max(18, Math.min(56, W * 0.05));
    view.k = Math.min((W - pad * 2) / (MAIN[2] - MAIN[0]),
                      (H - pad * 2) / (MAIN[3] - MAIN[1]));
    view.x = (MAIN[0] + MAIN[2]) / 2;
    view.y = (MAIN[1] + MAIN[3]) / 2;
  }
  function zoomRatio() { return view.k / baseScale(); }

  function setUniforms() {
    gl.uniform2f(U.u_center, view.x, view.y);
    gl.uniform1f(U.u_scale, view.k);
    gl.uniform2f(U.u_res, W, H);
  }
  function drawBuf(b, mode, color, alpha, size, off, round) {
    if (!b || !b.n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
    gl.enableVertexAttribArray(A_POS);
    gl.vertexAttribPointer(A_POS, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(U.u_color, color[0], color[1], color[2], alpha);
    gl.uniform1f(U.u_size, size * dpr);
    gl.uniform2f(U.u_off, off ? off[0] : 0, off ? off[1] : 0);
    gl.uniform1f(U.u_round, round ? 1 : 0);
    gl.drawArrays(mode, 0, b.n);
  }

  // 線幅は WebGL では 1px しか当てにできないので、微小にずらした複数回の描画で
  // 太さを作る。**ずらす量は拡大率に比例させない。** 比例させると拡大時に
  // 数px開いてしまい、太った線ではなく平行な2本に見える。
  var HALO = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  function halo(i, ws) {
    var d = Math.min(ws, 1.4) * 0.55;      // 高々0.8px。太さとして読める範囲に留める
    return [HALO[i][0] * d, HALO[i][1] * d];
  }

  function draw() {
    gl.clearColor(0.027, 0.047, 0.067, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    setUniforms();
    gl.enable(gl.BLEND);

    var z = zoomRatio();
    var ws = Math.max(1, Math.min(4.5, Math.pow(z, 0.55)));

    // 海岸線は交通機関より下に敷く。1pxのままだと上に載る点群に埋もれるので、
    // 微小にずらした2回描きで太らせ、輪郭として読める明るさにする。
    // 色は暖色寄りのニュートラル。交通データは全て寒色なので、色相で
    // 「土台」と「データ」を分ける。青灰にすると「データなし」と混ざる。
    if (on.coast && COAST_BUF) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      var cc = [0.243, 0.233, 0.216];
      // 上下左右にごく僅かずらして太らせる。斜め1方向だけだと二重線に見える
      for (var ci = 1; ci < HALO.length; ci++) {
        drawBuf(COAST_BUF, gl.LINES, cc, 0.45, 1, halo(ci, ws), false);
      }
      drawBuf(COAST_BUF, gl.LINES, cc, 1, 1, null, false);
      // 県境は海岸線より一段暗く。位置の手がかりであって主役ではない
      if (PREF_BUF) drawBuf(PREF_BUF, gl.LINES, [0.180, 0.171, 0.157], 1, 1, null, false);
    }

    // 暗いものを先に、明るいものを後に重ねる
    var order = ['データなし', 'ODPT外にあり', '期間限定', '通年オープン'];

    order.forEach(function (s) {
      if (offStatus[s]) return;
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      if (on.rail && RAIL_BUF[s]) {
        var c = RGB[s];
        if (s === 'データなし') {
          drawBuf(RAIL_BUF[s], gl.LINES, c, 0.9, 1, null, false);
        } else {
          // 加算を重ねすぎると白に飽和するので、暈しはごく薄くする
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
          for (var i = 1; i < HALO.length; i++) {
            drawBuf(RAIL_BUF[s], gl.LINES, c, 0.10, 1, halo(i, ws), false);
          }
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          drawBuf(RAIL_BUF[s], gl.LINES, c, 0.95, 1, null, false);
        }
      }

      MODES.forEach(function (m) {
        if (m.type !== 'point' || !on[m.id]) return;
        var b = PT_BUF[m.id] && PT_BUF[m.id][s];
        if (!b) return;
        var size = Math.max(m.size, Math.min(m.size * 6, m.size * Math.pow(z, 0.62)));
        if (s === 'データなし') {
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          drawBuf(b, gl.POINTS, RGB[s], 0.9, size, null, !!m.ring);
        } else {
          // 点数の多いレイヤーに暈しを付けると、割合が実際より多く見える
          if (m.halo) {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
            drawBuf(b, gl.POINTS, RGB[s], 0.10, size * 2.2, null, true);
          }
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          drawBuf(b, gl.POINTS, RGB[s], 0.92, size, null, !!m.ring);
        }
      });
    });

    // 観光エリア。3つの分類はそれぞれ独立に開け閉めできる
    TOUR_IDS.forEach(function (id) {
      if (!on['tour_' + id]) return;
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      var seg = TOUR_SEG[id];
      if (seg) {
        if (id === 'gap') {
          for (var ti = 1; ti < HALO.length; ti++) {
            drawBuf(seg, gl.LINES, TOUR_RGB[id], 0.30, 1, halo(ti, ws), false);
          }
        }
        drawBuf(seg, gl.LINES, TOUR_RGB[id], id === 'data' ? 0.55 : 0.95, 1,
                null, false);
      }
      var pb = PT_BUF['tour_' + id] && PT_BUF['tour_' + id][EXTRA_ST];
      if (!pb) return;
      // 「停留所なし」は162件しかない。同じ大きさだと単独で見たとき消える
      var base = id === 'gap' ? 3.4 : (id === 'none' ? 3.0 : 2.4);
      var psz = Math.max(base, Math.min(base * 5, base * Math.pow(z, 0.55)));
      if (id !== 'data') {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        drawBuf(pb, gl.POINTS, TOUR_RGB[id], id === 'gap' ? 0.16 : 0.13,
                psz * 2.4, null, true);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      drawBuf(pb, gl.POINTS, TOUR_RGB[id], id === 'data' ? 0.5 : 0.9, psz,
              null, true);
    });

    // 公共交通以外のデータ。交通機関より下に置くと埋もれるので、上に薄く重ねる
    EXTRA_IDS.forEach(function (id) {
      var b = PT_BUF[id] && PT_BUF[id][EXTRA_ST];
      if (!on[id] || !b) return;
      var sz = id === 'plateau' ? 4.0 : 1.8;
      var size = Math.max(sz, Math.min(sz * 6, sz * Math.pow(z, 0.62)));
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      drawBuf(b, gl.POINTS, EXTRA_RGB[id], 0.12, size * 2.2, null, true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      drawBuf(b, gl.POINTS, EXTRA_RGB[id], 0.9, size, null, true);
    });

    // 海岸線をごく薄く上からもなぞる。下に敷くだけだと密な点群に埋もれて
    // 輪郭が読めなくなるため。濃度は低く保ち、データと見紛わせないようにする。
    if (on.coast && COAST_BUF) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      drawBuf(COAST_BUF, gl.LINES, [0.451, 0.431, 0.400], 0.24, 1, null, false);
      if (PREF_BUF) drawBuf(PREF_BUF, gl.LINES, [0.380, 0.361, 0.333], 0.17, 1, null, false);
    }

    // 選んだ系統。ほかを暗く沈めてから、その系統の停留所だけを上から描く。
    // **色は所在の色のまま。** 白い縁で「この系統」を示し、中の色で所在を示す。
    if (sel && sel.count && on.bus) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      var x0 = view.x - W / 2 / view.k, x1 = view.x + W / 2 / view.k;
      var y0 = view.y - H / 2 / view.k, y1 = view.y + H / 2 / view.k;
      gl.bindBuffer(gl.ARRAY_BUFFER, DIM_BUF.buf);
      gl.bufferData(gl.ARRAY_BUFFER,
                    new Float32Array([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]),
                    gl.DYNAMIC_DRAW);
      DIM_BUF.n = 6;
      drawBuf(DIM_BUF, gl.TRIANGLES, [0.027, 0.047, 0.067], 0.62, 1, null, false);
      var rs = Math.max(3.2, Math.min(12, 3.2 * Math.pow(z, 0.45)));
      order.forEach(function (s) {
        var b = SEL_BUF[s];
        if (!b || !b.n || offStatus[s]) return;
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        drawBuf(b, gl.POINTS, [1, 1, 1], 0.10, rs * 3.2, null, true);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        drawBuf(b, gl.POINTS, [0.92, 0.95, 0.97], 0.95, rs + 2.4, null, true);
        drawBuf(b, gl.POINTS, RGB[s], 1, rs, null, true);
      });
    }

    if (hover && on.rail) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (var j = 0; j < HALO.length; j++) {
        drawBuf(HOVER_BUF, gl.LINES, [1, 1, 1], j === 0 ? 1 : 0.5, 1, halo(j, ws), false);
      }
    }
  }

  var pending = false;
  function render() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; draw(); });
  }

  // ── 当たり判定（鉄道のみ）──────────────────────────────
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, t = 0;
    if (dx || dy) {
      t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
    }
    var ex = px - (ax + t * dx), ey = py - (ay + t * dy);
    return ex * ex + ey * ey;
  }
  function pick(px, py, tolPx) {
    var tol = (tolPx || 7) / view.k, best = null, bd = tol * tol;
    var wx = (px - W / 2) / view.k + view.x, wy = (py - H / 2) / view.k + view.y;
    for (var n = 0; n < RAIL.length; n++) {
      var f = RAIL[n], b = f.bb;
      if (offStatus[f.p.s]) continue;
      if (wx < b[0] - tol || wx > b[2] + tol || wy < b[1] - tol || wy > b[3] + tol) continue;
      for (var i = 0; i < f.parts.length; i++) {
        var a = f.parts[i];
        for (var j = 0; j < a.length - 2; j += 2) {
          var d = segDist(wx, wy, a[j], a[j + 1], a[j + 2], a[j + 3]);
          if (d < bd) { bd = d; best = f; }
        }
      }
    }
    return best;
  }
  function setHover(f) {
    hover = f;
    if (!f) { HOVER_BUF.n = 0; return; }
    var segs = [];
    f.parts.forEach(function (a) {
      for (var i = 0; i + 3 < a.length; i += 2) segs.push(a[i], a[i + 1], a[i + 2], a[i + 3]);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, HOVER_BUF.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segs), gl.DYNAMIC_DRAW);
    HOVER_BUF.n = segs.length / 2;
  }

  // ── 情報パネル ──────────────────────────────────────────
  var info = document.getElementById('info');
  var HINT = '<p class="hint">路線や停留所にカーソルを合わせる（スマホはタップ）と、'
           + '事業者名とデータの所在が出ます。'
           + 'バス停を押すと、同じ系統の停留所がまとめて光ります。</p>';
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function showInfo(f) {
    if (!f) { info.innerHTML = HINT; return; }
    var p = f.p, extra = '';
    if (p.s === 'ODPT外にあり' && p.g) extra += '<dt>公開元</dt><dd>' + esc(p.g) + '</dd>';
    if (p.o) extra += '<dt>ODPT</dt><dd class="mono">' + esc(p.o) + '</dd>';
    var st = LABEL[p.s];
    if (p.s === '期間限定') {
      // 期間限定が消えたあと、他所にデータがあれば残り、無ければ完全に失われる
      extra += '<dt>2027-03-13 以降</dt><dd style="color:' + HEX[p.a] + '">' +
               esc(LABEL[p.a]) + '</dd>';
    }
    info.innerHTML =
      '<p class="ttl">' + esc(p.line) + '</p>' +
      '<span class="badge" style="color:' + HEX[p.s] + '">' + esc(st) + '</span>' +
      '<dl><dt>データの所在</dt><dd>' + esc(LABEL[p.s]) + '</dd>' +
      '<dt>運営会社</dt><dd>' + esc(p.op) + '</dd>' +
      '<dt>種別</dt><dd>' + esc(p.k) + '</dd>' +
      '<dt>駅数</dt><dd class="mono">' + p.n + '</dd>' + extra + '</dl>';
  }

  var MODE_LABEL = {};

  function showPointInfo(pt) {
    if (!pt) { showInfo(null); return; }
    var parts = (pt.name || '').split('｜');
    var head = parts[0] || MODE_LABEL[pt.mode] || '';
    var sub = parts.slice(1).filter(Boolean).join(' / ');
    // 観光資源。データの所在ではなく、近くに交通データがあるかを出す
    if (pt.mode.indexOf('tour_') === 0) {
      var tk = pt.mode.slice(5);
      var TL = TOUR[tk].label;
      // parts[2] に最寄りのバス停が入っている。
      // 「なし」でも停留所そのものはあることが多く、そこを見せないと
      // 「バス停が無い」と誤読される
      var stop = parts[2] || '';
      info.innerHTML =
        '<p class="ttl">' + esc(head) + '</p>' +
        '<span class="badge" style="color:' + TOUR_HEX[tk] + '">' +
        TL + '</span>' +
        '<dl><dt>種別</dt><dd>' + esc(parts[1] || '観光資源') + '</dd>' +
        '<dt>意味</dt><dd>' + TOUR[tk].long + '</dd>' +
        (stop ? '<dt>' + (tk === 'gap' ? '最寄りの停留所' : '判定に使った停留所') +
                '</dt><dd>' + esc(stop) + '</dd>' : '') +
        '<dt>見た範囲</dt><dd>輪郭から2km。ODPT（通年・期間限定）と ODPT外</dd></dl>' +
        (tk === 'gap'
          ? '<p class="tnote">停留所や駅は現にあります。時刻表が機械可読な形で' +
            '公開されていないだけで、公開されればその日から案内が作れます。' +
            'ODPT に無いという意味ではなく、gtfs-data.jp 等にも無いという意味です。</p>'
          : tk === 'none'
          ? '<p class="tnote">2km以内に停留所も駅もありません。' +
            'データではなく、交通そのものの空白です。</p>' : '');
      return;
    }
    // 公共交通以外のデータは所在の軸に載らない。何のデータかだけを出す
    if (EXTRA_HEX[pt.mode]) {
      info.innerHTML =
        '<p class="ttl">' + esc(head) + '</p>' +
        '<span class="badge" style="color:' + EXTRA_HEX[pt.mode] + '">' +
        esc(EXTRA[pt.mode].label) + '</span>' +
        '<dl><dt>種類</dt><dd>' + esc(sub || EXTRA[pt.mode].label) + '</dd>' +
        '<dt>公開範囲</dt><dd class="mono">' +
        EXTRA[pt.mode].count.toLocaleString('ja-JP') + ' ' +
        esc(EXTRA[pt.mode].unit) + '</dd></dl>';
      return;
    }
    info.innerHTML =
      '<p class="ttl">' + esc(head || MODE_LABEL[pt.mode]) + '</p>' +
      '<span class="badge" style="color:' + HEX[pt.status] + '">' +
      esc(LABEL[pt.status]) + '</span>' +
      '<dl><dt>交通機関</dt><dd>' + esc(MODE_LABEL[pt.mode]) + '</dd>' +
      (sub ? '<dt>事業者</dt><dd>' + esc(sub) + '</dd>' : '') + '</dl>';
  }

  // ── 系統 ────────────────────────────────────────────────
  // バス停を選ぶと、**同じ系統の停留所をまとめて光らせる。**
  // 系統名は国土数値情報 P11（2022年）のもので、所在に関係なく全停留所に付いている。
  // P11 は停留所の順番を持たないので、**線では結ばない。** 結ぶには順番を推測するしかない。
  // データ（2.7MB）は初めて選んだときに読む。最初の表示を重くしないため。
  var ROUTES = null, ROUTES_WAIT = null;
  var sel = null;            // { g, pt, list: [系統番号], k: 見ている系統, count, bb }
  var SEL_BUF = {};          // 選んだ系統の点。所在ごと
  var DIM_BUF = { buf: gl.createBuffer(), n: 0 };

  // 点の通し番号。build_map_data.py と同じく、所在の順に数える
  var BUS_OFF = {}, BUS_N = 0;
  BUS_RANK.forEach(function (s) {
    BUS_OFF[s] = BUS_N;
    BUS_N += BUSPTS[s] ? BUSPTS[s].length / 2 : 0;
  });
  function busStatusOf(g) {
    for (var r = BUS_RANK.length - 1; r >= 0; r--) {
      if (g >= BUS_OFF[BUS_RANK[r]]) return BUS_RANK[r];
    }
    return BUS_RANK[0];
  }

  function loadRoutes() {
    if (ROUTES) return Promise.resolve(ROUTES);
    if (ROUTES_WAIT) return ROUTES_WAIT;
    ROUTES_WAIT = fetch('routes.json').then(function (res) {
      if (!res.ok) throw new Error('routes.json ' + res.status);
      return res.json();
    }).then(function (d) {
      // 地図と別の回に作った routes.json だと、番号が別の停留所を指してしまう
      if (d.n !== BUS_N) throw new Error('routes.json の停留所数が地図と違う');
      // 停留所 → 系統 の逆引きを、詰めた配列で一度だけ作る
      var cnt = new Int32Array(BUS_N + 1), m = d.m, i, j, g;
      for (i = 0; i < m.length; i++) {
        g = 0;
        for (j = 0; j < m[i].length; j++) { g += m[i][j]; cnt[g + 1]++; }
      }
      for (i = 0; i < BUS_N; i++) cnt[i + 1] += cnt[i];
      var at = cnt.slice(0, BUS_N), ids = new Int32Array(cnt[BUS_N]);
      for (i = 0; i < m.length; i++) {
        g = 0;
        for (j = 0; j < m[i].length; j++) { g += m[i][j]; ids[at[g]++] = i; }
      }
      ROUTES = { ops: d.ops, routes: d.routes, m: m, start: cnt, ids: ids };
      return ROUTES;
    });
    // 失敗したら、次に選んだときに読み直す
    ROUTES_WAIT.catch(function () { ROUTES_WAIT = null; });
    return ROUTES_WAIT;
  }

  function selectStop(pt) {
    var g = BUS_OFF[pt.status] + pt.idx;
    sel = { g: g, pt: pt, list: [], k: 0 };
    BUS_RANK.forEach(function (s) { if (SEL_BUF[s]) SEL_BUF[s].n = 0; });
    showPointInfo(pt);
    info.insertAdjacentHTML('beforeend',
      '<div class="rt"><p class="rt-nums">系統を読み込んでいます…</p></div>');
    loadRoutes().then(function (R) {
      if (!sel || sel.g !== g) return;         // 待つ間に別の停留所を選んだ
      var list = [];
      for (var i = R.start[g]; i < R.start[g + 1]; i++) list.push(R.ids[i]);
      // 停留所の多い系統を先に。本線が頭に来る
      list.sort(function (a, b) { return R.m[b].length - R.m[a].length; });
      sel.list = list;
      if (list.length) setRoute(0);
      else showRoute();
    }, function (err) {
      if (!sel || sel.g !== g) return;
      console.error('系統を読み込めない:', err);
      sel.failed = true;
      showRoute();
    });
  }

  function setRoute(k) {
    sel.k = k;
    var d = ROUTES.m[sel.list[k]], per = {}, bb = [1, 1, 0, 0], g = 0;
    BUS_RANK.forEach(function (s) { per[s] = []; });
    for (var j = 0; j < d.length; j++) {
      g += d[j];
      var s = busStatusOf(g), i = (g - BUS_OFF[s]) * 2;
      var x = BUSPTS[s][i], y = BUSPTS[s][i + 1];
      per[s].push(x, y);
      if (x < bb[0]) bb[0] = x;
      if (y < bb[1]) bb[1] = y;
      if (x > bb[2]) bb[2] = x;
      if (y > bb[3]) bb[3] = y;
    }
    sel.bb = bb;
    sel.count = {};
    BUS_RANK.forEach(function (s) {
      sel.count[s] = per[s].length / 2;
      var b = SEL_BUF[s] || (SEL_BUF[s] = { buf: gl.createBuffer(), n: 0 });
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(per[s]), gl.DYNAMIC_DRAW);
      b.n = per[s].length / 2;
    });
    showRoute();
    render();
  }

  function clearRoute() {
    if (!sel) return;
    sel = null;
    BUS_RANK.forEach(function (s) { if (SEL_BUF[s]) SEL_BUF[s].n = 0; });
    render();
  }

  function showRoute() {
    if (!sel) return;
    showPointInfo(sel.pt);
    var h;
    if (sel.failed) {
      h = '<p class="rt-nums">系統のデータを読み込めませんでした。</p>';
    } else if (!sel.list.length) {
      h = '<p class="rt-nums">この停留所には系統名がありません。</p>';
    } else {
      var R = ROUTES, rt = R.routes[sel.list[sel.k]], c = sel.count, n = 0, lit = 0;
      ORDER4.forEach(function (s) {
        n += c[s];
        if (s !== 'データなし') lit += c[s];
      });
      var bar = ORDER4.map(function (s) {
        return c[s] ? '<i style="width:' + (c[s] / n * 100).toFixed(2) +
                      '%;background:' + HEX[s] + '"></i>' : '';
      }).join('');
      var nums = ORDER4.filter(function (s) { return c[s]; }).map(function (s) {
        return '<span style="color:' + HEX[s] + '">' + esc(LABEL[s]) + ' ' + fmt(c[s]) + '</span>';
      }).join('　');
      var pick = sel.list.length < 2 ? '' :
        '<div class="rt-pick" role="group" aria-label="この停留所を通る系統">' +
        sel.list.map(function (id, k) {
          return '<button type="button" data-k="' + k + '" aria-pressed="' + (k === sel.k) + '">' +
                 esc(R.routes[id][1]) + '</button>';
        }).join('') + '</div>';
      h = '<div class="rt-h"><b>系統 ' + esc(rt[1]) + '</b><span>' + esc(R.ops[rt[0]]) + '</span></div>' +
          pick +
          '<div class="rt-bar">' + bar + '</div>' +
          '<p class="rt-nums">停留所 ' + fmt(n) + '　うちデータあり ' + fmt(lit) + '<br>' + nums + '</p>' +
          '<div class="rt-act"><button type="button" data-act="fit">この系統に寄る</button>' +
          '<button type="button" data-act="close">閉じる</button></div>';
    }
    info.insertAdjacentHTML('beforeend', '<div class="rt">' + h + '</div>' +
      '<p class="tnote">系統名は国土数値情報 P11（2022年）のもので、ODPT や GTFS の路線名とは' +
      '一致しないことがあります。P11 は停留所の順番を持たないため、線では結んでいません。' +
      '光っている停留所は、別の事業者のデータで光っている場合もあります。</p>');
  }

  function fitBox(bb) {
    var pad = 1.4;
    view.x = (bb[0] + bb[2]) / 2;
    view.y = (bb[1] + bb[3]) / 2;
    view.k = Math.min(W / Math.max(1e-6, (bb[2] - bb[0]) * pad),
                      H / Math.max(1e-6, (bb[3] - bb[1]) * pad));
    view.k = Math.max(baseScale() * 1.2, Math.min(baseScale() * 200, view.k));
    render();
  }

  info.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || !sel) return;
    if (b.dataset.k != null) { setRoute(+b.dataset.k); return; }
    if (b.dataset.act === 'close') { clearRoute(); showInfo(null); return; }
    if (b.dataset.act === 'fit' && sel.bb) fitBox(sel.bb);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !sel || document.activeElement === qEl) return;
    clearRoute();
    showInfo(null);
  });

  // ── 左パネル ────────────────────────────────────────────
  var ORDER4 = ['通年オープン', '期間限定', 'ODPT外にあり', 'データなし'];
  MODES.forEach(function (m) { MODE_LABEL[m.id] = m.label; });
  var skEl = document.getElementById('statuskeys');
  var rowsEl = document.getElementById('keys');

  function fmt(n) { return n.toLocaleString('ja-JP'); }

  // 色の凡例。押すとその所在を地図から外す
  skEl.innerHTML = ORDER4.map(function (s) {
    return '<button class="skey" data-s="' + s + '" aria-pressed="true">' +
           '<i style="background:' + HEX[s] + '"></i>' + LABEL[s] + '</button>';
  }).join('');
  Array.prototype.forEach.call(skEl.querySelectorAll('.skey'), function (k) {
    k.addEventListener('click', function () {
      var s = k.dataset.s;
      offStatus[s] = !offStatus[s];
      k.setAttribute('aria-pressed', String(!offStatus[s]));
      if (hover && offStatus[hover.p.s]) { setHover(null); showInfo(null); }
      render();
    });
  });

  // 交通機関ごとの内訳。帯は100%積み上げ、下の実数は帯と同じ色で並べる。
  // 母集団が無いモードは割合を出さず、実数だけを示す。
  rowsEl.innerHTML = MODES.map(function (m) {
    // 母集団のあるモードは母集団数、無いモードは確認できた分の合計を出す。
    // 「母集団なし」と言葉で書くより、数を出したほうが読み手が判断しやすい。
    var known = m.n ? m.n.reduce(function (a, b) { return a + b; }, 0) : 0;
    var right = m.n ? fmt(m.total || known) + ' ' + m.unit : '国土数値情報 C23・NE';
    var head = '<span class="row-h"><b>' + m.label + '</b><span>' +
               right + '</span></span>';
    if (!m.n) {
      return '<button class="row" data-id="' + m.id + '" aria-pressed="true">' +
             head + '</button>';
    }
    var tot = m.total || m.n.reduce(function (a, b) { return a + b; }, 0);
    var bar = ORDER4.map(function (s, i) {
      var w = tot ? m.n[i] / tot * 100 : 0;
      return w > 0 ? '<i style="width:' + w.toFixed(2) + '%;background:' + HEX[s] + '"></i>' : '';
    }).join('');
    var nums = ORDER4.map(function (s, i) {
      if (!m.n[i]) return '';
      return '<u style="color:' + HEX[s] + '">' + fmt(m.n[i]) + '</u>';
    }).filter(Boolean).join('<span class="none">/</span>');
    return '<button class="row" data-id="' + m.id + '" aria-pressed="true">' +
           head + '<span class="bar">' + bar + '</span>' +
           '<span class="nums">' + nums + '</span></button>';
  }).join('');
  Array.prototype.forEach.call(rowsEl.querySelectorAll('.row'), function (k) {
    k.addEventListener('click', function () {
      var id = k.dataset.id;
      on[id] = !on[id];
      k.setAttribute('aria-pressed', String(on[id]));
      if (id === 'rail' && !on.rail) { setHover(null); showInfo(null); }
      if (id === 'bus' && !on.bus && sel) { clearRoute(); showInfo(null); }
      render();
    });
  });

  // 公共交通以外のデータ。所在の内訳は無いので、件数だけを並べる
  var exEl = document.getElementById('extrakeys');
  exEl.innerHTML = EXTRA_IDS.map(function (id) {
    var v = EXTRA[id];
    return '<button class="row" data-x="' + id + '" aria-pressed="true">' +
           '<span class="row-h"><b><i class="dot" style="background:' +
           EXTRA_HEX[id] + '"></i>' + v.label + '</b><span>' +
           fmt(v.count) + ' ' + v.unit + '</span></span></button>';
  }).join('');
  Array.prototype.forEach.call(exEl.querySelectorAll('.row'), function (k) {
    k.addEventListener('click', function () {
      var id = k.dataset.x;
      on[id] = !on[id];
      k.setAttribute('aria-pressed', String(on[id]));
      render();
    });
  });
  document.getElementById('extra-foot').textContent =
    'チャレンジ2026 は ODPT と GTFSデータリポジトリ以外のデータも公開しています。'
    + 'このうち場所によって有無があるのがこの2つ。'
    + '所在（ODPT／ODPT外）の軸には載らないため、別の色で示しています。'
    + '気象庁・警察庁・e-Stat などの連携データは全国一律なので載せていません。';

  // 観光資源。**3つの分類をそれぞれ独立に開け閉めできる。**
  // 「空白地帯」と「データが無いだけ」を切り分けて見たい、という要望による。
  var tourEl = document.getElementById('tourkeys');
  tourEl.innerHTML = ['gap', 'none', 'data'].map(function (id) {
    return '<button class="skey tkey" data-t="' + id + '" aria-pressed="false" title="' +
           TOUR[id].long + '"><i style="background:' + TOUR_HEX[id] + '"></i>' +
           TOUR[id].label + ' <b>' + fmt(TOUR[id].count) + '</b></button>';
  }).join('') +
    '<dl class="tdef">' + ['gap', 'none', 'data'].map(function (id) {
      return '<dt style="color:' + TOUR_HEX[id] + '">' + TOUR[id].label + '</dt>' +
             '<dd>' + TOUR[id].long + '</dd>';
    }).join('') + '</dl>';
  Array.prototype.forEach.call(tourEl.querySelectorAll('.tkey'), function (k) {
    k.addEventListener('click', function () {
      var id = 'tour_' + k.dataset.t;
      on[id] = !on[id];
      k.setAttribute('aria-pressed', String(on[id]));
      render();
    });
  });
  document.getElementById('tour-foot').textContent =
    '国土数値情報 P12 の観光資源のうち、範囲を持つ' + fmt(TOUR.meta.areas)
    + '件（面と線）を輪郭で描いています。既定では消してあり、押すと重なります。'
    + '判定は輪郭から2km。「データあり」は ODPT（通年・期間限定）と '
    + 'GTFSデータリポジトリ等のいずれかにバス停か駅があるもので、'
    + 'そのうち' + fmt(TOUR.meta.temp_only) + '件は期間限定だけなので '
    + '2027年3月13日に失われます。'
    + '「時刻表なし」は、停留所や駅は現にあって時刻表がどこにも'
    + '公開されていないもの——ODPT に無いという意味ではなく、'
    + 'gtfs-data.jp 等を含めてどこにも無いという意味です。'
    + '公開されれば、その日から案内が作れます。'
    + 'P12 は入込客数を持たないので、人気の大小までは分かりません。';

  document.getElementById('legend-foot').textContent =
    '数字は左から ODPT ／ ODPT（期間限定）／ ODPT外 ／ なし。帯はその割合。'
    + '右肩は、鉄道・バス・航空は全国の母集団、シェアサイクル・フェリー・'
    + 'デマンド交通は全国一覧が無いため確認できた分の合計です。';

  // ── 操作 ────────────────────────────────────────────────
  var drag = null;
  // タップ判定。**指ではホバーが使えない。**
  // 押して離すまでの移動が小さければ、そこを選んだものとして扱う。
  var tap = null;

  // ── 2本指の操作 ────────────────────────────────────────
  // キャンバスは touch-action:none にしてあるので、ブラウザの拡大縮小は効かない。
  // 指の間隔と中点を自分で追い、間隔の比で拡大、中点の移動で平行移動する。
  var live = {};        // いま触れている指
  var pinch = null;     // 2本指のときの直前の状態
  function fingers() {
    var a = [];
    for (var k in live) { if (live.hasOwnProperty(k)) a.push(live[k]); }
    return a;
  }
  function pinchState() {
    var f = fingers();
    var dx = f[0].x - f[1].x, dy = f[0].y - f[1].y;
    return {
      d: Math.max(1, Math.sqrt(dx * dx + dy * dy)),
      x: (f[0].x + f[1].x) / 2,
      y: (f[0].y + f[1].y) / 2
    };
  }

  cv.addEventListener('pointerdown', function (e) {
    live[e.pointerId] = { x: e.clientX, y: e.clientY };
    var n = fingers().length;
    if (n === 1) {
      tap = { x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
      drag = { x: e.clientX, y: e.clientY };
      cv.classList.add('drag');
    } else if (n === 2) {
      tap = null;           // 2本目が触れた時点で、これはタップではない
      drag = null;
      pinch = pinchState();
    }
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', function (e) {
    if (live[e.pointerId]) {
      live[e.pointerId].x = e.clientX;
      live[e.pointerId].y = e.clientY;
    }
    if (pinch && fingers().length >= 2) {
      var now = pinchState();
      // 先に中点の移動ぶんだけ動かし、そのうえで中点を軸に拡大縮小する
      view.x -= (now.x - pinch.x) / view.k;
      view.y -= (now.y - pinch.y) / view.k;
      var r0 = cv.getBoundingClientRect();
      zoomAt(now.x - r0.left, now.y - r0.top, now.d / pinch.d);
      pinch = now;
      return;
    }
    if (drag) {
      view.x -= (e.clientX - drag.x) / view.k;
      view.y -= (e.clientY - drag.y) / view.k;
      drag.x = e.clientX;
      drag.y = e.clientY;
      render();
      return;
    }
    // 系統を選んでいる間は、ホバーで情報欄を書き換えない。
    // 書き換えると、系統の内訳を読んだりボタンを押したりする前に消えてしまう
    if (sel) return;
    var r = cv.getBoundingClientRect();
    var px = e.clientX - r.left, py = e.clientY - r.top;
    var f = on.rail ? pick(px, py) : null;
    if (f) {
      if (f !== hover) { setHover(f); showInfo(f); render(); }
      hoverPt = null;
      return;
    }
    if (hover) { setHover(null); render(); }
    var pt = pickPoint(px, py);
    var key = pt ? pt.mode + pt.status + pt.name : null;
    if (key !== hoverPtKey) { hoverPtKey = key; hoverPt = pt; showPointInfo(pt); }
  });
  function endDrag() { if (drag) { cv.classList.remove('drag'); drag = null; } }
  function liftFinger(e) {
    delete live[e.pointerId];
    var f = fingers();
    if (f.length < 2) pinch = null;
    if (f.length === 1) {
      // 2本から1本に減った。残った指を新しい起点にして、飛ぶのを防ぐ
      drag = { x: f[0].x, y: f[0].y };
      cv.classList.add('drag');
      return false;
    }
    if (f.length === 0) { endDrag(); return true; }
    pinch = pinchState();
    return false;
  }
  cv.addEventListener('pointerup', function (e) {
    if (!liftFinger(e)) { tap = null; return; }
    if (!tap) return;
    var moved = Math.abs(e.clientX - tap.x) + Math.abs(e.clientY - tap.y);
    var touch = tap.touch;
    tap = null;
    // 動いていたら地図を動かしただけ。マウスは指ほどぶれないので狭く取る
    if (moved > (touch ? 10 : 4)) return;
    var r = cv.getBoundingClientRect();
    var px = e.clientX - r.left, py = e.clientY - r.top;
    // 鉄道を先に見る。これまでどおり、線の上を押したら路線の情報を出す
    var f = on.rail ? pick(px, py, touch ? TOUCH_TOL : 7) : null;
    var pt = f ? null : pickPoint(px, py, touch ? TOUCH_TOL : 8);
    // バス停を押したら、その系統を光らせる。マウスでも指でも同じ
    if (pt && pt.mode === 'bus') {
      if (hover) setHover(null);
      hoverPt = null;
      hoverPtKey = null;
      selectStop(pt);
      render();
      return;
    }
    // それ以外を押したら、系統の選択は外す
    if (sel) { clearRoute(); showInfo(null); }
    if (!touch) return;                    // マウスはホバーで足りている
    if (f) { setHover(f); showInfo(f); render(); return; }
    if (hover) { setHover(null); render(); }
    hoverPt = pt;
    hoverPtKey = pt ? pt.mode + pt.status + pt.name : null;
    showPointInfo(pt);
  });
  cv.addEventListener('pointercancel', function (e) { liftFinger(e); tap = null; });
  cv.addEventListener('pointerleave', function () {
    if (drag || pinch) return;
    if (hover) { setHover(null); render(); }
    hoverPt = null;
    hoverPtKey = null;
    // 系統を選んでいる間は残す。情報欄のボタンへ移るときにもここを通る
    if (!sel) showInfo(null);
  });
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = cv.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0016, -e.deltaY));
  }, { passive: false });

  function zoomAt(px, py, factor) {
    var b = baseScale();
    var k2 = Math.max(b * 0.34, Math.min(b * 200, view.k * factor));
    var wx = (px - W / 2) / view.k + view.x, wy = (py - H / 2) / view.k + view.y;
    view.x = wx - (px - W / 2) / k2;
    view.y = wy - (py - H / 2) / k2;
    view.k = k2;
    render();
  }

  // ── 入口 ──────────────────────────────────────────────
  // 一度閉じたら次からは出さない。localStorage は使えないことがあるので、
  // 読み書きの両方を try で包み、失敗しても「毎回出す」に倒れるだけにする。
  var intro = document.getElementById('intro');
  var SEEN = 'whitemap.intro.v1';
  function closeIntro() {
    if (!intro || intro.classList.contains('gone')) return;
    intro.classList.add('gone');
    try { localStorage.setItem(SEEN, '1'); } catch (e) { /* 使えなくても構わない */ }
  }
  // 判定そのものは、地図の直後に置いた小さなスクリプトで済ませてある。
  // ここまで来るのは埋め込みデータを読み終えたあとで、遅すぎる。
  document.getElementById('zhelp').addEventListener('click', function () {
    intro.classList.remove('gone');
    try { localStorage.removeItem(SEEN); } catch (e) { /* 気にしない */ }
  });
  document.getElementById('introgo').addEventListener('click', closeIntro);
  // **指では地図を触ったら閉じる、にしてはいけない。**
  // スマホは画面を送るのに地図の上から指を置くので、読む前に消えてしまう。
  // マウスのときだけ、地図を使い始めたら閉じる。
  cv.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') closeIntro();
  });

  // ── 検索 ────────────────────────────────────────────────
  // 名前は取得済みのものだけで足りる。駅（N02）・観光資源（P12）・
  // 事業者（P11 と N02 の運営会社名）。**バス停27.8万件は入れていない。**
  // 同名が多すぎて選べないため、事業者から辿る形にした。
  var SEARCH = JSON.parse(document.getElementById('search').textContent);
  var S_XY = decode(SEARCH.pts);
  var qEl = document.getElementById('q');
  var hitsEl = document.getElementById('hits');
  var hitList = [], hitAt = -1;

  function flyTo(i) {
    var bb = SEARCH.boxes && SEARCH.boxes[String(i)];
    if (bb) {
      // 市区町村は広さがまちまちなので、範囲に合わせて寄せる。
      // 決め打ちの倍率だと、政令市の区は寄りすぎ、山間の町は収まらない。
      var x0 = mx(bb[1]), x1 = mx(bb[3]), y0 = my(bb[2]), y1 = my(bb[0]);
      var pad = 1.35;                      // 周りの状況も見えるよう少し引く
      view.x = (x0 + x1) / 2;
      view.y = (y0 + y1) / 2;
      view.k = Math.min(W / Math.max(1e-6, (x1 - x0) * pad),
                        H / Math.max(1e-6, (y1 - y0) * pad));
      view.k = Math.max(baseScale() * 1.2, Math.min(baseScale() * 400, view.k));
    } else {
      view.x = S_XY[i * 2];
      view.y = S_XY[i * 2 + 1];
      view.k = Math.max(view.k, baseScale() * 26); // 街の形が見える程度まで寄る
    }
    closeIntro();
    clearRoute();              // 探したものを出すので、選んでいた系統は外す
    showFound(i);
    render();
  }

  // 選んだものを情報パネルに残す。市区町村はここが数字の置き場になる
  function showFound(i) {
    info.innerHTML =
      '<p class="ttl">' + esc(SEARCH.names[i]) + '</p>' +
      '<span class="badge" style="color:var(--ink-2)">' +
      esc(SEARCH.kindLabel[SEARCH.kinds[i]]) + '</span>' +
      '<dl><dt>' + (SEARCH.kinds[i] === 3 ? '内訳' : '所属') + '</dt><dd>' +
      esc(SEARCH.subtab[SEARCH.subs[i]]) + '</dd></dl>';
  }
  function closeHits() { hitsEl.classList.remove('open'); hitAt = -1; }

  function runSearch() {
    var q = qEl.value.trim();
    if (!q) { hitList = []; closeHits(); return; }
    var out = [];
    // 前方一致を先に、部分一致を後に。探している名前は頭から打つことが多い
    for (var pass = 0; pass < 2 && out.length < 40; pass++) {
      for (var i = 0; i < SEARCH.names.length && out.length < 40; i++) {
        var n = SEARCH.names[i];
        var at = n.indexOf(q);
        if (pass === 0 ? at !== 0 : at <= 0) continue;
        out.push(i);
      }
    }
    hitList = out;
    hitAt = -1;
    if (!out.length) {
      hitsEl.innerHTML = '<li class="none">見つかりません</li>';
      hitsEl.classList.add('open');
      return;
    }
    hitsEl.innerHTML = out.map(function (i, j) {
      return '<li role="option" data-j="' + j + '" aria-selected="false">' +
             '<b><em>' + SEARCH.kindLabel[SEARCH.kinds[i]] + '</em>' +
             esc(SEARCH.names[i]) + '</b>' +
             '<span>' + esc(SEARCH.subtab[SEARCH.subs[i]]) + '</span></li>';
    }).join('');
    hitsEl.classList.add('open');
  }
  function markHit() {
    Array.prototype.forEach.call(hitsEl.querySelectorAll('li[role]'), function (li, j) {
      li.setAttribute('aria-selected', String(j === hitAt));
      if (j === hitAt) li.scrollIntoView({ block: 'nearest' });
    });
  }
  qEl.addEventListener('input', runSearch);
  qEl.addEventListener('keydown', function (e) {
    if (!hitList.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      hitAt = (hitAt + (e.key === 'ArrowDown' ? 1 : hitList.length - 1)) % hitList.length;
      markHit();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      flyTo(hitList[hitAt < 0 ? 0 : hitAt]);
      closeHits();
      qEl.blur();
    } else if (e.key === 'Escape') {
      closeHits();
    }
  });
  hitsEl.addEventListener('click', function (e) {
    var li = e.target.closest('li[data-j]');
    if (!li) return;
    flyTo(hitList[+li.dataset.j]);
    closeHits();
    qEl.blur();
  });
  document.getElementById('find').addEventListener('submit', function (e) {
    e.preventDefault();
    if (hitList.length) { flyTo(hitList[0]); closeHits(); qEl.blur(); }
  });

  document.getElementById('zin').onclick = function () { zoomAt(W / 2, H / 2, 1.6); };
  document.getElementById('zout').onclick = function () { zoomAt(W / 2, H / 2, 1 / 1.6); };
  document.getElementById('zreset').onclick = function () { fit(); render(); };

  window.addEventListener('resize', function () { resize(); fit(); render(); });
  resize();
  fit();
  showInfo(null);
  draw();
  // Webフォントが入るとヘッダの高さが動くので、読み込み後に測り直す
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { resize(); fit(); draw(); });
  }
})();
