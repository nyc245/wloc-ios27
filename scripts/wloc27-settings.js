/*
 * wloc27-settings.js — 选点页 / 快捷指令的落盘接口（http-request 脚本）
 * ------------------------------------------------------------------
 * 拦截 https://gs-loc.apple.com/wloc-settings/*
 *
 *   GET /wloc-settings/save?lat=39.9042&lon=116.4074&acc=25&mode=fixed
 *   GET /wloc-settings/get        → 返回当前坐标 JSON
 *   GET /wloc-settings/clear      → 清空（脚本进入透传，定位回归真实）
 *   GET /wloc-settings/ping       → 探活，验证 MITM + 模块是否生效
 *
 * 也支持 POST body（JSON）：{"lat":..,"lon":..,"mode":"track","path":".."}
 */

(function () {
  'use strict'

  var STORE_KEY = 'wloc27_settings'
  var CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }

  function storeRead(key) {
    try {
      if (typeof $persistentStore !== 'undefined' && $persistentStore.read) return $persistentStore.read(key)
      if (typeof $prefs !== 'undefined' && $prefs.valueForKey) return $prefs.valueForKey(key)
    } catch (e) {}
    return null
  }

  function storeWrite(key, value) {
    try {
      if (typeof $persistentStore !== 'undefined' && $persistentStore.write) return $persistentStore.write(value, key)
      if (typeof $prefs !== 'undefined' && $prefs.setValueForKey) return $prefs.setValueForKey(value, key)
    } catch (e) {}
    return false
  }

  function send(status, obj) {
    var body = JSON.stringify(obj)
    try {
      if (typeof $done === 'function') {
        $done({ response: { status: status, headers: CORS, body: body } })
        return
      }
    } catch (e) {}
    try { $done({ status: status, headers: CORS, body: body }) } catch (e) {}
  }

  function parseQuery(url) {
    var out = {}
    var qi = url.indexOf('?')
    if (qi < 0) return out
    var q = url.slice(qi + 1).split('#')[0]
    var pairs = q.split('&')
    for (var i = 0; i < pairs.length; i++) {
      if (!pairs[i]) continue
      var eq = pairs[i].indexOf('=')
      var k = eq < 0 ? pairs[i] : pairs[i].slice(0, eq)
      var v = eq < 0 ? '' : pairs[i].slice(eq + 1)
      try { k = decodeURIComponent(k); v = decodeURIComponent(v) } catch (e) {}
      out[k.trim().toLowerCase()] = v.trim()
    }
    return out
  }

  function numOrNull(v) {
    if (v === undefined || v === null || v === '') return null
    var n = Number(v)
    return isFinite(n) ? n : null
  }

  function readCurrent() {
    var raw = storeRead(STORE_KEY)
    if (!raw) return null
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch (e) { return null }
  }

  function main() {
    var url = ''
    try { url = (typeof $request !== 'undefined' && $request && $request.url) ? $request.url : '' } catch (e) {}

    var path = url.replace(/^https?:\/\/[^/]+/i, '').split('?')[0]
    var action = path.split('/').filter(Boolean).pop() || ''
    action = action.toLowerCase()

    var q = parseQuery(url)

    if (action === 'ping') {
      return send(200, { ok: true, module: 'wloc27', engine: (typeof $loon !== 'undefined') ? 'loon' : 'surge-compatible', at: new Date().toISOString() })
    }

    if (action === 'get') {
      var cur = readCurrent()
      var hit = null
      try {
        var hitRaw = storeRead('wloc27_last_hit')
        if (hitRaw) hit = typeof hitRaw === 'string' ? JSON.parse(hitRaw) : hitRaw
      } catch (e) { hit = null }
      return send(200, { ok: true, settings: cur, lastHit: hit, now: Date.now() })
    }

    if (action === 'clear') {
      storeWrite(STORE_KEY, null)
      storeWrite('wloc27_last_hit', null)
      return send(200, { ok: true, cleared: true, note: '已清空坐标，脚本进入透传模式' })
    }

    if (action === 'save') {
      var incoming = {}
      var rawBody = ''
      try { rawBody = (typeof $request !== 'undefined' && $request && $request.body) ? String($request.body) : '' } catch (e) {}
      if (rawBody && rawBody.trim().charAt(0) === '{') {
        try { incoming = JSON.parse(rawBody) } catch (e) { incoming = {} }
      }

      var lat = numOrNull(q.lat !== undefined ? q.lat : incoming.lat)
      var lon = numOrNull(q.lon !== undefined ? q.lon : (incoming.lon !== undefined ? incoming.lon : incoming.lng))

      if (lat === null || lon === null) {
        return send(400, { ok: false, error: 'lat/lon 缺失', got: q })
      }
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return send(400, { ok: false, error: '坐标越界' })
      }

      var settings = {
        lat: lat,
        lon: lon,
        mode: (q.mode || incoming.mode || 'fixed').toLowerCase(),
        accuracy: numOrNull(q.acc !== undefined ? q.acc : incoming.accuracy) || 25,
        altitude: numOrNull(q.alt !== undefined ? q.alt : incoming.altitude),
        speed: numOrNull(q.spd !== undefined ? q.spd : incoming.speed),
        course: numOrNull(q.crs !== undefined ? q.crs : incoming.course),
        updateTimestamp: 1,
        trackPath: q.path || incoming.trackPath || '',
        trackSpeed: numOrNull(q.tspd !== undefined ? q.tspd : incoming.trackSpeed) || 1.4,
        // 轨迹没给起点时，用保存时刻当起点：到点时坐标正好在路径头上
        trackStart: numOrNull(q.tstart !== undefined ? q.tstart : incoming.trackStart) || Date.now(),
        trackLoop: 1,
        logLevel: q.log || incoming.logLevel || 'info',
        extendTtl: numOrNull(q.ttl !== undefined ? q.ttl : incoming.extendTtl) || 0,
        ttlSeconds: numOrNull(q.ttls !== undefined ? q.ttls : incoming.ttlSeconds) || 1800,
        ttlMode: (q.ttlm || incoming.ttlMode || (q.ttl == 1 ? 'long' : 'keep')).toLowerCase(),
        patchAll: 1,
        savedAt: new Date().toISOString()
      }

      var ok = storeWrite(STORE_KEY, JSON.stringify(settings))
      return send(200, { ok: !!ok, saved: settings, key: STORE_KEY })
    }

    return send(404, { ok: false, error: 'unknown action: ' + action })
  }

  try {
    main()
  } catch (e) {
    try { $done({}) } catch (e2) {}
  }
})()
