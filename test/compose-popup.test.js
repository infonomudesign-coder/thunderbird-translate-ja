"use strict";
// compose popup の動作(二重実行・古い本文・途中切れ確認)を jsdom で検証する
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));
const okRes = (text, stop) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ content: [{ type: "text", text }], stop_reason: stop || "end_turn" }) });

async function load({ details, fetchImpl }) {
  const state = { details: { ...details }, sets: [], gets: 0, fetches: [] };
  const messenger = {
    tabs: { query: async () => [{ id: 5 }] },
    compose: {
      getComposeDetails: async () => { state.gets++; if (state.getGate) await state.getGate; return { ...state.details }; },
      setComposeDetails: async (id, d) => { state.sets.push([id, d]); Object.assign(state.details, d.plainTextBody != null ? { plainTextBody: d.plainTextBody } : d); },
    },
    storage: { local: { get: async () => ({ apiKey: "sk-test", model: "", senderMemo: "" }) } },
    messages: { getFull: async () => ({ contentType: "text/plain", body: "original mail" }) },
    runtime: { openOptionsPage: () => {} },
  };
  const file = path.join(__dirname, "..", "compose", "compose.html");
  const dom = await JSDOM.fromFile(file, {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
    beforeParse(w) { w.messenger = messenger; w.fetch = (...a) => { state.fetches.push(a); return fetchImpl(...a); }; },
  });
  await new Promise((r) => dom.window.addEventListener("load", r));
  await tick(30);
  return { w: dom.window, d: dom.window.document, state };
}

test("生成は最新の本文で作られ、二重クリックでもAPI呼び出しは1回", async () => {
  let release; const gate = new Promise((r) => (release = r));
  const { w, d, state } = await load({
    details: { isPlainText: true, plainTextBody: "OLD draft", subject: "s", type: "new" },
    fetchImpl: async () => { await gate; return okRes("1行目\n2行目\n3行目"); },
  });
  state.details.plainTextBody = "NEW draft after init";   // 初期化後に本文が変更された
  d.getElementById("generate").click(); d.getElementById("generate").click();
  await tick(30);
  assert.strictEqual(state.fetches.length, 1);
  const sent = JSON.parse(state.fetches[0][1].body).messages[0].content;
  assert.ok(sent.includes("NEW draft after init") && !sent.includes("OLD draft"));
  assert.strictEqual(d.getElementById("generate").disabled, true);   // 実行中は押せない
  release(); await tick(50);
  assert.strictEqual(d.getElementById("generate").disabled, false);
  assert.strictEqual(d.querySelectorAll("#subjects .subj").length, 3);
  assert.ok(!sent.includes("sk-test"));
  w.close();
});

test("件名: 生成中に件名が編集されると確認が出て、承認で置換される", async () => {
  const { w, d, state } = await load({
    details: { isPlainText: true, plainTextBody: "b", subject: "orig", type: "new" },
    fetchImpl: async () => okRes("案A\n案B\n案C"),
  });
  d.getElementById("generate").click(); await tick(50);
  state.details.subject = "user edited";
  d.querySelector("#subjects button").click(); await tick(30);
  assert.strictEqual(d.getElementById("confirm").hidden, false);
  assert.match(d.getElementById("confirmMsg").textContent, /件名が編集/);
  assert.strictEqual(state.sets.length, 0);
  d.getElementById("confirmYes").click(); await tick(30);
  assert.strictEqual(JSON.stringify(state.sets.at(-1)), JSON.stringify([5, { subject: "案A" }]));
  w.close();
});

test("途中切れの出力は、挿入前に必ず確認が出る(件名・本文とも)", async () => {
  const { w, d, state } = await load({
    details: { isPlainText: true, plainTextBody: "> quote", subject: "s", type: "reply", relatedMessageId: 9 },
    fetchImpl: async () => okRes("返信案", "max_tokens"),
  });
  d.querySelector('input[value="reply"]').checked = true;
  d.getElementById("generate").click(); await tick(60);
  d.getElementById("insert").click(); await tick(30);
  assert.strictEqual(d.getElementById("confirm").hidden, false);
  assert.match(d.getElementById("confirmMsg").textContent, /途中で切れ/);
  assert.strictEqual(state.sets.length, 0);
  d.getElementById("confirmYes").click(); await tick(30);
  assert.strictEqual(state.sets.length, 1);
  assert.strictEqual(state.sets[0][1].plainTextBody, "返信案\n\n> quote");   // 引用は保持
  w.close();
});

test("12000字を超える本文では「整える」を選べない / 新規作成では「返信」を選べない", async () => {
  const { w, d } = await load({
    details: { isPlainText: true, plainTextBody: "あ".repeat(12001), subject: "s", type: "new" },
    fetchImpl: async () => okRes("x"),
  });
  assert.strictEqual(d.querySelector('input[value="polish"]').disabled, true);
  assert.strictEqual(d.querySelector('input[value="reply"]').disabled, true);
  w.close();
});

test("推敲: 生成中に本文が編集されたら置換せずエラー、編集がなければ確認後に置換", async () => {
  const mk = () => load({ details: { isPlainText: true, plainTextBody: "draft", subject: "s", type: "new" }, fetchImpl: async () => okRes("整えた") });
  let { w, d, state } = await mk();
  d.querySelector('input[value="polish"]').checked = true;
  d.getElementById("generate").click(); await tick(50);
  state.details.plainTextBody = "user typed more";
  d.getElementById("polishApply").click(); await tick(10);
  d.getElementById("confirmYes").click(); await tick(30);
  assert.strictEqual(state.sets.length, 0);
  assert.match(d.getElementById("error").textContent, /編集されました/);
  w.close();
  ({ w, d, state } = await mk());
  d.querySelector('input[value="polish"]').checked = true;
  d.getElementById("generate").click(); await tick(50);
  d.getElementById("polishApply").click(); await tick(10);
  assert.match(d.getElementById("confirmMsg").textContent, /置き換わります/);
  d.getElementById("confirmYes").click(); await tick(30);
  assert.strictEqual(JSON.stringify(state.sets.at(-1)), JSON.stringify([5, { plainTextBody: "整えた" }]));
  w.close();
});

test("本文の取得待ち中に「中止」を押すと、API送信は行われない", async () => {
  const { w, d, state } = await load({
    details: { isPlainText: true, plainTextBody: "b", subject: "s", type: "new" },
    fetchImpl: async () => okRes("案A\n案B\n案C"),
  });
  let release; state.getGate = new Promise((r) => (release = r));
  d.getElementById("generate").click(); await tick(20);
  assert.strictEqual(d.getElementById("cancel").hidden, false);
  d.getElementById("cancel").click();
  release(); await tick(50);
  assert.strictEqual(state.fetches.length, 0);
  assert.strictEqual(d.getElementById("generate").disabled, false);   // 中止後は再度押せる
  assert.strictEqual(d.getElementById("cancel").hidden, true);
  w.close();
});
