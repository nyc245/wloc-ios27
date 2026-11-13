/*
 * proto.test.mjs — wloc27 核心逻辑自测（Node 跑，不依赖代理引擎）
 * 覆盖：protobuf 往返无损 / 坐标指纹命中 / 改写结果 / 时间戳刷新 / 字节兜底 / 轨迹推进 / 越界拒绝
 */

import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const w = require('../scripts/wloc27.js')

// ---------- 独立手写的 protobuf 编码（不依赖被测实现，避免自证） ----------
function varint(n) {
  let x = BigInt(n)
  const out = []
  do {
    let b = Number(x & 0x7fn)
    x >>= 7n
    if (x > 0n) b |= 0x80
    out.push(b)
  } while (x > 0n)
  return Uint8Array.from(out)
}
function tag(no, wire) { return varint((BigInt(no) << 3n) | BigInt(wire)) }
function fVarint(no, n) { return cat(tag(no, 0), varint(n)) }
function dbl(no, v) {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, v, true)
  return cat(tag(no, 1), new Uint8Array(buf))
}
function fBytes(no, payload) { return cat(tag(no, 2), varint(payload.length), payload) }
function cat(...parts) {
  const total = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// 模拟 /clls/wloc 响应：外层包裹 → 位置块（lat/lon/acc/ts/未知字段）
const LOC = { lat: 31.230416, lon: 121.473701, acc: 65, ts: 1735689600 }
const inner = cat(
  dbl(1, LOC.lat),
  dbl(2, LOC.lon),
  dbl(3, LOC.acc),
  fVarint(4, LOC.ts),
  fBytes(5, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))
)
const sample = cat(
  fVarint(1, 1),
  fBytes(2, inner),
  fVarint(3, 7)
)

let pass = 0
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1 }
}

console.log('wloc27 core tests')

// 1. 往返无损
t('解码再编码与原字节完全一致', () => {
  const root = w.decodeMessage(sample, 0, sample.length, 0)
  const back = w.encodeMessage(root)
  assert.deepEqual(Array.from(back), Array.from(sample))
})

// 2. 指纹命中位置块
t('坐标指纹命中且分数达标', () => {
  const root = w.decodeMessage(sample, 0, sample.length, 0)
  const c = w.findCandidates(root)
  assert.ok(c.length >= 1, '至少一个候选')
  assert.ok(Math.abs(c[0].lat - LOC.lat) < 1e-9, 'lat 读取正确')
  assert.ok(Math.abs(c[0].lon - LOC.lon) < 1e-9, 'lon 读取正确')
  assert.ok(c[0].score >= 12, 'score=' + c[0].score)
  assert.ok(c[0].accIndex >= 0, '精度字段已定位')
  assert.ok(c[0].tsIndex >= 0, '时间戳字段已定位')
})

// 3. 改写
t('改写后坐标/精度/时间戳正确，未知字段保留', () => {
  const target = { lat: 39.9042, lon: 116.4074, accuracy: 12, updateTimestamp: 1 }
  const r = w.patchPayload(sample, target)
  assert.equal(r.ok, true)
  assert.equal(r.method, 'proto')

  const root = w.decodeMessage(r.bytes, 0, r.bytes.length, 0)
  const c = w.findCandidates(root)
  assert.ok(Math.abs(c[0].lat - 39.9042) < 1e-9, 'lat 已改')
  assert.ok(Math.abs(c[0].lon - 116.4074) < 1e-9, 'lon 已改')

  const innerNode = root.fields[1].child
  assert.equal(innerNode.fields[2].wire, 1)
  const accView = new DataView(innerNode.fields[2].raw.buffer, innerNode.fields[2].raw.byteOffset, 8)
  assert.ok(Math.abs(accView.getFloat64(0, true) - 12) < 1e-6, '精度已改')

  // 未知二进制字段（0xdeadbeef）必须原样保留
  const blob = innerNode.fields[4]
  assert.deepEqual(Array.from(blob.raw), [0xde, 0xad, 0xbe, 0xef])

  // 时间戳刷新到当前秒
  const ts = Number(innerNode.fields[3].varint)
  const now = Math.floor(Date.now() / 1000)
  assert.ok(Math.abs(ts - now) < 120, '时间戳已刷新: ' + ts)
})

// 4. 字节级兜底：构造非 protobuf 结构（无嵌套解析），只留 tag+double 对
t('字节扫描兜底能改到坐标', () => {
  const junk = cat(
    Uint8Array.from([0x00, 0xff, 0x13, 0x37]),
    tag(3, 1), w.doubleBytes(22.5431, true),
    tag(4, 1), w.doubleBytes(114.0579, true),
    Uint8Array.from([0x88, 0x99])
  )
  const r = w.patchPayload(junk, { lat: 30.2741, lon: 120.1551, accuracy: 20, updateTimestamp: 0 })
  assert.equal(r.ok, true)
  const lv = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.length)
  let found = []
  for (let i = 0; i + 8 <= r.bytes.length; i++) {
    // 找我们写进去的两个值
    try {
      const v = lv.getFloat64(i, true)
      if (Math.abs(v - 30.2741) < 1e-9 || Math.abs(v - 120.1551) < 1e-9) found.push(v)
    } catch (e) {}
  }
  assert.ok(found.length >= 1, '新坐标已写入字节流')
})

