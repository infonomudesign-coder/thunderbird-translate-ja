"use strict";
const $ = (id) => document.getElementById(id);
const L = TranslateLib;

const state = { subject: "", body: "", subjectJa: "", bodyJa: "", showing: "orig", translated: false };
const ac = new AbortController();      // popup を閉じる=翻訳中断
window.addEventListener("pagehide", () => ac.abort());

function showError(msg) { const e = $("error"); e.textContent = msg; e.hidden = !msg; }
function render() {
  const ja = state.showing === "ja";
  $("subject").textContent = ja ? state.subjectJa : state.subject;
  $("body").textContent = ja ? state.bodyJa : state.body;
  $("subjLabel").textContent = ja ? "(訳)" : "(原文)";
  $("bodyLabel").textContent = ja ? "(訳)" : "(原文)";
  $("toggle").textContent = ja ? "原文を表示" : "訳を表示";
}

function bodyToText(b) {
  if (b.kind === "plain") return b.text;
  if (b.kind === "html") return L.htmlToText(b.text, DOMParser);
  return b.parts.map(bodyToText).join("\n\n"); // 各葉を個別に変換(HTMLの生マークアップを送らない)
}

async function init() {
  let msg;
  try {
    const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
    const shown = await messenger.messageDisplay.getDisplayedMessages(tabs[0].id);
    const list = Array.isArray(shown) ? shown : (shown && shown.messages) || [];
    if (!list.length) { showError("表示中のメールが見つかりません。"); return; }
    msg = list[0]; // 対象はここで一度だけ確定
    $("target").textContent = (list.length > 1 ? "複数選択中: 先頭のメールを翻訳します — " : "対象: ") + (msg.subject || "(件名なし)");
    state.subject = msg.subject || "";
    const full = await messenger.messages.getFull(msg.id);
    const b = L.extractBody(full, true);
    if (!b) { state.body = ""; showError("翻訳できる本文がありません（添付のみ、暗号化・取得不可、または空のメールです）。"); }
    else state.body = bodyToText(b);
  } catch (e) {
    showError("メールの読み込みに失敗しました: " + e.message); return;
  }
  render();
  $("translate").disabled = !state.subject && !state.body;
}

$("translate").addEventListener("click", async () => {
  $("translate").disabled = true; showError("");
  $("notice").hidden = true;
  $("status").textContent = "翻訳中…";
  const opts = { signal: ac.signal, onProgress: (d, t) => { $("status").textContent = "本文を翻訳中… " + d + "/" + t; } };
  const problems = [];
  try {
    if (state.subject) {
      try { state.subjectJa = (await L.translateChunk(state.subject, opts)).trim(); }
      catch (e) { if (e.name === "AbortError") return; state.subjectJa = state.subject; problems.push("件名の翻訳に失敗: " + e.message); }
    }
    if (state.body) {
      const r = await L.translateLong(state.body, opts);
      state.bodyJa = r.text;
      if (r.truncated) problems.push("本文が長いため先頭 " + L.TOTAL_MAX + " 文字のみ翻訳しました。");
      if (r.error) problems.push("本文の翻訳が途中で失敗しました（" + r.done + "/" + r.total + " ブロック完了）: " + r.error.message + "\n翻訳済みの部分までを表示しています。");
      if (!r.text) state.bodyJa = state.body;
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    problems.push("翻訳に失敗しました: " + e.message);
  }
  $("status").textContent = "";
  if (problems.length) showError(problems.join("\n"));
  state.translated = !!(state.subjectJa || state.bodyJa);
  if (state.translated) { state.showing = "ja"; $("toggle").hidden = false; $("copy").hidden = false; }
  render();
  $("translate").textContent = "再翻訳"; $("translate").disabled = false;
});

$("toggle").addEventListener("click", () => { state.showing = state.showing === "ja" ? "orig" : "ja"; render(); });

$("copy").addEventListener("click", async () => {
  const text = (state.subjectJa ? state.subjectJa + "\n\n" : "") + state.bodyJa;
  try { await navigator.clipboard.writeText(text); $("status").textContent = "コピーしました"; }
  catch (e) {
    // フォールバック: 選択してコピー
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand && document.execCommand("copy"); ta.remove();
    $("status").textContent = ok ? "コピーしました" : "";
    if (!ok) showError("クリップボードへのコピーに失敗しました。本文を手動で選択してコピーしてください。");
  }
});

init();
