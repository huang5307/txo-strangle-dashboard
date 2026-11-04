# TXO 備兌賣出勒式策略（Covered Short Strangle）量化收租雷達

專為台指選擇權賣方（莊家收租策略）設計的量化分析與實盤轉倉監控系統。

---

## 💡 策略防衛架構與量化模型

1. **Call 端防護（Covered Call）**：持有足額現貨（00685L 或 00631L）作為賣出 Call 的底倉防禦，盤中不隨波動作賣出。
2. **Put 端防護（Cash-Secured Put）**：預留 100% 足額現金擔保，鎖定技術面/價值面重要支撐位（240MA 年線支撐）。
3. **轉倉對沖機制（Roll Over Engine）**：當單邊履約價面臨突破風險（現價距履約價 < 1% 或 Delta > 0.35）時，自動啟動次週轉倉試算（Call 向上 Roll Up & Out，Put 向下 Roll Down & Out），確保淨權利金流入（Net Credit ≥ 0）。

---

## 🛠️ 系統架構 (100% Serverless)

* **邊緣計算**：Cloudflare Workers (`src/strangle-worker.js`) 串接期交所 TAIFEX OpenAPI + MIS 即時行情 + Yahoo Finance 240MA 與歷史波動率
* **前端託管**：Cloudflare Pages (`public/index.html`)，極速邊緣分發
* **自動部署**：連接 GitHub Repository，推送到 `main` 分支即自動觸發全球發布
