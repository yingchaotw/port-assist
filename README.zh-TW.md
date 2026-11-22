# PortAssist (`port-assist`)

[English](README.md) | **繁體中文**

> 跨平台串口 (RS232/422/485) + TCP/UDP + PCAN (Classic CAN 2.0A/B) 綜合通訊調試助手（基於 Rust + Tauri 2 + Vanilla Web）

---

## 下載使用（免安裝可攜版）

無需安裝 Rust 或 Node.js 環境，直接至 **[Releases](https://github.com/yingchaotw/port-assist/releases)** 頁面下載對應平台執行檔：

* **Windows (64-bit)**：`PortAssist-windows-x64.exe`
* **macOS (Apple Silicon)**：`PortAssist-macos-arm64.tar.gz`

> **介面語言切換**：可隨時從上方選單 **檢視(V) → 切換語言**（`View → Switch Language`）在 **繁體中文** 與 **English** 之間即時切換。

---

## 專案目錄結構

```text
port-assist/
├── ui/                         # 前端介面原始碼 (HTML5 / CSS3 / Vanilla JS)
│   ├── index.html              # 主視窗結構 (多分頁、左側設定欄、接收/發送區、狀態列)
│   ├── styles.css              # 介面樣式與深色 / 明亮雙主題定義
│   ├── app.js                  # 前端控制器與虛擬捲動渲染
│   └── js/                     # 模組化核心邏輯與語系層
│       ├── i18n.js             # 繁體中文 / English 雙語字典
│       ├── codec.js            # Hex / UTF-8 / ASCII 編解碼與 Odd Nibble 檢查
│       ├── framer.js           # O(1) 增量斷幀引擎與 Fixed 幀分組
│       ├── can-parser.js       # PCAN 幀轉換與 Fixed 表格更新
│       ├── excommand.js        # Serial Assistant ExCommand (.ini) 解析與 SCPI 範本
│       ├── exporter.js         # 含時間戳記日誌與 Fixed 報表匯出
│       └── session-model.js    # 多分頁 Session 狀態與拆窗序列化
├── src-tauri/                  # Rust 後端與通訊引擎 (Tauri 2)
│   ├── src/
│   │   ├── main.rs             # Tauri 進入點與 TauriEventSink 事件轉接層
│   │   ├── manager.rs          # Session 管理、ActivePort 與 TransportEvent / EventSink
│   │   ├── serial.rs           # 序列埠與內建 LOOPBACK 迴路測試
│   │   ├── net.rs              # 非阻塞 TCP Client/Server 與 UDP Socket
│   │   ├── pcan.rs             # PEAK PCAN-Basic / MacCAN 動態載入與 Classic CAN 2.0 收發
│   │   ├── window.rs           # 視窗控制、分頁拆窗與 macOS 原生系統選單
│   │   ├── api_server.rs       # 本地 HTTP API Server (127.0.0.1:18080)
│   │   └── main_helpers.rs     # HTTP API 請求處理輔助函式
│   ├── capabilities/           # Tauri 權限配置
│   ├── icons/                  # 應用程式圖示
│   ├── Cargo.toml              # Rust 依賴設定
│   └── tauri.conf.json         # Tauri 應用程式設定
├── mcp/                        # Python MCP Server（供 AI / 自動化工具串接）
├── LICENSE                     # MIT License
├── README.md                   # English README
└── README.zh-TW.md             # 繁體中文說明文件
```

---

## 編譯與執行說明

### 系統環境要求
* **macOS** 或 **Windows 10 / 11 (64-bit)**
* [Rust](https://rustup.rs/)（建議 **1.90+**，包含 Cargo）
* 系統 WebView（macOS 內建 WebKit；Windows 10/11 內建 WebView2 Runtime）
* **若需使用 PCAN 功能**：
  * macOS：安裝 [MacCAN PCBUSB](https://mac-can.com/)（`/usr/local/lib/libPCBUSB.dylib`）
  * Windows：安裝 PEAK-System PCAN-Basic 驅動（`PCANBasic.dll`）

### 本地測試與編譯
進入 `src-tauri` 目錄執行指令：

```bash
cd src-tauri

# 執行單元與整合測試
cargo test

# 開發 / 除錯模式直接啟動
cargo run

# 發布模式編譯
cargo build --release
```

編譯完成後的執行檔位於：
* **macOS**：`src-tauri/target/release/port-assist`
* **Windows**：`src-tauri/target/release/port-assist.exe`

---

### PCAN (CAN 2.0) 設定與故障排除

若切換至 **PCAN (CAN 2.0)** 模式無法偵測到通道或開啟失敗，請依下列 3 步驟排除：

1. **插入實體 PCAN 硬體**：
   * 請將 PEAK PCAN-USB 轉接器插入電腦的 USB 插槽，確認指示燈正常。
2. **安裝 PEAK 驅動或放置 `PCANBasic.dll`**：
   * **方式 A（建議）**：至 PEAK-System 官網下載安裝 [PEAK-Drivers Setup](https://www.peak-system.com/quick/DrvSetup)，安裝時會自動將 64 位元的 `PCANBasic.dll` 註冊到 `C:\Windows\System32\`。
   * **方式 B（免安裝直接放 DLL）**：從 [PCAN-Basic API Package](https://www.peak-system.com/quick/PCAN-Basic-API) 解壓縮出 64-bit 的 `PCANBasic.dll`，直接複製到：
     * `C:\Windows\System32\PCANBasic.dll`，或
     * 執行檔同層目錄（`PortAssist-windows-x64.exe` / `port-assist.exe` 同層）。
3. **重新偵測**：
   * 插入硬體並備妥 DLL 後，切換到 **PCAN (CAN 2.0)** 分頁，點擊 PCAN 通道右側的重整鈕 **`↻`**，下拉選單即會顯示已連線的通道（例如：`PCAN_USBBUS1 (可用)`）。

---

## 核心功能特色
1. **多通訊協定支援**：
   * **串口 (COM)** ＋ 內建 **LOOPBACK**：波特率（支援任意自訂數值）、資料位、校驗位、停止位、流控與 `DTR / RTS / CTS / DSR / CD / RI` 訊號線監控控制。
   * **TCP Client**：連線至遠端伺服器 (`IP:Port`)。
   * **TCP Server**：本機 Port 監聽，支援多客戶端同時連入與廣播。
   * **UDP**：本地 Port 接收與目標 `IP:Port` 發送。
   * **PCAN (CAN 2.0A/B)**：支援 `PCAN_USBBUS1` ~ `8`、標準幀 (11-bit) / 擴展幀 (29-bit) / 遠端幀 (RTR) 與 10k ~ 1M 波特率。
2. **零延遲高幀率渲染 & 暫停檢視**：
   * 非阻塞批次收發與虛擬捲動，支援一鍵「暫停畫面」（背景持續接收，恢復後一次渲染累積幀）。
3. **自動斷幀與日誌匯出**：
   * 支援「超時 + 最大幀長」、「結尾碼 + 超時」、「純固定幀長」三種斷幀模式。
   * 支援含時間戳記、方向與 Hex/ASCII 的接收日誌匯出（`.txt`）。
4. **單模式發送編輯器 & 快捷發送 (CharList)**：
   * 主發送區可切換 **HEX**（`00`~`0F` 拆格對齊或純文字模式）或 **ASCII** 編輯，並內建 **SCPI** 常用儀器指令選單。
   * **多組快捷發送 (CharList)**：支援 `HEX` 勾選框即時雙向轉換、**每列獨立 `週期(ms)` 循環定時發送**（`0` 為跟隨全域輪詢），以及 `Serial Assistant ExCommand (.ini)` 格式匯入與匯出。
5. **多元接收檢視模式**：
   * **Hex + ASCII 並排 (經典)**、**純 Hex**、**純文字終端** 與 **分包日誌 (滾動模式)**。
   * **固定行模式 (Fixed / In-Place)**：依 CAN ID 或序列/網路幀頭分組原地覆蓋更新，支援 Data Hex（數據變更自動高亮）、ASCII、計數（Count）與毫秒級幀週期時間（Cycle Time ms）。
6. **跨平台原生體驗與彈性工作區**：
   * **macOS 原生整合**：支援原生 Overlay 紅黃綠燈標題列與系統頂部選單列。
   * 支援**深色 / 明亮模式**、**繁體中文 / English 雙語切換**、**字體大小（小 / 中 / 大）**、**可調寬度左側設定欄**，以及**分頁拖曳 / 右鍵獨立成新視窗**。

---

## License

本專案採用 [MIT License](LICENSE) 授權。
