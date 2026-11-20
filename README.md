# PortAssist (`port-assist`)

> 跨平台串口 (RS232/422/485) + TCP/UDP + PCAN (Classic CAN 2.0A/B) 綜合通訊調試助手（基於 Rust + Tauri 2 + Vanilla Web）

---

## 專案目錄結構

```text
port-assist/
├── ui/                     # 前端介面原始碼 (HTML5 / CSS3 / ES2022 Vanilla JS)
│   ├── index.html          # 主視窗結構 (多分頁、左側設定欄、經典並排檢視、發送區)
│   ├── styles.css          # 介面樣式與深色 / 明亮雙主題定義
│   └── app.js              # 前端邏輯 (虛擬捲動、自動斷幀、Hex 拆格編輯、.ini 匯入匯出、分頁獨立視窗)
├── src-tauri/              # Rust 後端與通訊引擎 (Tauri 2)
│   ├── src/
│   │   ├── main.rs         # 串口底層、TCP Client/Server、UDP Socket 非阻塞收發與多視窗管理
│   │   └── pcan.rs         # PEAK PCAN-Basic / MacCAN 動態載入與 Classic CAN 2.0 收發
│   ├── capabilities/       # Tauri 權限配置
│   ├── icons/              # 應用程式圖示
│   ├── Cargo.toml          # Rust 依賴設定
│   └── tauri.conf.json     # Tauri 應用程式設定
├── LICENSE                 # MIT License
└── README.md
```

## 編譯與執行說明

### 系統環境要求
* **macOS** 或 **Windows 10 / 11 (64-bit)**
* [Rust](https://rustup.rs/)（建議 **1.90+**，包含 Cargo）
* 系統 WebView（macOS 內建 WebKit；Windows 10/11 內建 WebView2 Runtime）
* **若需使用 PCAN 功能**：
  * macOS：安裝 [MacCAN PCBUSB](https://mac-can.com/)（`/usr/local/lib/libPCBUSB.dylib`）
  * Windows：安裝 PEAK-System PCAN-Basic 驅動（`PCANBasic.dll`）

### 本地執行與編譯
進入 `src-tauri` 目錄執行指令：

```bash
cd src-tauri

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
     * 執行檔同層目錄：`src-tauri/target/debug/PCANBasic.dll`（或發布目錄 `src-tauri/target/release/`）。
3. **重新偵測**：
   * 插入硬體並備妥 DLL 後，切換到 **PCAN (CAN 2.0)** 分頁，點擊 PCAN 通道右側的重整鈕 **`↻`**，下拉選單即會顯示已連線的通道（例如：`PCAN_USBBUS1 (可用)`）。

---

## 核心功能特色
1. **多通訊協定支援**：
   * **串口 (COM)**：波特率（支援任意自訂數值）、資料位、校驗位、停止位、流控與 `DTR / RTS / CTS / DSR / CD / RI` 訊號線監控控制。
   * **TCP Client**：連線至遠端伺服器 (`IP:Port`)。
   * **TCP Server**：本機 Port 監聽，支援多客戶端同時連入與廣播。
   * **UDP**：本地 Port 接收與目標 `IP:Port` 發送。
   * **PCAN (CAN 2.0A/B)**：支援 `PCAN_USBBUS1` ~ `8`、標準幀 (11-bit) / 擴展幀 (29-bit) / 遠端幀 (RTR) 與 10k ~ 1M 波特率。
2. **零延遲高幀率渲染 & 暫停檢視**：
   * 非阻塞批次收發與虛擬捲動，支援一鍵「暫停畫面」（背景持續接收，恢復後一次渲染累積幀）。
3. **自動斷幀與日誌匯出**：
   * 支援「超時 + 最大幀長」、「結尾碼 + 超時」、「純固定幀長」三種斷幀模式。
   * 支援含時間戳記、方向與 Hex/ASCII 的接收日誌匯出（`.txt`）。
4. **Hex 拆格編輯 & `.ini` 指令庫**：
   * 主發送區 Hex 支援 `00`~`0F` 拆格對齊編輯（可切換純文字模式），並與右側 ASCII 即時雙向同步。
   * 多組快捷發送（CharList）支援 `Serial Assistant ExCommand (.ini)` 格式匯入與匯出，並內建 SCPI 指令庫與定時循環發送。
5. **彈性工作區**：
   * 支援**深色 / 明亮模式**、**檢視選單字體大小（小 / 中 / 大）**、**可調寬度左側設定欄**，以及**分頁拖曳 / 右鍵獨立成新視窗**。
6. **多元接收檢視模式**：
   * **Hex + ASCII 並排 (經典)**、**純 Hex**、**純文字終端** 與 **分包日誌 (滾動模式)**。
   * **PCAN-View 經典「固定行模式 (Fixed / In-Place)」**：依 CAN ID 或幀原地覆蓋更新，支援 Data Hex（數據變更自動高亮）、ASCII、計數（Count）與毫秒級幀週期時間（Cycle Time ms），在高速廣播時畫面完全不滾動！

---

## License

本專案採用 [MIT License](LICENSE) 授權。
