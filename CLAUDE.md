# Travel App — Claude Code Project Memory

## 專案概述

一個手機優先的旅遊行程管理 PWA（Progressive Web App）。
使用者可以管理多個行程、每天的景點時間軸、預訂狀態、費用記帳，並透過 JSON 匯入行程。
**無需後端、無需 Claude API、零營運成本。**

## 技術架構

- **前端**: HTML + CSS + JavaScript（分離為 `index.html`、`style.css`、`app.js`）
- **同步資料**: Firebase Realtime Database（免費額度，多人即時同步）
- **本機資料**: localStorage（裝置 ID、我的行程清單、打包清單）
- **離線**: PWA Service Worker（`sw.js`）
- **資料格式**: JSON
- **不使用任何付費 API**

## 資料儲存說明

### 資料分層

| 資料類型 | 存放位置 | 說明 |
|---------|---------|------|
| 景點、住宿、備註 | Firebase shared | 所有成員即時同步 |
| 預訂狀態、費用 | Firebase shared | 所有成員即時同步 |
| 個人機票、個人備忘 | Firebase personal/{deviceId} | 只有自己看到 |
| 裝置 ID | localStorage `travel_device_id` | 永久保存，識別身份用 |
| 我加入的行程列表 | localStorage `travel_my_trips` | 本機索引 |
| 打包清單 | localStorage `travel_packing` | 純個人，不需同步 |

### 成員識別（無需登入）

- 第一次開啟 App 自動產生裝置 ID（`dev_` + timestamp + random）
- 加入行程時輸入分享碼 + 自己名字，系統將 deviceId 與名字綁定
- 換裝置需重新用分享碼加入

### 分享碼

- 格式：6 碼大寫英數字，例如 `CANDA25`
- 建立行程時自動產生，可複製或顯示 QR Code 分享給旅伴
- 旅伴輸入分享碼 + 名字即可加入，無需帳號

**FirebaseManager 是唯一的雲端資料存取層，DataManager 處理 localStorage，兩者不混用。**

## 檔案結構

```
travel-app/
├── CLAUDE.md                # 本文件（專案記憶）
├── START_PROMPT.md          # Claude Code 啟動指令
├── CHANGELOG.md             # 所有版本變更記錄
├── .claude/
│   └── commands/
│       ├── build.md         # /build — 產生完整 App
│       ├── review.md        # /review — 程式碼審查
│       └── test.md          # /test — 執行測試
├── agents/
│   ├── builder.yml          # 負責開發 UI 和功能
│   ├── reviewer.yml         # 負責 code review
│   └── tester.yml           # 負責測試和驗證
├── skills/
│   ├── ui-builder/SKILL.md  # UI 開發規範
│   ├── csv-importer/SKILL.md # JSON 匯入規範
│   ├── firebase/SKILL.md    # Firebase 同步規範
│   └── tester/SKILL.md      # 測試規範
├── index.html               # HTML 結構（只含標記，不含 CSS 或 JS）
├── style.css                # 所有樣式
├── app.js                   # 所有 JavaScript
├── firebase-config.js       # Firebase 設定（從 .env 讀取，不 commit）
├── manifest.json            # PWA 設定
├── sw.js                    # Service Worker
└── .env.example             # 環境變數範本
```

## 核心功能規格

### 導覽架構（兩層 Tab Bar）

#### 主選單 Tab Bar（`#tab-main`，3 tabs，離開行程詳情時顯示）

| Tab | Page ID | 內容 |
|-----|---------|------|
| ✈ 行程 | `page-home` | 多行程卡片列表、新增 / 刪除 / 匯入 |
| 🧳 打包清單 | `page-packing` | 可打勾清單、全部取消 |
| ⋯ 更多 | `page-more` | 備份下載、匯入說明 / 範例下載 |

#### 行程子選單 Tab Bar（`#tab-trip`，5 tabs，進入行程詳情後顯示，取代主選單）

