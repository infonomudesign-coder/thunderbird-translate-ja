"use strict";
const $ = (id) => document.getElementById(id);
$("def").textContent = AiLib.DEFAULT_MODEL;
const say = (m) => { $("msg").textContent = m; };

(async function load() {
  try {
    const s = await messenger.storage.local.get({ apiKey: "", model: "", senderMemo: "" });
    $("apiKey").value = s.apiKey; $("model").value = s.model; $("memo").value = s.senderMemo;
  } catch (e) { say("設定を読み込めませんでした。"); }
})();

$("save").addEventListener("click", async () => {
  try {
    await messenger.storage.local.set({ apiKey: $("apiKey").value.trim(), model: $("model").value.trim(), senderMemo: $("memo").value });
    say("保存しました。");
  } catch (e) { say("保存に失敗しました。"); }
});
$("del").addEventListener("click", async () => {
  try { await messenger.storage.local.remove("apiKey"); $("apiKey").value = ""; say("APIキーを削除しました。"); }
  catch (e) { say("削除に失敗しました。"); }
});
