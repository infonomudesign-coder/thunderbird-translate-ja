/* 共有ライブラリ: popup(グローバル TranslateLib) と Node テストの両方で使う */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TranslateLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
  const CHUNK_MAX = 4000;
  const TOTAL_MAX = 30000;
  const TIMEOUT_MS = 20000;
  const MAX_RETRIES = 2;

  /* ---------- 分割 ---------- */
  // 長さの単位は UTF-16 コード単位で統一(サロゲートペアの途中では切らない)
  function hardSplit(s, max) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      let end = Math.min(i + max, s.length);
      if (end < s.length && /[\ud800-\udbff]/.test(s[end - 1])) end--;
      if (end <= i) end = i + 1;
      out.push(s.slice(i, end));
      i = end;
    }
    return out;
  }

  // 区切り文字を保持したまま、段落→行→文→強制の順で max 文字以下に分割
  function splitText(text, max) {
    max = max || CHUNK_MAX;
    const levels = [/(\n\s*\n)/, /(\n)/, /(?<=[.!?。！？])(\s+)/];
    function pieces(s, lvl) {
      if (s.length <= max) return [s];
      if (lvl >= levels.length) return hardSplit(s, max);
      const parts = s.split(levels[lvl]); // 区切りも要素として残る
      const atoms = [];
      for (let i = 0; i < parts.length; i += 2) {
        atoms.push((parts[i] || "") + (parts[i + 1] || ""));
      }
      const out = [];
      let cur = "";
      for (const a of atoms) {
        if (a.length > max) {
          if (cur) { out.push(cur); cur = ""; }
          out.push(...pieces(a, lvl + 1));
        } else if (cur.length + a.length > max) {
          out.push(cur); cur = a;
        } else cur += a;
      }
      if (cur) out.push(cur);
      return out;
    }
    return pieces(text, 0).filter((c) => c.length > 0);
  }

  /* ---------- HTML → テキスト ---------- */
  const BLOCK = new Set(["P","DIV","BR","LI","UL","OL","TR","TABLE","H1","H2","H3","H4","H5","H6","BLOCKQUOTE","PRE","HR","SECTION","ARTICLE","HEADER","FOOTER"]);

  // DOMParser を注入(popup: 組み込み / Node テスト: jsdom)。リモート読み込みを避けるため
  // DOMParser は inert なドキュメントを作り、画像等は取得されない。
  function htmlToText(html, DOMParserCtor) {
    const doc = new DOMParserCtor().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,img,link,iframe,object,embed,head").forEach((n) => n.remove());
    let out = "";
    (function walk(node) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue.replace(/\s+/g, " ");
        else if (c.nodeType === 1) {
          const blk = BLOCK.has(c.tagName);
          if (blk) out += "\n";
          walk(c);
          if (blk && c.tagName !== "BR") out += "\n";
        }
      }
    })(doc.body || doc.documentElement);
    return out.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* ---------- MIME 本文抽出 ---------- */
  // ファイル名付き、または attachment 指定のパートは添付として扱う(inline でも除外)
  function isAttachment(p) {
    const cd = (p.headers && (p.headers["content-disposition"] || [])[0]) || "";
    return !!p.name || /^\s*attachment/i.test(cd) || /filename\*?\s*=/i.test(cd);
  }

  // 戻り値: { text, kind: "plain"|"html" } | { kind: "mixed", parts: [葉...] } | null
  // isRoot: getFull() が返す最上位の message/rfc822 ラッパーだけは展開する(入れ子の添付メールは除外)
  function extractBody(part, isRoot) {
    const ct = (part.contentType || "").toLowerCase();
    if (isAttachment(part)) return null;
    if (ct.startsWith("message/")) {
      if (!(isRoot && part.parts)) return null;
    } else if (ct === "text/plain" && part.body) return { text: part.body, kind: "plain" };
    else if (ct === "text/html" && part.body) return { text: part.body, kind: "html" };
    if (!part.parts) return null;
    const found = part.parts.map((c) => extractBody(c, false)).filter(Boolean);
    if (ct === "multipart/alternative") {
      const hasText = (f) => (f.kind === "mixed" ? f.parts.some((x) => x.text.trim()) : f.text.trim());
      return found.find((f) => f.kind === "plain" && hasText(f)) || found.find(hasText) || null;
    }
    // mixed / related / message ラッパー: 葉を平坦化して順に並べる(入れ子の mixed も展開)
    const leaves = [];
    for (const f of found) {
      if (f.kind === "mixed") leaves.push(...f.parts);
      else if (f.text.trim()) leaves.push(f);
    }
    if (!leaves.length) return null;
    return leaves.length === 1 ? leaves[0] : { kind: "mixed", parts: leaves };
  }

  /* ---------- 翻訳 API ---------- */
  function parseResponse(json) {
    if (!Array.isArray(json) || !Array.isArray(json[0])) throw new Error("翻訳APIの応答形式が不正です");
    let out = "";
    for (const seg of json[0]) {
      if (!Array.isArray(seg) || typeof seg[0] !== "string") throw new Error("翻訳APIの応答形式が不正です");
      out += seg[0];
    }
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function translateChunk(text, opts) {
    opts = opts || {};
    const f = opts.fetchImpl || fetch;
    const retries = opts.retries != null ? opts.retries : MAX_RETRIES;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (opts.signal && opts.signal.aborted) throw new DOMException("中断されました", "AbortError");
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs || TIMEOUT_MS);
      const onAbort = () => ac.abort();
      if (opts.signal) opts.signal.addEventListener("abort", onAbort);
      try {
        const res = await f(ENDPOINT + "?client=gtx&sl=en&tl=ja&dt=t", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: "q=" + encodeURIComponent(text),
          signal: ac.signal,
          credentials: "omit",
        });
        if (!res.ok) {
          const e = new Error("翻訳APIがエラーを返しました (HTTP " + res.status + ")");
          e.transient = res.status === 429 || res.status >= 500;
          throw e;
        }
        return parseResponse(await res.json());
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw new DOMException("中断されました", "AbortError");
        lastErr = e;
        const transient = e.transient || e.name === "AbortError" || e.name === "TypeError";
        if (!transient || attempt === retries) break;
        await sleep((opts.backoffMs != null ? opts.backoffMs : 500) * (attempt + 1));
      } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      }
    }
    if (lastErr && lastErr.name === "AbortError") lastErr = new Error("翻訳APIがタイムアウトしました");
    throw lastErr;
  }

  // 長文対応。途中失敗しても取得済み分を返す: { text, total, done, truncated, error }
  async function translateLong(text, opts) {
    opts = opts || {};
    const truncated = text.length > TOTAL_MAX; // UTF-16 コード単位(hardSplit と同じ)
    const chunks = splitText(truncated ? hardSplit(text, TOTAL_MAX)[0] : text, CHUNK_MAX);
    const outs = [];
    let error = null;
    for (let i = 0; i < chunks.length; i++) {
      try {
        const t = await translateChunk(chunks[i], opts);
        // 末尾の空白(区切り)を原文に合わせて復元
        const trail = (chunks[i].match(/\s*$/) || [""])[0];
        outs.push(t.replace(/\s*$/, "") + trail);
        if (opts.onProgress) opts.onProgress(i + 1, chunks.length);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        error = e; break;
      }
    }
    return { text: outs.join(""), total: chunks.length, done: outs.length, truncated, error };
  }

  return { splitText, htmlToText, extractBody, parseResponse, translateChunk, translateLong, hardSplit, CHUNK_MAX, TOTAL_MAX };
});
