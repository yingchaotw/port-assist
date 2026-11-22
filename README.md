# PortAssist (`port-assist`)

**English** | [繁體中文](README.zh-TW.md)

> Cross-platform Serial (RS232/422/485) + TCP/UDP + PCAN (Classic CAN 2.0A/B) debugging assistant built with Rust, Tauri 2, and Vanilla Web.

---

## Download (Pre-built Portable Binaries)

No Rust or Node.js environment required — download the latest portable executable from the **[Releases](https://github.com/yingchaotw/port-assist/releases)** page:

* **Windows (64-bit)**: `PortAssist-windows-x64.exe`
* **macOS (Apple Silicon)**: `PortAssist-macos-arm64.tar.gz`

> **UI Language**: You can switch between **English** and **繁體中文** anytime from **View → Switch Language** (`檢視(V) → 切換語言`).

---

## Project Structure

```text
port-assist/
├── ui/                         # Frontend source (HTML5 / CSS3 / Vanilla JS)
│   ├── index.html              # Main window layout (tabs, sidebar, RX/TX panes, status bar)
│   ├── styles.css              # Light & Dark themes and component styles
│   ├── app.js                  # DOM controller & virtual scrolling renderer
│   └── js/                     # Modular pure-logic & i18n layers
│       ├── i18n.js             # Bilingual (English / Traditional Chinese) dictionary
│       ├── codec.js            # Hex / UTF-8 / ASCII codecs & odd-nibble validation
│       ├── framer.js           # O(1) incremental frame segmentation & Fixed grouping
│       ├── can-parser.js       # PCAN frame formatting & Fixed table updates
│       ├── excommand.js        # Serial Assistant ExCommand (.ini) parser & SCPI presets
│       ├── exporter.js         # Timestamped log & Fixed table exporter
│       └── session-model.js    # Multi-tab session state & detach serialization
├── src-tauri/                  # Rust backend & transport engine (Tauri 2)
│   ├── src/
│   │   ├── main.rs             # Tauri entry point & TauriEventSink adapter
│   │   ├── manager.rs          # Session state, ActivePort & TransportEvent / EventSink
│   │   ├── serial.rs           # Serial port & built-in LOOPBACK transport
│   │   ├── net.rs              # Non-blocking TCP Client/Server & UDP socket
│   │   ├── pcan.rs             # Dynamic PCAN-Basic / MacCAN loader & CAN 2.0 I/O
│   │   ├── window.rs           # Window controls, tab detaching & macOS native menu
│   │   ├── api_server.rs       # Local HTTP API server (127.0.0.1:18080)
│   │   └── main_helpers.rs     # HTTP API request handlers
│   ├── capabilities/           # Tauri permissions
│   ├── icons/                  # Application icons
│   ├── Cargo.toml              # Rust dependencies
│   └── tauri.conf.json         # Tauri configuration
├── mcp/                        # Python MCP server for AI/automation integration
├── LICENSE                     # MIT License
├── README.md                   # English README
└── README.zh-TW.md             # Traditional Chinese README
```

---

## Build from Source

### Prerequisites
* **macOS** or **Windows 10 / 11 (64-bit)**
* [Rust](https://rustup.rs/) (**1.90+** recommended, with Cargo)
* System WebView (WebKit on macOS; WebView2 Runtime on Windows 10/11)
* **Optional (for PCAN)**:
  * macOS: [MacCAN PCBUSB](https://mac-can.com/) (`/usr/local/lib/libPCBUSB.dylib`)
  * Windows: PEAK-System PCAN-Basic driver (`PCANBasic.dll`)

### Commands
```bash
cd src-tauri

# Run unit & integration tests
cargo test

# Run in debug mode
cargo run

# Build release binary
cargo build --release
```

Output binaries:
* **macOS**: `src-tauri/target/release/port-assist`
* **Windows**: `src-tauri/target/release/port-assist.exe`

---

## PCAN (CAN 2.0) Setup & Troubleshooting

If switching to **PCAN (CAN 2.0)** shows no channels or fails to open on Windows:

1. **Connect Hardware**: Plug in your PEAK PCAN-USB adapter and verify its status LED.
2. **Install Driver or Place `PCANBasic.dll`**:
   * **Option A (Recommended)**: Install [PEAK-Drivers Setup](https://www.peak-system.com/quick/DrvSetup) (registers 64-bit `PCANBasic.dll` into `C:\Windows\System32\`).
   * **Option B (Portable)**: Extract the 64-bit `PCANBasic.dll` from [PCAN-Basic API Package](https://www.peak-system.com/quick/PCAN-Basic-API) and place it in `C:\Windows\System32\` or in the **same folder** as `PortAssist-windows-x64.exe` (`port-assist.exe`).
3. **Refresh**: Click the refresh button **`↻`** next to the PCAN channel dropdown (e.g., `PCAN_USBBUS1`).

---

## Key Features

1. **Multi-Protocol Transport**:
   * **Serial (COM)** + built-in **LOOPBACK**: Arbitrary custom baud rates, data/parity/stop bits, flow control, and live `DTR / RTS / CTS / DSR / CD / RI` line control & monitoring.
   * **TCP Client**: Connect to a remote `IP:Port`.
   * **TCP Server**: Local listener supporting multiple concurrent clients and broadcast.
   * **UDP**: Local port bind with dynamic remote `IP:Port` target.
   * **PCAN (CAN 2.0A/B)**: `PCAN_USBBUS1` ~ `8`, Standard (11-bit) / Extended (29-bit) / RTR frames, 10 kbps ~ 1 Mbps.
2. **High-Throughput Virtual Scrolling & Pause**:
   * Non-blocking batched RX and virtualized DOM rendering with one-click **Pause View** (continues buffering in the background).
3. **Auto Frame Segmentation & Log Export**:
   * Three framing rules: **Timeout + MaxLen**, **Delimiter + Timeout**, and **Fixed Length**.
   * Export timestamped logs (`.txt`) and Fixed Table snapshots.
4. **Single-Mode TX Editor & Quick List (CharList)**:
   * Switch cleanly between **HEX** (`00`~`0F` byte grid or raw hex text) and **ASCII** editors, plus built-in **SCPI** command palette.
   * **Quick List (CharList)**: Compact `HEX` toggle with live HEX ↔ ASCII conversion, per-row independent **Period (ms)** cycle timers (or `0` for sequential global polling), and `Serial Assistant ExCommand (.ini)` import/export.
5. **Multiple Receive Views**:
   * **Hex + ASCII**, **Hex Only**, **Plain Text**, **Packet Log**, and **Fixed (In-Place)** mode (groups by CAN ID or Serial/Net frame header, highlights changed bytes, and tracks packet count & cycle time in ms).
6. **Native Cross-Platform Experience**:
   * **macOS**: Native overlay titlebar traffic lights & system top menu bar.
   * **Light / Dark Themes**, **Font Size** (`12px` / `14px` / `16px`), **Bilingual UI** (`English` / `繁體中文`), resizable sidebar, and **detachable tab windows**.

---

## License

Licensed under the [MIT License](LICENSE).
