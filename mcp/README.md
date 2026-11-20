# PortAssist Model Context Protocol (MCP) Server

**PortAssist MCP** 讓各類 AI 助理（如 Claude Desktop、Cursor、Antigravity、VS Code Roo Code / Cline）能夠直接調用本機實體串口 (RS232/422/485) 與 PCAN-USB (CAN 2.0A/B) 硬體進行即時通訊與數據收發。

---

## 🌟 架構特點

1. **零通訊埠衝突 (Zero Port Conflict)**：
   - 傳統方案中若 AI 直接開啟 COM 埠或 PCAN 通道，會導致桌面調試程式被鎖定 (`Access is denied` 或 `0x80000`)。
   - PortAssist MCP 透過 PortAssist 本機高效能核心 (`127.0.0.1:18080`) 統一管理硬體控制權，AI 調用與桌面使用者共享同一硬體實例，絕不衝突。
2. **人機協同即時可視化 (Live GUI Synchronization)**：
   - AI 發送的每一包串口字節或 CAN 幀，**立即同步顯示在 PortAssist 桌面畫面（包括 Fixed In-Place 列表與 Raw Hex 紀錄）**。
   - 硬體回傳的任何數據，使用者可在畫面上即時觀察，AI 也能透過 `portassist_read_rx` 即時獲取並進行分析判斷。
3. **極簡零依賴 (Zero External Pip Dependencies)**：
   - `mcp/port_assist_mcp.py` 僅使用 Python 標準庫，任何安裝有 Python 3.8+ 的電腦均可隨開即用，無需 `pip install` 任何第三方套件。

---

## 🛠️ 提供之 AI 工具一覽 (MCP Tools)

| 工具名稱 | 說明 |
| :--- | :--- |
| `portassist_status` | 查詢 PortAssist 執行狀態、目前開啟的連線與通道健康度 |
| `portassist_list_devices` | 掃描並列出本機所有實體串口 (COM) 與 PCAN-USB 硬體通道 |
| `portassist_connect_pcan` | 連線至 PCAN 通道 (預設 `PCAN_USBBUS1` @ `500000` bps) |
| `portassist_connect_serial` | 連線至指定串口 (例如 `COM3` @ `115200` bps) |
| `portassist_disconnect` | 中斷目前通訊階段 |
| `portassist_send_can` | 發送 Classic CAN 幀 (支援 11-bit Std / 29-bit Ext、RTR、Hex 數據 0~8 Bytes) |
| `portassist_send_serial` | 發送字串或十六進制 (Hex) 字節至串口 |
| `portassist_read_rx` | 讀取 PortAssist 接收緩衝區內的最新數據或 CAN 幀 |
| `portassist_clear_rx` | 清空接收緩衝區 |

---

## ⚙️ 各 AI 客戶端設定方法

### 1. Claude Desktop
在 `%APPDATA%\Claude\claude_desktop_config.json` 中加入：

```json
{
  "mcpServers": {
    "port-assist": {
      "command": "python",
      "args": [
        "d:/_WorkSpace/port-assist/mcp/port_assist_mcp.py"
      ]
    }
  }
}
```

### 2. Cursor IDE
在專案根目錄或使用者的 `.cursor/mcp.json` 中加入：

```json
{
  "mcpServers": {
    "port-assist": {
      "command": "python",
      "args": [
        "d:/_WorkSpace/port-assist/mcp/port_assist_mcp.py"
      ]
    }
  }
}
```

### 3. Antigravity / Gemini Custom MCP
將上述 Python 腳本註冊為 stdio MCP server：
```bash
python d:/_WorkSpace/port-assist/mcp/port_assist_mcp.py
```

---

## 🧪 獨立測試 MCP 伺服器

可以在終端機中透過 Python 快速測試：

```powershell
python -c "import subprocess, json; p = subprocess.Popen(['python', 'mcp/port_assist_mcp.py'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True); p.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/list','params':{}})+'\n'); p.stdin.flush(); print(p.stdout.readline())"
```
