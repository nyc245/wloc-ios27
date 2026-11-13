/*
 * wloc27.js — Apple WLOC (gs-loc) 定位改写脚本 · iOS 26/27 适配版
 * ------------------------------------------------------------------
 * 做法：拦截 /clls/* （WLOC 网络定位）响应，二进制级解析 protobuf，
 *      把里面的经纬度/精度/时间戳换成目标值，再按原结构写回。
 *
 * 相对旧版（iOS 15~18 可用）的改造点：
 *   1) 匹配放宽到 ^https?://gs-loc*.apple.com(/.cn)?/clls/ ，Apple 改路径也不会漏拦；
 *   2) body 读取多路兜底（bodyBytes / ArrayBuffer / binary string / base64）；
 *   3) 坐标定位不再硬编码字段号 —— 用「double 对 + 精度 + 秒级时间戳」指纹打分，
 *      结构变了照样命中；
 *   4) 指纹失败时退回字节级扫描（小端 + 大端都试），保证还能改；
 *   5) 同层秒级时间戳同步刷新，避免 iOS 26+ 的 locationd 判定为「旧缓存」直接丢弃；
 *   6) 轨迹模式：按路径 + 速度随时间推坐标，早操跑步类打卡不会因为坐标钉死不动物理异常。
 *
 * 引擎：Surge / Loon / Stash / Shadowrocket / Quantumult X / Egern
 */

