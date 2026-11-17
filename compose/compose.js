"use strict";
const $ = (id) => document.getElementById(id);
const T = TranslateLib, A = AiLib;

const st = {
  tabId: null, details: null, isPlain: true, type: "", relatedMessageId: null,
  settings: { apiKey: "", model: "", senderMemo: "" },
  originalText: "", originalError: "", bodyText: "",
  result: null, ctrl: null, pending: null, snapshot: null, busy: false, reqId: 0,
};

function showError(m) { const e = $("error"); e.textContent = m || ""; e.hidden = !m; }
function mode() { return document.querySelector('input[name="mode"]:checked').value; }

function bodyToText(b) {
  if (b.kind === "plain") return b.text;
  if (b.kind === "html") return T.htmlToText(b.text, DOMParser);
  return b.parts.map(bodyToText).join("\n\n");
}
function currentBodyText(d) {
  const raw = (d.isPlainText ? d.plainTextBody : d.body) || "";
  return d.isPlainText ? raw : (raw ? T.htmlToText(raw, DOMParser) : "");
}

function currentRequest() {
  return A.buildRequest({
    mode: mode(), notes: $("notes").value, tone: $("tone").value, lang: $("lang").value,
    subject: st.details ? st.details.subject : "", existingBody: st.bodyText,
    originalEmail: st.originalText, senderMemo: st.settings.senderMemo,
  });
}

function refreshModeUi() {
  const m = mode();
  const replyOk = st.type === "reply" && st.relatedMessageId != null && !st.originalError && !!st.originalText;
  const rawBody = (st.isPlain ? st.details && st.details.plainTextBody : st.details && st.details.body) || "";
  const tooLong = st.bodyText.length > A.LIMITS.BODY;
  const polishOk = (st.type === "new" || st.type === "draft") && !!st.bodyText.trim() && !A.hasQuote(rawBody, st.isPlain) && !tooLong;
  document.querySelector('input[value="reply"]').disabled = !replyOk;
  document.querySelector('input[value="polish"]').disabled = !polishOk;
  let hint = "";
  if (st.type !== "reply") hint = "「返信を考える」は、返信の作成ウィンドウで使えます。";
  else if (st.originalError) hint = "返信元メールを読み込めませんでした（" + st.originalError + "）。「返信を考える」は使えません。";
  if (!polishOk) hint += (hint ? " " : "") + (tooLong ? "本文が長すぎる（" + A.LIMITS.BODY + "字超）ため「今の本文を整える」は使えません。" : "「今の本文を整える」は、引用のない新規・下書きの本文があるときだけ使えます。");
  $("modeHint").textContent = hint;
  if ((m === "reply" && !replyOk) || (m === "polish" && !polishOk)) document.querySelector('input[value="subject"]').checked = true;

  const req = currentRequest();
  const ul = $("sentList"); ul.textContent = "";
  for (const s of req.sent) { const li = document.createElement("li"); li.textContent = s; ul.appendChild(li); }
  const tn = $("truncNote");
  tn.hidden = !req.truncated.length;
  tn.textContent = req.truncated.length ? "長すぎるため一部のみ送信: " + req.truncated.join("、") : "";
  $("generate").disabled = !st.settings.apiKey || st.busy;
}

async function init() {
  try {
    const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
    st.tabId = tabs[0].id;                                   // 起点の作成タブを一度だけ確定
    st.details = await messenger.compose.getComposeDetails(st.tabId);
  } catch (e) { showError("作成ウィンドウの情報を取得できませんでした。"); return; }
  st.isPlain = !!st.details.isPlainText;
  st.type = st.details.type || "";
  st.relatedMessageId = st.details.relatedMessageId != null ? st.details.relatedMessageId : null;
  st.bodyText = currentBodyText(st.details);

  try {
    const s = await messenger.storage.local.get({ apiKey: "", model: "", senderMemo: "" });
    st.settings = s;
  } catch (e) { /* 既定値のまま */ }
  $("nokey").hidden = !!st.settings.apiKey;

  if (st.type === "reply" && st.relatedMessageId != null) {
    try {
      const full = await messenger.messages.getFull(st.relatedMessageId);
      const b = T.extractBody(full, true);
      if (!b) st.originalError = "本文が見つかりません";
      else st.originalText = bodyToText(b);
    } catch (e) { st.originalError = "元メールが削除済みか、取得できません"; }
  }
  refreshModeUi();
}

function setBusy(on) {
  st.busy = on;
  $("generate").disabled = on || !st.settings.apiKey;
  $("cancel").hidden = !on;
  if (!on) refreshModeUi();
}

// 作成ウィンドウの最新状態を取り込む(失敗時は false)
async function syncDetails() {
  try {
    const d = await messenger.compose.getComposeDetails(st.tabId);
    st.details = d; st.isPlain = !!d.isPlainText;
    st.bodyText = currentBodyText(d);
    return true;
  } catch (e) { return false; }
}

