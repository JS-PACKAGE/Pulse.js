# CLAUDE.md

所有撰寫規則請見 [`AGENTS.md`](AGENTS.md)（唯一真值來源，本檔不重複內容）。

摘要：TypeScript／Node 22+；外部工具一律經 adapter＋Mock；安全性十條規則逐條遵守（驗證只在 Cloudflare Zero Trust 層、App 只綁 loopback、SQL 只用 prepared statement、憑證不入日誌）；提交前跑 `npm run typecheck && npm test && npm run build`。