// 5. 无坐标时不动
t('没有可识别坐标时返回 ok=false 且字节不变', () => {
  const plain = cat(fVarint(1, 1), fBytes(2, Uint8Array.from([1, 2, 3])))
  const r = w.patchPayload(plain, { lat: 1, lon: 2, accuracy: 5, updateTimestamp: 0 })
  assert.equal(r.ok, false)
  assert.deepEqual(Array.from(r.bytes), Array.from(plain))
})

// 6. 轨迹推进
t('轨迹模式按速度沿路径推进', () => {
  const path = w.parsePath('30.0000,120.0000;30.0010,120.0000')
  assert.equal(path.length, 2)

  const t0 = 1700000000000
  const cfg = { trackPath: '30.0000,120.0000;30.0010,120.0000', trackSpeed: 1.4, trackStart: t0, trackLoop: 0 }
  const p0 = w.positionAt(cfg, t0)
  assert.ok(Math.abs(p0.lat - 30) < 1e-9, '起点正确')

  // 111.19 米 ≈ 0.001 度纬度；跑 40 秒 × 1.4 = 56 米
  const p1 = w.positionAt(cfg, t0 + 40000)
  const moved = (p1.lat - 30) * 111190
  assert.ok(moved > 50 && moved < 62, '移动距离约 ' + moved.toFixed(1) + ' 米')
  assert.ok(Math.abs(p1.lon - 120) < 1e-9, '经度不变')

  // 超过总长后被夹在终点
  const p2 = w.positionAt(cfg, t0 + 600000)
  assert.ok(Math.abs(p2.lat - 30.0010) < 1e-6, '终点正确')
})

// 7. 越界拒绝
t('经纬度范围判定正确', () => {
  assert.equal(w.isLat(31.23), true)
  assert.equal(w.isLat(91), false)
  assert.equal(w.isLat(0), false)
  assert.equal(w.isLon(121.47), true)
  assert.equal(w.isLon(181), false)
})

// 8. 多块全改：响应里给两个位置估计，系统可能取任意一个
t('多位置块全部改写', () => {
  const locA = cat(dbl(1, 31.230416), dbl(2, 121.473701), dbl(3, 65), fVarint(4, 1735689600))
  const locB = cat(dbl(1, 31.240000), dbl(2, 121.480000), dbl(3, 80), fVarint(4, 1735689601))
  const multi = cat(fVarint(1, 1), fBytes(2, locA), fBytes(3, locB))

  const target = { lat: 30.2741, lon: 120.1551, accuracy: 18, updateTimestamp: 0, patchAll: 1 }
  const r = w.patchPayload(multi, target)
  assert.equal(r.ok, true)
  assert.equal(r.blocks, 2, '两块都要改，实际 ' + r.blocks)

  const root = w.decodeMessage(r.bytes, 0, r.bytes.length, 0)
  const lats = []
  ;(function walk(n) {
    for (const f of n.fields || []) { if (f.child) walk(f.child) }
    for (let i = 0; i < (n.fields || []).length - 1; i++) {
      const a = n.fields[i], b = n.fields[i + 1]
      if (a.wire === 1 && b.wire === 1) {
        const v = new DataView(a.raw.buffer, a.raw.byteOffset, 8).getFloat64(0, true)
        if (Math.abs(v - 30.2741) < 1e-6) lats.push(v)
      }
    }
  })(root)
  assert.equal(lats.length, 2, '两处纬度都变成目标值')
})

// 9. TTL 拉长：只动 10~600 之间且不像时间戳的整数
t('TTL 拉长只命中短整数段', () => {
  const buf = cat(fVarint(1, 30), fVarint(2, 1735689600), fVarint(3, 5000))
  const node = w.decodeMessage(buf, 0, buf.length, 0)
  const hit = w.extendTtlInNode(node, 1800)
  assert.equal(hit, 1, '只改 30 那个')
  assert.equal(Number(node.fields[0].varint), 1800)
  assert.equal(Number(node.fields[1].varint), 1735689600, '时间戳不动')
  assert.equal(Number(node.fields[2].varint), 5000, '5000 超出范围不动')
})

// 10. ttlMode=short：把有效期压到 3 秒，逼系统下次重取
t('ttlMode=short 把 TTL 压到 3 秒', () => {
  const inner2 = cat(
    dbl(1, 31.230416), dbl(2, 121.473701), dbl(3, 65),
    fVarint(4, 1735689600), fVarint(5, 60)   // field5 = 60 秒有效期
  )
  const buf = cat(fVarint(1, 1), fBytes(2, inner2))
  const target = {
    lat: 30.2741, lon: 120.1551, accuracy: 20,
    updateTimestamp: 1, patchAll: 1, ttlMode: 'short', shortSeconds: 3
  }
  const r = w.patchPayload(buf, target)
  assert.equal(r.ok, true)
  assert.equal(r.ttlHit, 1, '命中 1 段 TTL')

  const root = w.decodeMessage(r.bytes, 0, r.bytes.length, 0)
  const fields = root.fields[1].child.fields
  const ttl = fields.find(f => f.wire === 0 && Number(f.varint) === 3)
  assert.ok(ttl, 'TTL 已压到 3')
  const ts = fields.find(f => f.wire === 0 && Number(f.varint) > 1.4e9)
  assert.ok(ts && Math.abs(Number(ts.varint) - Math.floor(Date.now() / 1000)) < 120, '时间戳同时被刷新')
})

console.log('\n' + pass + ' passed' + (process.exitCode ? ' / 有失败项' : ''))