async function generate() {
  if (st.busy) return;                       // 二重実行防止(最初の await より前に確保)
  setBusy(true);
  const myId = ++st.reqId;
  st.ctrl = new AbortController();           // 最初の await より前に作る(待機中でも「中止」が効く)
  const ctrl = st.ctrl;
  showError(""); $("status").textContent = "考え中…"; $("result").hidden = true; $("confirm").hidden = true;
  try {
    const wanted = mode();
    if (!(await syncDetails())) { showError("作成ウィンドウが閉じられたか、取得できません。"); return; }
    if (ctrl.signal.aborted) return;         // 取得待ちの間に中止された
    refreshModeUi();                         // 送信内容の一覧を最新の本文で更新
    if (mode() !== wanted) { showError("本文が変わったため、選べる項目が変わりました。内容を確認してもう一度「作る」を押してください。"); return; }
    const req = currentRequest();            // 最新の本文から作る
    const snapshot = { body: (st.isPlain ? st.details.plainTextBody : st.details.body) || "", subject: st.details.subject || "" };
    const r = await A.callClaude({ apiKey: st.settings.apiKey, model: st.settings.model || A.DEFAULT_MODEL, system: req.system, user: req.user, maxTokens: req.maxTokens, signal: ctrl.signal });
    if (myId !== st.reqId) return;           // 古い応答は捨てる
    st.snapshot = snapshot;                  // 要求・スナップショット・結果を一体で保持
    st.result = { mode: wanted, text: r.text, truncated: r.truncated };
    renderResult();
  } catch (e) {
    if (e.name !== "AbortError" && myId === st.reqId) showError(e.message);
  } finally {
    if (myId === st.reqId) { st.ctrl = null; $("status").textContent = ""; setBusy(false); }
  }
}

function renderResult() {
  const r = st.result; $("result").hidden = false;
  const w = $("warn");
  w.hidden = !r.truncated; w.textContent = r.truncated ? "文章が長さの上限で途中で切れている可能性があります。内容を確認してください（挿入時に確認が出ます）。" : "";
  $("subjects").textContent = ""; $("text").textContent = ""; $("insert").hidden = true; $("polishApply").hidden = true;
  if (r.mode === "subject") {
    $("text").hidden = true;
    const list = A.parseSubjects(r.text);
    if (!list.length) { showError("件名の候補を取り出せませんでした。もう一度お試しください。"); return; }
    for (const s of list) {
      const row = document.createElement("div"); row.className = "subj";
      const span = document.createElement("span"); span.textContent = s;
      const b = document.createElement("button"); b.type = "button"; b.textContent = "この件名にする";
      b.addEventListener("click", () => requestApply({ kind: "subject", text: s }));
      row.append(span, b); $("subjects").appendChild(row);
    }
  } else {
    $("text").hidden = false; $("text").textContent = r.text;
    if (r.mode === "polish") $("polishApply").hidden = false; else $("insert").hidden = false;
  }
}

function askConfirm(msg, op, force) {
  st.pending = { op, force: !!force };
  $("confirmMsg").textContent = msg;
  $("confirm").hidden = false;
}

// 挿入前の確認: 途中切れの出力 / 本文全体の置換
function requestApply(op) {
  const msgs = [];
  if (st.result && st.result.truncated) msgs.push("この文章は途中で切れている可能性があります。");
  if (op.kind === "polish") msgs.push("本文全体（署名・書式を含む）が、整えた文章に置き換わります。");
  if (!msgs.length) return apply(op, false);
  askConfirm(msgs.join("") + "よろしいですか？", op, false);
}

async function apply(op, force) {
  showError(""); $("confirm").hidden = true;
  if (!st.result || !st.snapshot) return;
  const res = await A.applyToCompose(messenger.compose, st.tabId, Object.assign({ snapshot: st.snapshot, force: !!force }, op));
  if (res.ok) { $("status").textContent = "挿入しました。"; return; }
  const msgs = {
    closed: "作成ウィンドウが閉じられたか、取得できません。",
    changed: "生成中に本文が編集されました。もう一度「作る」から作り直してください。",
    quote: "本文に引用があるため、全体の置き換えはできません。",
    failed: "挿入に失敗しました。",
  };
  if (res.reason === "changed-confirm") {
    askConfirm(op.kind === "subject" ? "生成中に件名が編集されています。それでも置き換えますか？" : "生成中に本文が編集されています。それでも先頭に挿入しますか？", op, true);
    return;
  }
  showError(msgs[res.reason] || "挿入に失敗しました。");
}

$("generate").addEventListener("click", generate);
$("cancel").addEventListener("click", () => { if (st.ctrl) st.ctrl.abort(); });
window.addEventListener("pagehide", () => { if (st.ctrl) st.ctrl.abort(); }); // popup を閉じる=中断
$("insert").addEventListener("click", () => requestApply({ kind: "insert", text: st.result.text }));
$("polishApply").addEventListener("click", () => requestApply({ kind: "polish", text: st.result.text }));
$("confirmYes").addEventListener("click", () => { const p = st.pending; st.pending = null; $("confirm").hidden = true; if (p) apply(p.op, p.force); });
$("confirmNo").addEventListener("click", () => { st.pending = null; $("confirm").hidden = true; });
$("openOptions").addEventListener("click", () => messenger.runtime.openOptionsPage());
for (const el of ["notes", "tone", "lang"]) $(el).addEventListener("input", refreshModeUi);
document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", refreshModeUi));

init();