| Tab | Panel ID | 內容 |
|-----|----------|------|
| 🗓 行程 | `trip-panel-itinerary` | 瀏覽/編輯模式列、天氣卡、Day 切換、景點時間軸、住宿 Bar、開車警告 |
| 🎫 預訂 | `trip-panel-booking` | 三狀態追蹤、badge 顯示待辦數 |
| 💰 記帳 | `trip-panel-expense` | 多幣別費用、人頭分攤 |
| 📝 備忘錄 | `trip-panel-notes` | 自由文字備忘 |
| 👥 成員 | `trip-panel-members` | 旅伴列表管理 |

#### Tab Bar 切換規則
- 進入行程（`openTrip()`）：隱藏 `#tab-main`，顯示 `#tab-trip`，`#fab-home` 隱藏
- 返回首頁（`goHome()`）：隱藏 `#tab-trip`，顯示 `#tab-main`，`#fab-home` 顯示
- `#fab-add-event`：只在 `trip-panel-itinerary` 且 `appState.editMode === true` 時顯示

---

### 瀏覽模式 / 編輯模式

行程詳情頁有兩種模式，**預設為瀏覽模式**：

| | 瀏覽模式（預設） | 編輯模式 |
|--|----------------|---------|
| 狀態列文字 | 🔒 目前為瀏覽模式 | 🔓 編輯中 |
| 切換按鈕 | 「解鎖編輯」（綠色） | 「完成編輯」（灰色） |
| 景點卡片 | 只能展開查看 | 可新增、編輯、刪除 |
| 新增景點 FAB | 隱藏 | 顯示 |
| 防誤觸 | ✅ 所有編輯入口鎖定 | — |

**實作規則：**
- `appState.editMode = false` 為全域狀態，預設 false
- 切換時只重繪景點列表，不重整整頁
- 瀏覽模式：景點卡片點擊只展開詳情
- 編輯模式：景點卡片右側多出「✏️」和「🗑」icon

---

### 首頁行程管理

**新增行程（手動）：**
- 點右下角 FAB（+）→ 彈出 Modal
- 填寫：行程名稱（必填）、出發日期、結束日期、封面顏色、成員名稱（逗號分隔）

**匯入行程（JSON）：**
- 首頁頂部「匯入行程」按鈕 → 開啟檔案選擇器（.json）
- 驗證通過 → Toast 成功 → 行程卡片出現
- 驗證失敗 → Toast 錯誤 + Modal 列出具體欄位問題

**刪除行程：**
- 長按首頁行程卡片 **500ms** → 卡片內滑出確認區塊（不用系統 Alert）
- 確認區塊顯示：「🗑 刪除此行程」紅色按鈕 ＋「取消」白色按鈕
- 點刪除 → localStorage 移除 → Toast「已刪除 XX 行程」→ 重新渲染首頁
- 點取消或長按其他地方 → 確認區塊收起
- **同一時間只有一張卡片可以顯示確認區塊**

---

### trip-panel-itinerary 必要元件

1. **模式切換列** `#mode-bar`（panel 頂部）
   - 🔒/🔓 icon + 狀態文字 + 切換按鈕
2. **天氣卡** `#weather-bar` — 溫度 / 降雨機率 / 穿搭建議
3. **Day 橫向切換列** `#days-scroll` — 可捲動，當天 Day 高亮
4. **景點時間軸** `#events-list`
   - 點擊展開備註、連結、Google Maps
   - Plan B badge、預訂狀態 badge（⚠ 需訂 / ✓ 已訂）
   - 編輯模式下顯示 ✏️ / 🗑 icon
5. **開車時間警告** `#drive-warning`（當天 drive_mins 總和 > 240 分鐘）
   - 橘色警告列，顯示預估總時數
6. **住宿 Bar** `#hotel-bar`（當天有 type=hotel 的 event 才顯示）
   - 顯示住宿名稱 + note（含密碼）
7. **新增景點 FAB** `#fab-add-event`（僅編輯模式且在此 panel 時顯示）

### trip-panel-booking 必要元件
- 列出當前行程所有 status=pending 或 booked 的 events
- 可點擊切換狀態（pending ↔ booked）
- `#trip-booking-badge` 顯示 pending 數量

### trip-panel-expense 必要元件
- 列出所有有 cost 的 events，依 currency 分組小計
- 人頭分攤計算（總費用 ÷ members 數量）

