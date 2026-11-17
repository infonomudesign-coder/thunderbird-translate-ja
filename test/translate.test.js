"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { JSDOM } = require("jsdom");
const L = require("../lib/translate.js");
const DOMParserCtor = new JSDOM("").window.DOMParser;

const ok = (segs) => ({ ok: true, status: 200, json: async () => [segs.map((s) => [s]), null, "en"] });

test("splitText: 短文はそのまま", () => assert.deepStrictEqual(L.splitText("abc", 10), ["abc"]));
test("splitText: 結合すると原文と一致し、全て max 以下", () => {
  const t = ("Para one. Sentence two! Sentence three?\n\n" + "x".repeat(50) + "\nline\n\n").repeat(20);
  const ch = L.splitText(t, 100);
  assert.ok(ch.every((c) => c.length <= 100));
  assert.strictEqual(ch.join(""), t);
});
test("splitText: 区切りのない超長文は強制分割、サロゲートペアを壊さない", () => {
  const t = "😀".repeat(25);
  const ch = L.splitText(t, 10);
  assert.ok(ch.every((c) => Array.from(c).length <= 10));
  assert.strictEqual(ch.join(""), t);
  assert.ok(ch.every((c) => !/[\ud800-\udbff]$/.test(c)));
});
test("htmlToText: script/style 除去と段落境界", () => {
  const h = "<style>p{}</style><script>alert(1)</script><p>Hello</p><p>World<br>Line2</p><img src='http://x/y.png'>";
  assert.strictEqual(L.htmlToText(h, DOMParserCtor), "Hello\n\nWorld\nLine2");
});
test("extractBody: alternative は text/plain 優先、添付テキストは除外", () => {
  const part = { contentType: "multipart/mixed", parts: [
    { contentType: "multipart/alternative", parts: [
      { contentType: "text/plain", body: "plain body" }, { contentType: "text/html", body: "<p>html body</p>" } ] },
    { contentType: "text/plain", name: "secret.txt", body: "ATTACHMENT", headers: { "content-disposition": ["attachment; filename=secret.txt"] } },
    { contentType: "message/rfc822", parts: [{ contentType: "text/plain", body: "FORWARDED" }] } ] };
  assert.deepStrictEqual(L.extractBody(part), { text: "plain body", kind: "plain" });
});
test("extractBody: inline でも名前付きテキスト/HTML 添付は除外(漏えい防止)", () => {
  const part = { contentType: "multipart/mixed", parts: [
    { contentType: "text/plain", body: "real body" },
    { contentType: "text/plain", name: "confidential.txt", body: "LEAK1", headers: { "content-disposition": ["inline; filename=confidential.txt"] } },
    { contentType: "text/html", body: "<p>LEAK2</p>", headers: { "content-disposition": ["inline; filename=\"a.html\""] } } ] };
  assert.deepStrictEqual(L.extractBody(part, true), { text: "real body", kind: "plain" });
});
test("extractBody: 最上位 message/rfc822 ラッパーは展開、入れ子の添付メールは除外", () => {
  const full = { contentType: "message/rfc822", parts: [{ contentType: "multipart/mixed", parts: [
    { contentType: "text/plain", body: "outer body" },
    { contentType: "message/rfc822", parts: [{ contentType: "text/plain", body: "NESTED" }] } ] }] };
  assert.deepStrictEqual(L.extractBody(full, true), { text: "outer body", kind: "plain" });
  assert.strictEqual(L.extractBody(full), null); // ルート指定なしなら展開しない
});
test("extractBody: 入れ子 mixed は葉に平坦化される", () => {
  const part = { contentType: "multipart/mixed", parts: [
    { contentType: "text/plain", body: "A" },
    { contentType: "multipart/mixed", parts: [{ contentType: "text/html", body: "<p>B</p>" }, { contentType: "text/plain", body: "C" }] } ] };
  const b = L.extractBody(part, true);
  assert.strictEqual(b.kind, "mixed");
  assert.deepStrictEqual(b.parts.map((p) => p.kind), ["plain", "html", "plain"]);
});
test("hardSplit: UTF-16 単位で上限を守りサロゲートを壊さない", () => {
  const t = "😀".repeat(25) + "a";
  const ch = L.hardSplit(t, 10);
  assert.ok(ch.every((c) => c.length <= 10));
  assert.strictEqual(ch.join(""), t);
  assert.ok(ch.every((c) => !/[\ud800-\udbff]$/.test(c)));
});
test("translateLong: 絵文字でも上限を UTF-16 単位で判定", async () => {
  const f = async () => ok(["x"]);
  assert.strictEqual((await L.translateLong("😀".repeat(L.TOTAL_MAX / 2), { fetchImpl: f })).truncated, false);
  assert.strictEqual((await L.translateLong("😀".repeat(L.TOTAL_MAX / 2 + 1), { fetchImpl: f })).truncated, true);
});
test("extractBody: HTML のみ / 本文なし(添付のみ)", () => {
  assert.strictEqual(L.extractBody({ contentType: "text/html", body: "<p>a</p>" }).kind, "html");
  assert.strictEqual(L.extractBody({ contentType: "multipart/mixed", parts: [{ contentType: "application/pdf", name: "a.pdf" }] }), null);
});
test("parseResponse: 正常 / 不正", () => {
  assert.strictEqual(L.parseResponse([[["こんにちは "], ["世界"]]]), "こんにちは 世界");
  assert.throws(() => L.parseResponse({}));
  assert.throws(() => L.parseResponse([[[null]]]));
});
test("translateChunk: POST フォームで送信し結果を返す", async () => {
  let req;
  const f = async (url, o) => { req = { url, o }; return ok(["訳"]); };
  assert.strictEqual(await L.translateChunk("a b&c", { fetchImpl: f }), "訳");
  assert.strictEqual(req.o.method, "POST");
  assert.strictEqual(req.o.body, "q=a%20b%26c");
});
test("translateChunk: 5xx は再試行して成功", async () => {
  let n = 0;
  const f = async () => (++n < 3 ? { ok: false, status: 503 } : ok(["ok"]));
  assert.strictEqual(await L.translateChunk("x", { fetchImpl: f, backoffMs: 1 }), "ok");
  assert.strictEqual(n, 3);
});
test("translateChunk: 4xx は再試行しない", async () => {
  let n = 0;
  await assert.rejects(L.translateChunk("x", { fetchImpl: async () => (n++, { ok: false, status: 400 }), backoffMs: 1 }), /HTTP 400/);
  assert.strictEqual(n, 1);
});
test("translateChunk: 不正応答はエラー", async () => {
  await assert.rejects(L.translateChunk("x", { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), retries: 0 }), /形式が不正/);
});
test("translateChunk: タイムアウト", async () => {
  const f = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
  await assert.rejects(L.translateChunk("x", { fetchImpl: f, timeoutMs: 20, retries: 0 }), /タイムアウト/);
});
test("translateChunk: 外部からの中断は AbortError", async () => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(L.translateChunk("x", { fetchImpl: async () => ok(["x"]), signal: ac.signal }), { name: "AbortError" });
});
test("translateLong: 複数チャンクを連結し空白を保持", async () => {
  const text = ("a".repeat(3000) + "\n\n") + ("b".repeat(3000) + "\n\n");
  const f = async (u, o) => ok(["[" + decodeURIComponent(o.body.slice(2)).trim().length + "]"]);
  const r = await L.translateLong(text, { fetchImpl: f });
  assert.strictEqual(r.total, 2); assert.strictEqual(r.text, "[3000]\n\n[3000]\n\n"); assert.strictEqual(r.error, null);
});
test("translateLong: 途中失敗で取得済み分と error を返す", async () => {
  const text = ("a".repeat(3000) + "\n\n") + ("b".repeat(3000) + "\n\n");
  let n = 0;
  const f = async () => (++n === 1 ? ok(["一"]) : { ok: false, status: 400 });
  const r = await L.translateLong(text, { fetchImpl: f, retries: 0 });
  assert.strictEqual(r.done, 1); assert.ok(r.error); assert.ok(r.text.startsWith("一"));
});
test("translateLong: 上限超過は truncated", async () => {
  const f = async () => ok(["x"]);
  const r = await L.translateLong("a. ".repeat(20000), { fetchImpl: f });
  assert.strictEqual(r.truncated, true);
});
