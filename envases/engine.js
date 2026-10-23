/* engine.js — motor ÚNICO de Trastienda (navegador + Node). Funciones puras, sin I/O.
 * UMD: module.exports en Node; Trastienda en el objeto global (window/self) en el navegador.
 * Los CSV del vendedor nunca salen del navegador: aquí no hay red ni almacenamiento.
 *
 * Decisiones documentadas:
 *  - parseNumeroES: con coma => formato ES ("1.234,56"); sin coma => decimal con punto ("12.50").
 *    Cadena vacía o ilegible => NaN (nunca 0 silencioso); quien llama decide fallar.
 *  - bruto de una línea: Amazon item-price y TikTok SKU Subtotal son TOTAL de línea;
 *    Shopify Lineitem price es PRECIO UNITARIO (se multiplica por la cantidad).
 *  - fijo_pedido se aplica por línea de pedido (los fixtures traen 1 línea por pedido).
 *  - Un SKU que no está en el maestro NO recibe peso por defecto: va a `pendientes`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.Trastienda = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MATERIALES = ['papel_carton', 'plastico', 'vidrio', 'metal', 'madera', 'otros'];
  var CANALES = {
    amazon: { id: 'amazon-order-id', fecha: 'purchase-date', estado: 'order-status', sku: 'sku',
              qty: 'quantity', precio: 'item-price', porUnidad: false,
              excluidos: ['cancelled', 'canceled'] },
    shopify: { id: 'Name', fecha: 'Created at', estado: 'Financial Status', sku: 'Lineitem sku',
               qty: 'Lineitem quantity', precio: 'Lineitem price', porUnidad: true,
               excluidos: ['refunded', 'voided'] },
    tiktok: { id: 'Order ID', fecha: 'Created Time', estado: 'Order Status', sku: 'Seller SKU',
              qty: 'Quantity', precio: 'SKU Subtotal After Discount', porUnidad: false,
              excluidos: ['cancelled', 'canceled'] }
  };

  function quitarBOM(t) { return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t; }

  function detectarSeparador(texto) {
    var cuentas = { ',': 0, ';': 0, '\t': 0 };
    var enComillas = false;
    for (var i = 0; i < texto.length; i++) {
      var c = texto[i];
      if (c === '"') { enComillas = !enComillas; continue; }
      if (!enComillas && c === '\n') break;
      if (!enComillas && cuentas.hasOwnProperty(c)) cuentas[c]++;
    }
    var mejor = ',';
    [',', ';', '\t'].forEach(function (s) { if (cuentas[s] > cuentas[mejor]) mejor = s; });
    return mejor;
  }

  function parseCSV(texto, sep) {
    texto = quitarBOM(String(texto));
    if (!sep) sep = detectarSeparador(texto);
    var filas = [], fila = [], campo = '', enComillas = false, i = 0, n = texto.length;
    while (i < n) {
      var c = texto[i];
      if (enComillas) {
        if (c === '"') {
          if (texto[i + 1] === '"') { campo += '"'; i += 2; continue; }
          enComillas = false; i++; continue;
        }
        campo += c; i++; continue;
      }
      if (c === '"' && campo === '') { enComillas = true; i++; continue; }
      if (c === sep) { fila.push(campo); campo = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { fila.push(campo); campo = ''; filas.push(fila); fila = []; i++; continue; }
      campo += c; i++;
    }
    if (enComillas) throw new Error('CSV ilegible: comilla sin cerrar');
    if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
    return filas.filter(function (f) { return !(f.length === 1 && f[0].trim() === ''); });
  }

  function leerTabla(texto) {
    var rows = parseCSV(texto);
    if (rows.length === 0) throw new Error('CSV vacío');
    var cabeceras = rows[0].map(function (h) { return h.trim(); });
    var filas = rows.slice(1).map(function (r, k) {
      if (r.length !== cabeceras.length) {
        throw new Error('fila ' + (k + 2) + ' con ' + r.length + ' campos, esperaba ' + cabeceras.length);
      }
      var o = {};
      cabeceras.forEach(function (h, j) { o[h] = r[j]; });
      return o;
    });
    return { cabeceras: cabeceras, filas: filas };
  }

  function parseNumeroES(s) {
    s = String(s).replace(/[€\s]/g, '');
    if (s === '') return NaN;
    if (s.indexOf(',') !== -1) s = s.replace(/\./g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  function detectarCanal(cabeceras) {
    var h = cabeceras.map(function (x) { return x.trim().toLowerCase(); });
    if (h.indexOf('amazon-order-id') !== -1) return 'amazon';
    if (h.indexOf('lineitem sku') !== -1) return 'shopify';
    if (h.indexOf('seller sku') !== -1) return 'tiktok';
    return 'desconocido';
  }

  function anioDe(texto) {
    var m = /\b(20\d{2})\b/.exec(String(texto));
    return m ? Number(m[1]) : NaN;
  }

  function r2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

  function normalizarPedidos(filas, canal, opts) {
    var cfg = CANALES[canal];
    if (!cfg) throw new Error('canal desconocido: ' + canal);
    var lineas = [], excluidas = [];
    filas.forEach(function (f) {
      var id = String(f[cfg.id]).trim();
      var estado = String(f[cfg.estado] || '').trim().toLowerCase();
      if (cfg.excluidos.indexOf(estado) !== -1) {
        excluidas.push({ canal: canal, id: id, motivo: estado });
        return;
      }
      var anio = anioDe(f[cfg.fecha]);
      if (opts && opts.anio && anio !== opts.anio) {
        excluidas.push({ canal: canal, id: id, motivo: 'anio ' + anio });
        return;
      }
      var qty = parseNumeroES(f[cfg.qty]);
      if (!(qty >= 1) || Math.floor(qty) !== qty) throw new Error('pedido ' + id + ': cantidad inválida');
      var precio = parseNumeroES(f[cfg.precio]);
      if (isNaN(precio)) throw new Error('pedido ' + id + ': precio ilegible');
      var sku = String(f[cfg.sku]).trim();
      if (sku === '') throw new Error('pedido ' + id + ': SKU vacío');
      lineas.push({ canal: canal, id: id, sku: sku, qty: qty,
                    bruto: r2(cfg.porUnidad ? precio * qty : precio) });
    });
    return { lineas: lineas, excluidas: excluidas };
  }

  function cargarMaestro(texto) {
    var t = leerTabla(texto);
    var req = ['sku', 'coste_unitario'].concat(MATERIALES.map(function (m) { return m + '_g'; }));
    req.forEach(function (c) {
      if (t.cabeceras.indexOf(c) === -1) throw new Error('maestro: falta la columna ' + c);
    });
    var m = {};
    t.filas.forEach(function (f) {
      var sku = f.sku.trim();
      if (m[sku]) throw new Error('maestro: SKU duplicado ' + sku);
      var coste = parseNumeroES(f.coste_unitario);
      if (isNaN(coste)) throw new Error('maestro: coste ilegible en ' + sku);
      var g = {};
      MATERIALES.forEach(function (mat) {
        var v = parseNumeroES(f[mat + '_g']);
        if (isNaN(v) || v < 0) throw new Error('maestro: peso ilegible ' + mat + ' en ' + sku);
        g[mat] = v;
      });
      m[sku] = { coste: coste, g: g };
    });
    return m;
  }

  function envases(lineas, maestro) {
    var gramos = {}, pend = {};
    lineas.forEach(function (l) {
      if (!gramos[l.canal]) {
        gramos[l.canal] = {};
        MATERIALES.forEach(function (mat) { gramos[l.canal][mat] = 0; });
      }
      var m = maestro[l.sku];
      if (!m) {
        var k = l.sku + '\u0000' + l.canal;
        pend[k] = pend[k] || { sku: l.sku, canal: l.canal, unidades: 0 };
        pend[k].unidades += l.qty;
        return;
      }
      MATERIALES.forEach(function (mat) { gramos[l.canal][mat] += l.qty * m.g[mat]; });
    });
    var pendientes = Object.keys(pend).sort().map(function (k) { return pend[k]; });
    return { gramos: gramos, pendientes: pendientes };
  }

  // SKUs distintos con datos de envase pendientes (una vez cada uno), ordenados.
  function skusPendientes(pendientes) {
    var vistos = {};
    pendientes.forEach(function (p) { vistos[p.sku] = true; });
    return Object.keys(vistos).sort();
  }

  // neto = bruto/(1+iva) − tasa×bruto − fijo_pedido − coste×unidades  (agregado por SKU×canal)
  function neto(lineas, maestro, tarifas) {
    var agg = {};
    lineas.forEach(function (l) {
      var m = maestro[l.sku];
      if (!m) return;
      var t = tarifas.canales[l.canal];
      if (!t) throw new Error('sin tarifa para el canal ' + l.canal);
      var base = l.bruto / (1 + tarifas.iva);
      var comision = t.tasa * l.bruto;
      var k = l.sku + '\u0000' + l.canal;
      var a = agg[k] = agg[k] || { sku: l.sku, canal: l.canal, unidades: 0, bruto: 0,
                                    base: 0, comision: 0, fijo: 0, coste: 0 };
      a.unidades += l.qty; a.bruto += l.bruto; a.base += base; a.comision += comision;
      a.fijo += t.fijo_pedido; a.coste += m.coste * l.qty;
    });
    return Object.keys(agg).sort().map(function (k) {
      var a = agg[k];
      return { sku: a.sku, canal: a.canal, unidades: a.unidades, bruto: r2(a.bruto),
               base: r2(a.base), comision: r2(a.comision), fijo: r2(a.fijo), coste: r2(a.coste),
               neto: r2(a.base - a.comision - a.fijo - a.coste) };
    });
  }

  // Cálculo de una unidad (calculadora FBA / neto): misma fórmula que neto().
  function netoUnidad(bruto, tasa, fijo, coste, iva) {
    return r2(bruto / (1 + iva) - tasa * bruto - fijo - coste);
  }

  // Punto de entrada común navegador + CLI. archivos: [{nombre, texto}]
  function calcular(archivos, maestroTexto, tarifas, opts) {
    var maestro = cargarMaestro(maestroTexto);
    var infos = [], lineas = [], excluidas = [];
    archivos.forEach(function (a) {
      var t = leerTabla(a.texto);
      var canal = detectarCanal(t.cabeceras);
      if (canal === 'desconocido') throw new Error('canal desconocido en ' + a.nombre);
      var r = normalizarPedidos(t.filas, canal, opts);
      infos.push({ archivo: a.nombre, canal: canal, filas: t.filas.length });
      lineas = lineas.concat(r.lineas);
      excluidas = excluidas.concat(r.excluidas);
    });
    return { archivos: infos, lineas: lineas, excluidas: excluidas,
             envases: envases(lineas, maestro), neto: neto(lineas, maestro, tarifas) };
  }

  return { MATERIALES: MATERIALES, parseCSV: parseCSV, leerTabla: leerTabla,
           parseNumeroES: parseNumeroES, detectarCanal: detectarCanal,
           normalizarPedidos: normalizarPedidos, cargarMaestro: cargarMaestro,
           envases: envases, skusPendientes: skusPendientes, neto: neto, netoUnidad: netoUnidad, calcular: calcular };
});