### trip-panel-notes 必要元件
- 自由文字輸入區，儲存於該行程的 `notes` 欄位

### trip-panel-members 必要元件
- 顯示 members 陣列，可新增 / 刪除成員

---

### 資料匯入方式（全免費）
1. **手動新增** — App 內表單填寫（需先進入編輯模式新增景點）
2. **JSON 上傳** — 首頁「匯入行程」→ 上傳 .json 檔案
3. **範例下載** — App 內提供最小範例 JSON 下載 + AI Prompt 範本複製

### 資料備份匯出
- 「更多」頁面提供「備份下載」按鈕
- 將所有行程匯出為 `travel-backup-YYYYMMDD.json`
- 格式與匯入格式完全相同，可直接重新匯入

---

### JSON 格式（標準）
```json
{
  "trip_name": "string（必填）",
  "cover_color": "green|blue|orange|teal",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "members": ["string"],
  "days": [{
    "date": "YYYY-MM-DD",
    "label": "string",
    "events": [{
      "time": "HH:MM",
      "name": "string（必填）",
      "type": "attraction|food|hotel|transport",
      "status": "booked|pending|none",
      "cost": 0,
      "currency": "CAD|TWD|JPY|USD",
      "note": "string",
      "url": "string",
      "address": "string",
      "drive_mins": 0,
      "plan_b": "string"
    }]
  }]
}
```

---

## 設計規範

### 視覺風格
- 主色：`#4a7c59`（綠）、`#f5f0e8`（米白）
- 字型：Noto Sans TC（中文）+ Nunito（數字/英文標題）
- 圓角：14-16px（卡片）、8-10px（按鈕）
- 陰影：`0 2px 12px rgba(74,124,89,0.10)`

### 手機優先規則
- 最大寬度 430px，置中
- 所有可點擊元素最小 44px 高
- 底部 Tab Bar 固定，內容區域可捲動
- iOS Safari 安全區域：`env(safe-area-inset-bottom)`

---

## 開發約定

- **檔案分離**：HTML 結構在 `index.html`，樣式在 `style.css`，邏輯在 `app.js`，三者不混寫
- **index.html 只做兩件事**：引入 `style.css`（`<link>`）和 `app.js`（`<script defer>`），以及 HTML 標記
- **CHANGELOG**：所有版本變更記錄在 `CHANGELOG.md`，不寫在程式碼檔案裡，格式見下方
- **命名**：函式用 camelCase，CSS class 用 kebab-case
- **資料存取**：所有讀寫透過 `DataManager`，禁止直接操作 localStorage
- **模式狀態**：`appState.editMode` 控制瀏覽 / 編輯，切換時只重繪必要區塊
- **頁面切換**：用 CSS class `hidden` / `slide-left` 控制，不用 router
- **錯誤處理**：JSON 解析失敗要有 Toast + Modal 列出具體錯誤欄位
- **不使用任何外部 JS 框架**（React/Vue 等），保持零依賴
- **Firebase 只透過 FirebaseManager 存取**，不直接呼叫 SDK
- **localStorage 只透過 DataManager 存取**，兩者職責不混用

## CHANGELOG.md 格式

每次完成一個功能或修復，在 `CHANGELOG.md` 最上方新增一筆記錄：

```markdown
## [v0.x] YYYY-MM-DD
### 新增
- 說明新增的功能

### 修改
- 說明修改的內容

### 修復
- 說明修復的 bug
```

## 安全規範

- 使用者上傳的 JSON 必須先通過 schema 驗證再解析
- 所有用戶輸入透過 `encodeHTML()` 後才插入 DOM（防 XSS）
- Firebase config 存於 `.env`，`.env` 已加入 `.gitignore`，**絕不 commit**
- Firebase Database 規則限制只允許有效 tripId 路徑讀寫

---

## Agent 分工

| Agent | 負責範圍 |
|-------|---------|
| `builder` | UI 開發、功能實作、Firebase 整合、localStorage 整合、維護 CHANGELOG.md |
| `reviewer` | Code review、效能、安全性、檢查三檔案是否有混寫 |
| `tester` | JSON 驗證、UI 互動、PWA、刪除流程、模式切換測試 |