(function () {
  'use strict'

  // ============================ 0. 常量 ============================
  var STORE_KEY = 'wloc27_settings'      // 新版
  var STORE_KEY_OLD = 'wloc_settings'    // 兼容旧版 wloc
  var DEFAULT_ACCURACY = 25
  var LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

  var DEFAULTS = {
    mode: 'fixed',        // fixed | track | off
    lat: null,
    lon: null,
    accuracy: DEFAULT_ACCURACY,
    altitude: null,
    speed: null,
    course: null,
    updateTimestamp: 1,   // 1=把同层秒级时间戳刷成当前时间
    trackPath: '',        // "lat,lon;lat,lon;..." 或 "lat,lon|lat,lon"
    trackSpeed: 1.4,      // m/s
    trackStart: 0,        // 毫秒时间戳，0=取首次运行时间
    trackLoop: 1,
    logLevel: 'info',
    extendTtl: 0,        // 1=把响应里的短 TTL 拉长，让假坐标在缓存里待更久
    ttlSeconds: 1800,    // 拉长到多少秒
    ttlMode: 'keep',     // keep 不动 / short 压到 3 秒逼系统每次重取 / long 拉长
    shortSeconds: 3,
    patchAll: 1          // 1=命中多个位置块全改（系统可能取任意一个）
  }

  // ============================ 1. 引擎探测 ============================
  var ENGINE = (function () {
    try {
      if (typeof $task !== 'undefined') return 'quanx'
      if (typeof $loon !== 'undefined') return 'loon'
      if (typeof $rocket !== 'undefined') return 'rocket'
      if (typeof $environment !== 'undefined' && $environment) {
        if ($environment['surge-version']) return 'surge'
        if ($environment['stash-version']) return 'stash'
      }
      if (typeof $persistentStore !== 'undefined') return 'surge'
    } catch (e) {}
    return 'unknown'
  })()

  // ============================ 2. 日志 ============================
  var LOG_LEVEL = LOG_LEVELS.info
  function log(level, msg) {
    if (LOG_LEVELS[level] === undefined) level = 'info'
    if (LOG_LEVELS[level] > LOG_LEVEL) return
    try {
      var line = '[wloc27][' + level + '] ' + msg
      if (typeof console !== 'undefined' && console.log) console.log(line)
    } catch (e) {}
  }

  // ============================ 3. 存储 ============================
  function storeRead(key) {
    try {
      if (typeof $persistentStore !== 'undefined' && $persistentStore.read) {
        return $persistentStore.read(key)
      }
      if (typeof $prefs !== 'undefined' && $prefs.valueForKey) {
        return $prefs.valueForKey(key)
      }
    } catch (e) {}
    return null
  }

  function storeWrite(key, value) {
    try {
      if (typeof $persistentStore !== 'undefined' && $persistentStore.write) {
        return $persistentStore.write(value, key)
      }
      if (typeof $prefs !== 'undefined' && $prefs.setValueForKey) {
        return $prefs.setValueForKey(value, key)
      }
    } catch (e) {}
    return false
  }

  // ============================ 4. 参数 ============================
  function parseArgString(raw) {
    var out = {}
    if (!raw || typeof raw !== 'string') return out
    var pairs = raw.split(/[&,]/)
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i].trim()
      if (!p) continue
      var eq = p.indexOf('=')
      if (eq < 0) { out[p.toLowerCase()] = '1'; continue }
      var k = p.slice(0, eq).trim().toLowerCase()
      var v = p.slice(eq + 1).trim()
      try { v = decodeURIComponent(v) } catch (e) {}
      out[k] = v
    }
    return out
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null
    var n = Number(v)
    return isFinite(n) ? n : null
  }

  // 优先级：持久化设置(选点页/快捷指令) > 模块参数 > 默认
  function resolveConfig() {
    var cfg = {}
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k]

    var arg = {}
    try { if (typeof $argument === 'string') arg = parseArgString($argument) } catch (e) {}
    for (var ak in arg) {
      if (DEFAULTS[ak] === undefined) continue
      if (typeof DEFAULTS[ak] === 'number') {
        var n = num(arg[ak]); if (n !== null) cfg[ak] = n
      } else if (typeof DEFAULTS[ak] === 'string') {
        cfg[ak] = arg[ak]
      }
    }

    var saved = storeRead(STORE_KEY)
    if (!saved) saved = storeRead(STORE_KEY_OLD)
    if (saved) {
      try {
        var obj = typeof saved === 'string' ? JSON.parse(saved) : saved
        if (obj && typeof obj === 'object') {
          for (var sk in DEFAULTS) {
            if (obj[sk] === undefined || obj[sk] === null || obj[sk] === '') continue
            if (typeof DEFAULTS[sk] === 'number') {
              var sn = num(obj[sk]); if (sn !== null) cfg[sk] = sn
            } else if (typeof DEFAULTS[sk] === 'string') {
              cfg[sk] = String(obj[sk])
            }
          }
        }
      } catch (e) {
        log('warn', '设置解析失败: ' + e)
      }
    }

    if (cfg.logLevel && LOG_LEVELS[cfg.logLevel] !== undefined) LOG_LEVEL = LOG_LEVELS[cfg.logLevel]
    return cfg
  }

  // ============================ 5. 字节工具 ============================
  function isU8(v) {
    return v && typeof v === 'object' && typeof v.length === 'number' &&
      (typeof v.BYTES_PER_ELEMENT === 'undefined' || v.BYTES_PER_ELEMENT === 1)
  }

  function toU8(v) {
    if (!v) return null
    if (v instanceof Uint8Array) return v
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return new Uint8Array(v)
    if (typeof v === 'string') return binaryStringToU8(v)
    if (isU8(v)) return toU8Array(v)
    return null
  }

  function toU8Array(v) {
    var out = new Uint8Array(v.length)
    for (var i = 0; i < v.length; i++) out[i] = v[i] & 0xff
    return out
  }

  function binaryStringToU8(s) {
    var out = new Uint8Array(s.length)
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
    return out
  }

  function u8ToBinaryString(u) {
    var s = ''
    var CHUNK = 0x8000
    for (var i = 0; i < u.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u.subarray(i, i + CHUNK))
    }
    return s
  }

  function concat(parts) {
    var total = 0, i
    for (i = 0; i < parts.length; i++) total += parts[i].length
    var out = new Uint8Array(total)
    var off = 0
    for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length }
    return out
  }

  function u8slice(u, a, b) {
    return u.subarray(a, b === undefined ? u.length : b)
  }

  // 8 字节共享缓冲：scratch 与 DataView 必须落在同一个 ArrayBuffer 上
  var _ab8 = new ArrayBuffer(8)
  var _scratch = new Uint8Array(_ab8)
  var _dv = new DataView(_ab8)

  function readDouble(u, pos, littleEndian) {
    for (var i = 0; i < 8; i++) _scratch[i] = u[pos + i]
    return _dv.getFloat64(0, littleEndian !== false)
  }

  function doubleBytes(value, littleEndian) {
    _dv.setFloat64(0, value, littleEndian !== false)
    var out = new Uint8Array(8)
    for (var i = 0; i < 8; i++) out[i] = _scratch[i]
    return out
  }

  function readFloat(u, pos, littleEndian) {
    for (var i = 0; i < 4; i++) _scratch[i] = u[pos + i]
    return _dv.getFloat32(0, littleEndian !== false)
  }

  function floatBytes(value, littleEndian) {
    _dv.setFloat32(0, value, littleEndian !== false)
    var out = new Uint8Array(4)
    for (var i = 0; i < 4; i++) out[i] = _scratch[i]
    return out
  }

  // ============================ 6. protobuf 编解码 ============================
  function readVarint(u, pos, end) {
    var result = 0n
    var shift = 0n
    var count = 0
    while (pos < end) {
      var b = u[pos++]
      if (count === 9 && (b & 0x7f) > 1) throw new Error('varint overflow')
      result |= BigInt(b & 0x7f) << shift
      shift += 7n
      if ((b & 0x80) === 0) return { value: result, pos: pos }
      if (++count > 10) throw new Error('varint too long')
    }
    throw new Error('varint eof')
  }

  function writeVarint(v) {
    var x = BigInt(v)
    if (x < 0n) x += 1n << 64n
    var out = []
    do {
      var b = Number(x & 0x7fn)
      x >>= 7n
      if (x > 0n) b |= 0x80
      out.push(b)
    } while (x > 0n)
    return new Uint8Array(out)
  }

  function decodeMessage(u, start, end, depth) {
    var fields = []
    var pos = start
    while (pos < end) {
      var t = readVarint(u, pos, end)
      pos = t.pos
      var tag = t.value
      var no = Number(tag >> 3n)
      var wire = Number(tag & 7n)
      if (no <= 0 || no > 536870911) throw new Error('bad field number ' + no)

      if (wire === 0) {
        var v = readVarint(u, pos, end)
        pos = v.pos
        fields.push({ no: no, wire: 0, varint: v.value })
      } else if (wire === 1) {
        if (pos + 8 > end) throw new Error('truncated fixed64')
        fields.push({ no: no, wire: 1, raw: u8slice(u, pos, pos + 8), littleEndian: true })
        pos += 8
      } else if (wire === 2) {
        var l = readVarint(u, pos, end)
        pos = l.pos
        var n = Number(l.value)
        if (n < 0 || pos + n > end) throw new Error('truncated bytes')
        var payload = u8slice(u, pos, pos + n)
        pos += n
        var child = null
        if (depth < 16 && n > 0) {
          try {
            var c = decodeMessage(payload, 0, payload.length, depth + 1)
            if (c && c.fields && c.fields.length) child = c
          } catch (e) { child = null }
        }
        fields.push({ no: no, wire: 2, raw: payload, child: child, dirty: false })
      } else if (wire === 5) {
        if (pos + 4 > end) throw new Error('truncated fixed32')
        fields.push({ no: no, wire: 5, raw: u8slice(u, pos, pos + 4), littleEndian: true })
        pos += 4
      } else {
        throw new Error('unsupported wire type ' + wire)
      }
    }
    return { fields: fields }
  }

  function encodeMessage(node) {
    var parts = []
    for (var i = 0; i < node.fields.length; i++) {
      var f = node.fields[i]
      parts.push(writeVarint((BigInt(f.no) << 3n) | BigInt(f.wire)))
      if (f.wire === 0) {
        parts.push(writeVarint(f.varint))
      } else if (f.wire === 1 || f.wire === 5) {
        parts.push(f.raw)
      } else if (f.wire === 2) {
        // 子节点被改过才重编码，否则原样写回 raw，保证未触及的字段零损耗
        var payload = (f.child && (f.dirty || f.child.dirty)) ? encodeMessage(f.child) : f.raw
        parts.push(writeVarint(BigInt(payload.length)))
        parts.push(payload)
      }
    }
    return concat(parts)
  }

  // 标记从根到该节点的路径为 dirty
  function markDirty(node) {
    node.dirty = true
  }

  // ============================ 7. 坐标候选定位 ============================
  function fieldDouble(f) {
    if (!f) return null
    if (f.wire === 1) return readDouble(f.raw, 0, f.littleEndian !== false)
    return null
  }

  function fieldFloat(f) {
    if (!f) return null
    if (f.wire === 5) return readFloat(f.raw, 0, f.littleEndian !== false)
    return null
  }

  function isLat(v) { return v !== null && Math.abs(v) >= 0.0001 && Math.abs(v) <= 90 }
  function isLon(v) { return v !== null && Math.abs(v) >= 0.0001 && Math.abs(v) <= 180 }
  function isSeconds(v) { return v !== null && v > 1.4e9 && v < 2.3e9 }

  // 在整棵树里找「纬度 / 经度 / 精度」三连，打分取最优
  function findCandidates(root) {
    var found = []

    function walk(node, path, depth, chain) {
      var fields = node.fields || []
      for (var i = 0; i < fields.length - 1; i++) {
        var f1 = fields[i]
        var f2 = fields[i + 1]
        var v1 = fieldDouble(f1), v2 = fieldDouble(f2)
        var isFloat32 = false
        if ((v1 === null || v2 === null)) {
          var w1 = fieldFloat(f1), w2 = fieldFloat(f2)
          if (w1 !== null && w2 !== null) { v1 = w1; v2 = w2; isFloat32 = true }
        }
        if (v1 === null || v2 === null) continue
        if (!isLat(v1) || !isLon(v2)) continue

        var score = 10
        var accIndex = -1
        for (var k = i + 2; k < Math.min(fields.length, i + 6); k++) {
          var av = fieldDouble(fields[k]) || fieldFloat(fields[k])
          if (av !== null && av > 0 && av <= 5000) { accIndex = k; score += 5; break }
        }
        var tsIndex = -1
        for (var t = 0; t < fields.length; t++) {
          if (fields[t].wire === 0) {
            var sec = Number(fields[t].varint)
            if (isSeconds(sec)) { tsIndex = t; score += 4; break }
          }
        }
        if (fields.length >= 6) score += 3
        if (depth >= 2) score += 2
        if (Math.abs(v1) < 0.001 || Math.abs(v2) < 0.001) score -= 6

        found.push({
          node: node, path: path, index: i, chain: chain,
          latIndex: i, lonIndex: i + 1, accIndex: accIndex, tsIndex: tsIndex,
          lat: v1, lon: v2, score: score, float32: isFloat32, depth: depth
        })
      }
      for (var j = 0; j < fields.length; j++) {
        var f = fields[j]
        if (f.wire === 2 && f.child) {
          walk(f.child, path.concat([j]), depth + 1, chain.concat([f.child]))
        }
      }
    }

    walk(root, [], 0, [root])
    found.sort(function (a, b) { return b.score - a.score })
    return found
  }

  function applyCandidate(cand, target) {
    var fields = cand.node.fields
    var latF = fields[cand.latIndex]
    var lonF = fields[cand.lonIndex]
    var littleEndian = latF.littleEndian !== false
    var useFloat = cand.float32

    latF.raw = useFloat ? floatBytes(target.lat, littleEndian) : doubleBytes(target.lat, littleEndian)
    lonF.raw = useFloat ? floatBytes(target.lon, littleEndian) : doubleBytes(target.lon, littleEndian)

    var changed = { lat: true, lon: true, accuracy: false, timestamp: false }

    if (cand.accIndex >= 0) {
      var accF = fields[cand.accIndex]
      var accLE = accF.littleEndian !== false
      accF.raw = accF.wire === 5 ? floatBytes(target.accuracy, accLE) : doubleBytes(target.accuracy, accLE)
      changed.accuracy = true
    }
    if (cand.tsIndex >= 0 && target.updateTimestamp) {
      var tsF = fields[cand.tsIndex]
      tsF.varint = BigInt(Math.floor(Date.now() / 1000))
      changed.timestamp = true
    }
    // 从根到该节点的整条链都要标脏，否则父层仍会写回原始 payload
    var chain = cand.chain || [cand.node]
    for (var c = 0; c < chain.length; c++) chain[c].dirty = true
    return changed
  }

  // 响应里可能存在多个位置块（多 AP / 多估计），系统取哪个不确定，全改最稳
  function applyAllCandidates(cands, target, patchAll) {
    var picked = cands.filter(function (c) { return c.score >= 12 })
    if (!picked.length) return null
    if (!patchAll) picked = picked.slice(0, 1)

    var total = { count: 0, accuracy: false, timestamp: false }
    for (var i = 0; i < picked.length; i++) {
      var r = applyCandidate(picked[i], target)
      total.count++
      if (r.accuracy) total.accuracy = true
      if (r.timestamp) total.timestamp = true
    }
    return total
  }

  // 把命中节点里的「短 TTL」改写掉
  //   seconds 给小数：压到几秒，逼系统别缓存，下次必然重新请求
  //   seconds 给大数：拉长，让假坐标多留一会儿
  function setTtlInNode(node, seconds) {
    var hit = 0
    var fields = node.fields || []
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i]
      if (f.wire !== 0) continue
      var v = Number(f.varint)
      // 10~600 秒且不像时间戳，才当成 TTL 处理
      if (v >= 10 && v <= 600 && !isSeconds(v)) {
        f.varint = BigInt(Math.floor(seconds))
        hit++
      }
    }
    if (hit) node.dirty = true
    return hit
  }

  function extendTtlInNode(node, seconds) {
    return setTtlInNode(node, seconds)
  }

  // ============================ 8. 字节级兜底（结构不认识时） ============================
  function scanDoubles(u, littleEndian) {
    var hits = []
    var len = u.length
    for (var pos = 0; pos + 8 <= len; pos++) {
      // 要求前面紧跟一个 wire=1 的 tag（field_tag = (no<<3)|1，低 3 位是 001，且 tag 在 1..0x0F 之间常见）
      var prev = pos > 0 ? u[pos - 1] : 0
      if ((prev & 0x07) !== 1) continue
      var no = prev >> 3
      if (no <= 0 || no > 32) continue
      var v = readDouble(u, pos, littleEndian)
      hits.push({ pos: pos, no: no, value: v })
    }
    return hits
  }

  function scanPatch(u, target) {
    var best = null
    var endians = [true, false]
    for (var e = 0; e < endians.length; e++) {
      var le = endians[e]
      var hits = scanDoubles(u, le)
      for (var i = 0; i < hits.length - 1; i++) {
        var a = hits[i], b = hits[i + 1]
        if (!isLat(a.value) || !isLon(b.value)) continue
        var score = 10
        if (b.pos - a.pos === 9) score += 4  // tag(1) + 8 字节 double 的紧凑排布
        if (!best || score > best.score) {
          best = { a: a, b: b, score: score, littleEndian: le }
        }
      }
    }
    if (!best || best.score < 12) return null

    var out = new Uint8Array(u.length)
    out.set(u, 0)
    var la = doubleBytes(target.lat, best.littleEndian)
    var lb = doubleBytes(target.lon, best.littleEndian)
    out.set(la, best.a.pos)
    out.set(lb, best.b.pos)
    return { bytes: out, lat: best.a.value, lon: best.b.value, endian: best.littleEndian ? 'le' : 'be' }
  }

  // ============================ 9. 轨迹 ============================
  function parsePath(str) {
    var pts = []
    if (!str) return pts
    var chunks = String(str).split(/[;|]/)
    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i].trim()
      if (!c) continue
      var p = c.split(',')
      if (p.length !== 2) continue
      var lat = Number(p[0]), lon = Number(p[1])
      if (isLat(lat) && isLon(lon)) pts.push({ lat: lat, lon: lon })
    }
    return pts
  }

  function haversine(a, b) {
    var R = 6371000
    var rad = Math.PI / 180
    var dLat = (b.lat - a.lat) * rad
    var dLon = (b.lon - a.lon) * rad
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
  }

  function positionAt(cfg, nowMs) {
    var path = parsePath(cfg.trackPath)
    if (path.length === 0) return null
    if (path.length === 1) return path[0]

    var start = cfg.trackStart > 0 ? cfg.trackStart : nowMs
    if (cfg.trackStart > 0 && cfg.trackStart > 1e12) start = cfg.trackStart // 毫秒
    else if (cfg.trackStart > 0) start = cfg.trackStart * 1000          // 秒

    var elapsed = (nowMs - start) / 1000
    if (elapsed < 0) elapsed = 0

    var speed = cfg.trackSpeed > 0 ? cfg.trackSpeed : 1.4
    var segs = []
    var total = 0
    for (var i = 0; i < path.length - 1; i++) {
      var d = haversine(path[i], path[i + 1])
      segs.push({ from: path[i], to: path[i + 1], len: d })
      total += d
    }
    if (cfg.trackLoop && total > 0) {
      var back = haversine(path[path.length - 1], path[0])
      segs.push({ from: path[path.length - 1], to: path[0], len: back })
      total += back
    }
    if (total <= 0) return path[0]

    var dist = speed * elapsed
    if (cfg.trackLoop) dist = dist % total
    else dist = Math.min(dist, total)

    var acc = 0
    for (var s = 0; s < segs.length; s++) {
      if (dist <= acc + segs[s].len) {
        var r = segs[s].len > 0 ? (dist - acc) / segs[s].len : 0
        return {
          lat: segs[s].from.lat + (segs[s].to.lat - segs[s].from.lat) * r,
          lon: segs[s].from.lon + (segs[s].to.lon - segs[s].from.lon) * r
        }
      }
      acc += segs[s].len
    }
    return path[0]
  }

  // ============================ 10. 主改写入口 ============================
  function patchPayload(bytes, target) {
    // 路线 A：结构解析
    try {
      var root = decodeMessage(bytes, 0, bytes.length, 0)
      var cands = findCandidates(root)
      var applied = applyAllCandidates(cands, target, target.patchAll !== 0)
      if (applied) {
        var ttlSec = 0
        if (target.ttlMode === 'short') ttlSec = target.shortSeconds || 3
        else if (target.ttlMode === 'long' || target.extendTtl) ttlSec = target.ttlSeconds || 1800

        var ttlHit = 0
        if (ttlSec) {
          for (var ci = 0; ci < cands.length; ci++) {
            if (cands[ci].score < 12) continue
            ttlHit += setTtlInNode(cands[ci].node, ttlSec)
          }
        }
        var out = encodeMessage(root)
        var first = cands[0]
        log('info', '命中结构 depth=' + first.depth +
          ' 块数=' + applied.count +
          ' 原坐标 ' + first.lat.toFixed(6) + ',' + first.lon.toFixed(6) +
          ' → ' + target.lat.toFixed(6) + ',' + target.lon.toFixed(6) +
          ' 精度' + (applied.accuracy ? '改' : '未改') +
          ' 时间戳' + (applied.timestamp ? '刷' : '未刷') +
          (ttlSec ? (' TTL→' + ttlSec + 's 段数=' + ttlHit) : ''))
        return { ok: true, bytes: out, method: 'proto', blocks: applied.count, ttlHit: ttlHit }
      }
      log('warn', '结构解析成功但没找到坐标候选（字段结构可能是 iOS 27 新格式），转字节扫描')
    } catch (e) {
      log('warn', 'protobuf 解析失败：' + e + '，转字节扫描')
    }

    // 路线 B：字节扫描
    var scanned = scanPatch(bytes, target)
    if (scanned) {
      log('info', '字节扫描命中（' + scanned.endian + '）原坐标 ' +
        scanned.lat.toFixed(6) + ',' + scanned.lon.toFixed(6))
      return { ok: true, bytes: scanned.bytes, method: 'scan' }
    }

    return { ok: false, bytes: bytes, method: 'none' }
  }

  // ============================ 11. 引擎适配 ============================
  function getBodyBytes() {
    var r = (typeof $response !== 'undefined' && $response) ? $response : {}
    var sources = ['bodyBytes', 'body']
    for (var i = 0; i < sources.length; i++) {
      var v = r[sources[i]]
      if (!v) continue
      var u = toU8(v)
      if (u && u.length) { log('debug', 'body 来源: ' + sources[i] + ' ' + u.length + 'B'); return u }
    }
    return null
  }

  function finishBytes(bytes) {
    if (ENGINE === 'quanx' || ENGINE === 'rocket') {
      // 这两个引擎对二进制 body 走 binary string 最稳
      try { $done({ body: u8ToBinaryString(bytes) }); return } catch (e) {}
    }
    try { $done({ bodyBytes: bytes }); return } catch (e) {}
    try { $done({ body: u8ToBinaryString(bytes) }); return } catch (e) {}
    $done({})
  }

  function currentTarget(cfg, nowMs) {
    if (cfg.mode === 'off') return null
    if (cfg.mode === 'track') {
      var p = positionAt(cfg, nowMs)
      if (p) {
        return {
          lat: p.lat, lon: p.lon,
          accuracy: cfg.accuracy || DEFAULT_ACCURACY,
          updateTimestamp: cfg.updateTimestamp,
          patchAll: cfg.patchAll,
          extendTtl: cfg.extendTtl,
          ttlSeconds: cfg.ttlSeconds,
          ttlMode: cfg.ttlMode,
          shortSeconds: cfg.shortSeconds
        }
      }
      log('warn', '轨迹模式但 trackPath 为空，回退 fixed')
    }
    if (cfg.lat === null || cfg.lon === null) return null
    if (!isLat(cfg.lat) || !isLon(cfg.lon)) {
      log('error', '坐标越界: ' + cfg.lat + ',' + cfg.lon)
      return null
    }
    return {
      lat: cfg.lat, lon: cfg.lon,
      accuracy: cfg.accuracy || DEFAULT_ACCURACY,
      updateTimestamp: cfg.updateTimestamp,
      patchAll: cfg.patchAll,
      extendTtl: cfg.extendTtl,
      ttlSeconds: cfg.ttlSeconds,
      ttlMode: cfg.ttlMode,
      shortSeconds: cfg.shortSeconds
    }
  }

  // 每次被调用都留一条时间戳，选点页据此判断「系统到底有没有在发请求」
  function recordHit(target, result) {
    try {
      storeWrite('wloc27_last_hit', JSON.stringify({
        at: Date.now(),
        ok: !!(result && result.ok),
        blocks: result && result.blocks ? result.blocks : 0,
        method: result ? result.method : 'none',
        lat: target.lat,
        lon: target.lon
      }))
    } catch (e) {}
  }

  function handleResponse() {
    var bytes = getBodyBytes()
    if (!bytes) {
      log('warn', '拿不到响应体内存（引擎没给 bodyBytes），本次透传')
      return $done({})
    }
    var cfg = resolveConfig()
    var target = currentTarget(cfg, Date.now())
    if (!target) {
      log('debug', '未设置坐标，透传（' + bytes.length + 'B）')
      return $done({})
    }
    var result = patchPayload(bytes, target)
    recordHit(target, result)
    if (!result.ok) {
      log('error', '改坐标失败（' + result.method + '），透传 ' + bytes.length + 'B')
      return $done({})
    }
    finishBytes(result.bytes)
  }

  // ============================ 12. 入口 ============================
  var API = {
    decodeMessage: decodeMessage,
    encodeMessage: encodeMessage,
    findCandidates: findCandidates,
    applyAllCandidates: applyAllCandidates,
    extendTtlInNode: extendTtlInNode,
    setTtlInNode: setTtlInNode,
    patchPayload: patchPayload,
    scanPatch: scanPatch,
    positionAt: positionAt,
    parsePath: parsePath,
    resolveConfig: resolveConfig,
    currentTarget: currentTarget,
    doubleBytes: doubleBytes,
    writeVarint: writeVarint,
    isLat: isLat,
    isLon: isLon
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API
    return
  }

  try {
    handleResponse()
  } catch (e) {
    log('error', '脚本异常: ' + (e && e.message ? e.message : e))
    try { $done({}) } catch (e2) {}
  }
})()
