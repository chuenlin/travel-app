## [v1.9.2] 2026-04-18
### 新增
- 本機 / 匯入行程可從成員頁「🔗 分享此行程」按鈕上傳到 Firebase 並產生分享碼：
  - 輸入自己名字 → 行程資料上傳到 Firebase（保留原 tripId）→ 顯示分享碼
  - 上傳後自動啟動即時監聽，旅伴可用分享碼加入

### 修改
- `openTrip` 的 Firebase 監聽器設定提取為 `_initFirebaseForTrip(tripId)`，供首次開啟與分享後共用
- `FirebaseManager` 新增 `uploadTrip(tripData, creatorName)` 方法（保留現有 tripId，不同於 `createTrip` 的 push 新 ID）

---

## [v1.9.1] 2026-04-18
### 修復
- 創建行程後第二位以分享碼加入的成員顯示為創建者：
  - `FirebaseManager.createTrip` 建立成員記錄時加入 `isCreator: true` 旗標
  - `_renderMembersHTML` 優先以 `isCreator` 旗標識別創建者，沒有旗標的舊行程退回 `joinedAt` 排序（向下相容）
  - `updatePresence` 在建立全新 Firebase 記錄時補寫 `joinedAt`（防止 `undefined → 0` 誤判）
- 匯入 JSON 行程（無 `shareCode`）開啟時不啟動 Firebase 功能（`listenTrip`、`updatePresence`、`listenMembers`），避免建立無意義的孤立成員記錄

---

## [v1.9.0] 2026-04-17
### 新增
- 成員頁顯示創建者標記（👑 創建者），依 `joinedAt` 時間判斷最早加入者
- 成員頁顯示自己的「我」標記（綠色）
- 成員頁新增「退出行程」按鈕（Firefox 行程且本人已加入才顯示）：
  - 從 Firebase `members/{deviceId}` 刪除自己的裝置記錄（其他人成員頁看不到）
  - 從 Firebase `shared/members` 移除自己的名字
  - 本機移除行程並返回首頁
- 退出 vs 刪除差異：刪除只清本機，退出同時清除 Firebase 成員記錄
- 名字持久化：建立/加入行程時儲存自己名字到 localStorage，`updatePresence` 自動修復舊版「我」的記錄

### 修改
- `DataManager` 新增 `getMyName()` / `setMyName()` 管理本機顯示名稱
- `FirebaseManager.updatePresence()` 改為讀取後更新，自動修正 `name: '我'` 的舊記錄

---

## [v1.8.0] 2026-04-17
### 新增
- Firebase Realtime Database 多人即時同步：
  - 新增行程時自動建立 Firebase 記錄，產生 6 碼分享碼（例：CANDA25）
  - 首頁新增「🔗 加入行程」按鈕，輸入分享碼 + 名字即可加入
  - 進入行程後啟動即時監聽（`listenTrip`），其他成員的變更即時同步
  - 成員頁顯示在線狀態（綠點 = 60 秒內有活動），每 30 秒更新一次
  - 成員頁顯示分享碼，可直接複製
  - 建立行程成功後彈出分享碼 Modal
- 新增 `FirebaseManager`（雲端資料層），`DataManager` 維持 localStorage 職責，兩者不混用
- 新增 `firebase-config.js`（從 `.env` 讀取，已加入 `.gitignore`）
- 新增裝置 ID（`travel_device_id`）和行程 ID 清單（`travel_my_trips`）機制

### 修改
- `createTrip()` 改為 async，優先寫入 Firebase，無網路時降級為本機儲存
- `openTrip()` / `goHome()` 加入 Firebase 監聽器管理與在線狀態更新
- `DataManager.deleteTrip()` 一併清除 `travel_my_trips`
- `DataManager.updateTrip()` 加入防抖 Firebase 同步（600ms）
- `sw.js` 快取版本升至 `v3`，新增快取 `firebase-config.js`

---

## [v1.7.0] 2026-04-16
### 新增
- 景點時間自動排序：
  - 新增有時間的景點 → 自動插入到最後一個時間 ≤ 新景點時間的位置之後
  - 新增無時間的景點 → 加到最後
  - ↑↓ 移動受時間約束：有時間的景點不能越過時間衝突的鄰居（顯示 Toast 提示）；無時間景點可自由移動
  - 匯入時僅對有時間的景點排序（最小改動），無時間景點位置不變

---

## [v1.6.0] 2026-04-15
### 修復
- 「重新整理」按鈕無法載入更新的 CSS/JS（Cache-First 策略導致舊快取永遠被使用）：`reloadApp()` 現在在重載前先清除所有 SW 快取，強制下次載入從網路取得最新檔案
- `sw.js` 的 `CACHE_NAME` 改為 `travel-app-v2`，deploy 新版時需同步更新此字串以觸發舊快取清除

---

## [v1.5.0] 2026-04-14
### 新增
- 備忘錄頁「重要連結」＋「購買清單」改為 `＋` 按鈕 → Modal 輸入（移除區塊內嵌輸入列）
- 編輯模式下住宿 Bar 隱藏展開箭頭，改為顯示 ✏️ / 🗑 按鈕（與景點卡片對齊）
- 機票資訊欄位擴充：出發地/航廈/日期/時間、抵達地/航廈/日期/時間、航班號、座位、行李、備註（向下相容舊 `route` 格式）
- 機票資訊可編輯（✏️ 按鈕開啟編輯 Modal，欄位與新增相同）

### 修改
- Collapsible 動畫改用 JS `scrollHeight` 精確高度（同景點卡片），消除 max-height:4000px 造成的收合卡頓
- 機票資訊區塊預設收合（原為展開）
- 機票移除已訂/需訂狀態追蹤（Tab badge 不再計入機票）
- 預訂頁 re-render 時保留各區塊的展開/收合狀態（修正點擊後卡片自動收合的問題）
- 其他預訂（含交通景點）排序：待訂優先、已訂在後，各自再依日期時間排序

### 修復
- 備份檔案（`travel-backup-*.json`）直接匯入時跳出格式錯誤：`handleJSONImport` 現在自動識別備份格式（頂層有 `trips` 陣列），一次匯入全部行程；既有相同 id 的行程自動換新 id，不覆蓋現有資料

---

## [v1.4.0] 2026-04-14
### 新增
- 行程詳情頁每日標題列（`day.label` 顯示於景點列表上方，點擊可編輯）
- 「更多」頁面新增「重新整理 / 取得最新版本」按鈕（強制更新 Service Worker 後重載）
- 編輯模式下在住宿 bar 下方新增「刪除本日行程」按鈕

### 修改
- 首頁行程卡片日期格式改為 `YYYY/M/D`（例：2025/9/5 → 2025/9/14）
- Day 切換按鈕改為雙行顯示（Day N / M/D Weekday，例：Day 1 / 9/5 Fri）
- Day 標籤從按鈕文字移出，改為景點列表上方的可編輯標題
- `switchDay` 改用 `data-day-idx` 屬性比對 active 狀態，修正加入新 Day 後按鈕 active 不準確的問題
- 加入 Day 後自動捲動至新 Day 按鈕（scrollIntoView）

### 修復
- `sw.js` 漏快取 `style.css` 和 `app.js`（檔案分離後離線時 App 白屏）
- Service Worker fetch 策略：`index.html` 改為 Network-First，有網路時重整即可獲得最新版本

---

## [v1.3.0] 2026-04-14
### 新增
- 住宿資料從 events 移出，改為每天獨立的 `day.hotel` 欄位
- 住宿 Bar 新增專屬編輯 Modal（含名稱、備註、地址、連結、費用、預訂狀態）
- 住宿 Bar 刪除功能

### 修改
- 檔案分離：CSS 全部移至 `style.css`，JS 全部移至 `app.js`，`index.html` 僅保留 HTML 標記
- 住宿費用與預訂狀態納入記帳頁分組計算與預訂頁 badge 計數

### 修復
- 瀏覽模式下住宿 Bar 顯示編輯 icon（`toggleEditMode` 現在會重繪 hotel bar）
- 住宿 Bar 收合狀態下仍顯示紫色邊框（border 移至 `.hotel-bar-body.open`）

---

## [v1.2.0] 2026-04-14
### 新增
- 行程標題可點擊內聯編輯
- 天氣顯示最高/最低溫，串接 Open-Meteo 免費 API（geocoding + forecast）
- 住宿 bar 可展開查看完整資訊（同景點卡片動畫）
- 景點展開/收合改為 JS 精確高度動畫，消除卡頓
- 付費資訊移至展開後的景點主體（非標題列）
- 連結顯示網頁實際標題（透過 allorigins.win 抓取）
- 景點可上下移動排序（↑↓ 按鈕，編輯模式）
- 景點時間欄位新增清除按鈕
- 預訂頁新增機票資訊區塊（可手動新增 trip.flights）
- 重要連結改為「顯示名稱 + URL」雙欄輸入

---

## [v1.1.0] 2026-04-14
### 新增
- 主選單改為 3 tabs：行程、打包清單、更多
- 行程詳情改為 5 inner tabs：行程、預訂、記帳、備忘錄、成員
- 首頁行程日期顯示星期
- 打包清單加入「全部取消勾選」
- 預訂：交通/機票獨立 section（可縮）、顯示備註/連結、修正狀態循環 pending↔booked
- 備忘錄頁：備忘錄+重要連結+購買清單（三個可縮）
- 成員頁：可編輯、可加備註

---

## [v1.0.0] 2026-04-13
### 新增
- 初始建置：完整 Travel App PWA
- 5 頁面：首頁、行程詳情、預訂清單、費用記帳、更多
- 瀏覽/編輯模式切換、長按刪除行程、JSON 匯入/匯出
