(function (global) {
  const STORAGE_KEY = "portassist_lang";

  const MESSAGES = {
    "zh-Hant": {
      "lang.toggle.label": "🌐 EN",
      "lang.toggle.title": "切換介面語言 (繁體中文 / English)",
      "theme.dark": "🌙 深色",
      "theme.light": "☀️ 明亮",
      "theme.toggle.title": "切換深色 / 明亮模式",

      "menu.file": "檔案(F)",
      "menu.file.new": "新增串口分頁 (Ctrl+T)",
      "menu.file.close": "關閉目前分頁 (Ctrl+W)",
      "menu.file.loadTx": "載入檔案至發送區...",
      "menu.file.saveBin": "匯出接收數據 (Binary/.bin)...",
      "menu.file.saveTxt": "匯出接收十六進位報表 (.txt)...",
      "menu.file.clearAll": "全部清空 (RX & TX)",

      "menu.view": "檢視(V)",
      "menu.view.dual": "接收區：Hex + ASCII 並排 (經典)",
      "menu.view.hex": "接收區：僅十六進位 (Hex)",
      "menu.view.text": "接收區：純文字模式 (ASCII/UTF-8)",
      "menu.view.packets": "接收區：分包日誌 (滾動模式)",
      "menu.view.fixed": "接收區：固定行模式 (PCAN-View 覆蓋)",
      "menu.view.togglePackets": "切換日誌 / 經典檢視",
      "menu.view.fontSmall": "字體大小：小 (12px)",
      "menu.view.fontMedium": "字體大小：中 (14px)",
      "menu.view.fontLarge": "字體大小：大 (16px)",
      "menu.view.toggleLang": "切換語言：English / 繁體中文",

      "menu.op": "操作(O)",
      "menu.op.togglePort": "開啟 / 關閉串口 (F2)",
      "menu.op.sendNow": "立即傳送數據 (F5)",
      "menu.op.resetCounters": "重置 RX/TX 計數器",

      "menu.help": "說明(H)",
      "menu.help.about": "關於 PortAssist",

      "sidebar.connTitle": "通訊連線設定",
      "sidebar.protocol": "協議",
      "sidebar.serialPort": "串口",
      "sidebar.baudRate": "波特率",
      "sidebar.parity": "校驗位",
      "sidebar.dataBits": "數據位",
      "sidebar.stopBits": "停止位",
      "sidebar.flowControl": "流控",
      "sidebar.remoteHost": "目標 IP/主機",
      "sidebar.remotePort": "目標 Port",
      "sidebar.listenPort": "監聽 Port",
      "sidebar.listenIp": "監聽 IP",
      "sidebar.localPort": "本地 Port",
      "sidebar.targetIp": "目標 IP",
      "sidebar.pcanChannel": "PCAN 通道",
      "sidebar.canBaud": "CAN 波特率",
      "sidebar.openConn": "開啟串口",
      "sidebar.closeConn": "關閉連線",

      "can.txTitle": "CAN 發送設定",
      "can.txType": "幀類型",
      "can.typeStd": "標準幀 (11-bit)",
      "can.typeExt": "擴展幀 (29-bit)",
      "can.typeRtrStd": "遠端幀 RTR (11-bit)",
      "can.typeRtrExt": "遠端幀 RTR (29-bit)",

      "rx.settingsTitle": "接收設定",
      "rx.frameBreak": "自動斷幀",
      "rx.autoScroll": "自動捲動",
      "rx.timestamp": "時間戳記",
      "rx.showTx": "顯示 TX",
      "rx.frameRule": "斷幀模式",
      "rx.ruleTimeout": "超時 + 最大幀長",
      "rx.ruleDelim": "結尾碼 + 超時",
      "rx.ruleFixed": "純固定幀長",
      "rx.timeout": "超時時間",
      "rx.delim": "結尾特徵",
      "rx.maxLen": "最大幀長",
      "rx.layout": "排列方式",
      "rx.layoutSingle": "每幀一行(不折行)",
      "rx.layoutCont16": "固定16B連續",
      "rx.layoutCont32": "固定32B連續",
      "rx.layoutWrap16": "每幀換行(16B折)",
      "rx.pause": "⏸ 暫停畫面",
      "rx.resume": "▶ 恢復畫面",

      "lines.title": "流控訊號線",

      "rx.paneTitle": "接收區",
      "rx.modeDual": "Hex+ASCII",
      "rx.modeHex": "純Hex",
      "rx.modeText": "純文字",
      "rx.modePackets": "日誌",
      "rx.modeFixed": "固定(Fixed)",
      "rx.copyHex": "複製Hex",
      "rx.copyText": "複製文字",
      "rx.saveLog": "儲存日誌",
      "rx.clear": "清空接收",
      "rx.thId": "CAN ID / 識別",
      "rx.thType": "類型",
      "rx.thData": "數據 (Data Hex)",
      "rx.thCount": "計數",
      "rx.thCycle": "週期 (ms)",
      "rx.thTime": "時間",
      "rx.inspectorLabel": "游標檢視：",
      "rx.inspectorHint": "滑鼠指向或點擊任一 Byte 以檢視位址、所屬數據幀、Hex / Dec / Bin 與 ASCII 資訊",

      "tx.tabEditor": "主發送區 (Hex / ASCII 同步編輯)",
      "tx.tabDatalist": "多組快捷發送 (CharList)",
      "tx.scpiBtn": "SCPI 指令 ▾",
      "tx.appendCrlf": "附加 \\r\\n (0D 0A)",
      "tx.clear": "清空發送",
      "tx.hexBarTitle": "十六進位編輯區 (Hex) — 00~0F 拆格對齊",
      "tx.hexFormatOk": "格式正常",
      "tx.hexViewText": "文字模式",
      "tx.hexViewGrid": "拆格模式",
      "tx.asciiBarTitle": "字元編輯區 (ASCII / UTF-8) — 與左側 Hex 即時雙向同步",
      "tx.asciiBarHint": "非列印字元在預覽中顯示為 '.'",
      "tx.hexPlaceholder": "輸入十六進位 (例如: 41 42 43 0D 0A)...",
      "tx.asciiPlaceholder": "在此輸入文字，左側 Hex 將即時同步更新...",

      "datalist.addRow": "+ 新增指令列",
      "datalist.loadScpi": "載入 SCPI 範本",
      "datalist.importIni": "匯入 (.ini)",
      "datalist.exportIni": "匯出 (.ini)",
      "datalist.tip": "提示：勾選項目後開啟下方「定時發送」，即可按順序循環發送多組指令。",
      "datalist.colLoop": "循環",
      "datalist.colName": "備註名稱",
      "datalist.colFormat": "格式",
      "datalist.colPayload": "發送內容 (Hex 或 ASCII)",
      "datalist.colAction": "操作",

      "auto.toggle": "定時發送",
      "auto.interval": "週期",
      "auto.count": "次數",
      "tx.sendBtn": "傳送",

      "status.ready": "就緒 — 串口未開啟",
      "status.tabReady": "分頁 #{seq} 就緒 — 串口未開啟",
      "status.reset": "歸零",
      "status.resetTitle": "歸零收發計數",
      "status.connSummary": "{open}/{total} 連線",
      "status.frameCount": "{count} 幀",
      "status.txLen": "長度: {count} Bytes",
      "status.pktUnit": "筆",
      "status.netClients": "{count} 客戶端",
      "status.opened": "[{title}] 已開啟 ({baud} bps, {parity}, {data}, {stop})",
      "status.closed": "[{title}] 通訊已關閉",
      "status.sentBytes": "已傳送 {count} Bytes 至 {port}",
      "status.sendFailed": "傳送失敗: {err}",
      "status.emptyTx": "發送區為空，無數據可傳送",
      "status.rxPaused": "已暫停接收畫面渲染（背景持續接收中）",
      "status.rxResumed": "已恢復接收畫面渲染",
      "status.copiedHex": "已複製接收區十六進位內容至剪貼簿",
      "status.copiedText": "已複製接收區文字內容至剪貼簿",
      "status.clearedRx": "已清空接收區緩衝與畫面",
      "status.clearedTx": "已清空發送區",
      "status.countersReset": "RX / TX 收發計數器已歸零",
      "loopback.label": "LOOPBACK (內建迴路測試串口)",
      "empty.hexGrid": "此分頁（{title}）尚無收發數據。開啟連線並傳送數據後，此處將即時顯示時間戳記、Hex 與 ASCII 內容。",
      "empty.textView": "（此分頁尚無收發數據）",
      "empty.packetView": "此分頁尚無收發封包紀錄。",
      "empty.fixedTable": "尚無收到任何數據幀。連線並接收數據（Serial / TCP / UDP / PCAN）後，將依來源 ID 在此原地更新。",
      "tx.hexOkBytes": "格式正常 ({count} Bytes)",
      "tx.hexOddNibble": "提示：尚有未湊滿 2 位數的半位元組",
      "tx.hexTyping": "輸入中...",
      "datalist.sendBtn": "傳送",
      "datalist.delTitle": "刪除此列",
    },
    en: {
      "lang.toggle.label": "🌐 繁中",
      "lang.toggle.title": "Switch UI Language (繁體中文 / English)",
      "theme.dark": "🌙 Dark",
      "theme.light": "☀️ Light",
      "theme.toggle.title": "Toggle Dark / Light Theme",

      "menu.file": "File(F)",
      "menu.file.new": "New Tab (Ctrl+T)",
      "menu.file.close": "Close Current Tab (Ctrl+W)",
      "menu.file.loadTx": "Load File to TX...",
      "menu.file.saveBin": "Export RX Data (Binary/.bin)...",
      "menu.file.saveTxt": "Export RX Hex Report (.txt)...",
      "menu.file.clearAll": "Clear All (RX & TX)",

      "menu.view": "View(V)",
      "menu.view.dual": "RX: Hex + ASCII Split (Classic)",
      "menu.view.hex": "RX: Hex Only",
      "menu.view.text": "RX: Plain Text (ASCII/UTF-8)",
      "menu.view.packets": "RX: Packet Log (Scroll)",
      "menu.view.fixed": "RX: Fixed Table (PCAN-View)",
      "menu.view.togglePackets": "Toggle Log / Classic View",
      "menu.view.fontSmall": "Font Size: Small (12px)",
      "menu.view.fontMedium": "Font Size: Medium (14px)",
      "menu.view.fontLarge": "Font Size: Large (16px)",
      "menu.view.toggleLang": "Switch Language: 繁體中文 / English",

      "menu.op": "Action(O)",
      "menu.op.togglePort": "Open / Close Connection (F2)",
      "menu.op.sendNow": "Send Now (F5)",
      "menu.op.resetCounters": "Reset RX/TX Counters",

      "menu.help": "Help(H)",
      "menu.help.about": "About PortAssist",

      "sidebar.connTitle": "Connection",
      "sidebar.protocol": "Protocol",
      "sidebar.serialPort": "Port",
      "sidebar.baudRate": "Baud Rate",
      "sidebar.parity": "Parity",
      "sidebar.dataBits": "Data Bits",
      "sidebar.stopBits": "Stop Bits",
      "sidebar.flowControl": "Flow Ctrl",
      "sidebar.remoteHost": "Target Host",
      "sidebar.remotePort": "Target Port",
      "sidebar.listenPort": "Listen Port",
      "sidebar.listenIp": "Listen IP",
      "sidebar.localPort": "Local Port",
      "sidebar.targetIp": "Target IP",
      "sidebar.pcanChannel": "PCAN Ch",
      "sidebar.canBaud": "CAN Baud",
      "sidebar.openConn": "Open Port",
      "sidebar.closeConn": "Close Port",

      "can.txTitle": "CAN TX Settings",
      "can.txType": "Frame Type",
      "can.typeStd": "Standard (11-bit)",
      "can.typeExt": "Extended (29-bit)",
      "can.typeRtrStd": "RTR Remote (11-bit)",
      "can.typeRtrExt": "RTR Remote (29-bit)",

      "rx.settingsTitle": "Receive Settings",
      "rx.frameBreak": "Auto Frame",
      "rx.autoScroll": "Auto Scroll",
      "rx.timestamp": "Timestamp",
      "rx.showTx": "Show TX",
      "rx.frameRule": "Framing",
      "rx.ruleTimeout": "Timeout + MaxLen",
      "rx.ruleDelim": "Delimiter + Timeout",
      "rx.ruleFixed": "Fixed Length",
      "rx.timeout": "Timeout",
      "rx.delim": "Delimiter",
      "rx.maxLen": "Max Len",
      "rx.layout": "Layout",
      "rx.layoutSingle": "1 Frame / Row",
      "rx.layoutCont16": "Continuous 16B",
      "rx.layoutCont32": "Continuous 32B",
      "rx.layoutWrap16": "Frame Wrap 16B",
      "rx.pause": "⏸ Pause View",
      "rx.resume": "▶ Resume View",

      "lines.title": "Control Lines",

      "rx.paneTitle": "Receive",
      "rx.modeDual": "Hex+ASCII",
      "rx.modeHex": "Hex",
      "rx.modeText": "Text",
      "menu.view.packetsShort": "Log",
      "rx.modePackets": "Log",
      "rx.modeFixed": "Fixed",
      "rx.copyHex": "Copy Hex",
      "rx.copyText": "Copy Text",
      "rx.saveLog": "Save Log",
      "rx.clear": "Clear RX",
      "rx.thId": "CAN ID / Tag",
      "rx.thType": "Type",
      "rx.thData": "Data (Hex)",
      "rx.thCount": "Count",
      "rx.thCycle": "Cycle (ms)",
      "rx.thTime": "Time",
      "rx.inspectorLabel": "Inspector:",
      "rx.inspectorHint": "Hover or click any byte to inspect offset, frame, Hex / Dec / Bin & ASCII",

      "tx.tabEditor": "Transmit Editor (Hex / ASCII Sync)",
      "tx.tabDatalist": "Quick List (CharList)",
      "tx.scpiBtn": "SCPI ▾",
      "tx.appendCrlf": "Append \\r\\n",
      "tx.clear": "Clear TX",
      "tx.hexBarTitle": "Hex Editor — 00~0F Byte Grid",
      "tx.hexFormatOk": "Valid Hex",
      "tx.hexViewText": "Text Mode",
      "tx.hexViewGrid": "Grid Mode",
      "tx.asciiBarTitle": "ASCII / UTF-8 Editor — Live Sync with Hex",
      "tx.asciiBarHint": "Non-printable bytes shown as '.'",
      "tx.hexPlaceholder": "Enter hex bytes (e.g. 41 42 43 0D 0A)...",
      "tx.asciiPlaceholder": "Type text here, Hex updates in real time...",

      "datalist.addRow": "+ Add Row",
      "datalist.loadScpi": "Load SCPI",
      "datalist.importIni": "Import (.ini)",
      "datalist.exportIni": "Export (.ini)",
      "datalist.tip": "Tip: Check rows and enable Auto Send below to cycle through commands.",
      "datalist.colLoop": "Loop",
      "datalist.colName": "Label",
      "datalist.colFormat": "Format",
      "datalist.colPayload": "Payload (Hex or ASCII)",
      "datalist.colAction": "Action",

      "auto.toggle": "Auto Send",
      "auto.interval": "Period",
      "auto.count": "Count",
      "tx.sendBtn": "Send",

      "status.ready": "Ready — Port Closed",
      "status.tabReady": "Tab #{seq} Ready — Port Closed",
      "status.reset": "Reset",
      "status.resetTitle": "Reset RX/TX Counters",
      "status.connSummary": "{open}/{total} Active",
      "status.frameCount": "{count} frames",
      "status.txLen": "Len: {count} Bytes",
      "status.pktUnit": "pkts",
      "status.netClients": "{count} clients",
      "status.opened": "[{title}] Opened ({baud} bps, {parity}, {data}, {stop})",
      "status.closed": "[{title}] Connection closed",
      "status.sentBytes": "Sent {count} Bytes to {port}",
      "status.sendFailed": "Send failed: {err}",
      "status.emptyTx": "TX buffer is empty",
      "status.rxPaused": "RX view paused (receiving in background)",
      "status.rxResumed": "RX view resumed",
      "status.copiedHex": "Copied RX hex to clipboard",
      "status.copiedText": "Copied RX text to clipboard",
      "status.clearedRx": "Cleared RX buffer and view",
      "status.clearedTx": "Cleared TX buffer",
      "status.countersReset": "RX / TX counters reset",
      "loopback.label": "LOOPBACK (Built-in Loopback Test)",
      "empty.hexGrid": "No data in this tab ({title}). Open a connection and send data to see timestamps, Hex, and ASCII here.",
      "empty.textView": "(No data in this tab)",
      "empty.packetView": "No packet records in this tab.",
      "empty.fixedTable": "No frames received yet. Once data arrives (Serial / TCP / UDP / PCAN), rows will update in place here.",
      "tx.hexOkBytes": "Valid Hex ({count} Bytes)",
      "tx.hexOddNibble": "Note: odd hex nibble pending",
      "tx.hexTyping": "Typing...",
      "datalist.sendBtn": "Send",
      "datalist.delTitle": "Delete row",
    },
  };

  let currentLang = "zh-Hant";
  try {
    const saved = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh-Hant") {
      currentLang = saved;
    }
  } catch (_) {}

  function getLang() {
    return currentLang;
  }

  function setLang(lang) {
    currentLang = lang === "en" ? "en" : "zh-Hant";
    try {
      if (global.localStorage) {
        global.localStorage.setItem(STORAGE_KEY, currentLang);
      }
    } catch (_) {}
    return currentLang;
  }

  function t(key, vars) {
    const dict = MESSAGES[currentLang] || MESSAGES["zh-Hant"];
    let str = dict[key] ?? MESSAGES["zh-Hant"][key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return str;
  }

  function applyI18nToDom(root) {
    const doc = root || (typeof document !== "undefined" ? document : null);
    if (!doc) return;
    doc.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) el.textContent = t(key);
    });
    doc.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      if (key) el.title = t(key);
    });
    doc.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      if (key) el.placeholder = t(key);
    });
  }

  const api = {
    MESSAGES,
    getLang,
    setLang,
    t,
    applyI18nToDom,
  };

  global.PortAssist = global.PortAssist || {};
  global.PortAssist.i18n = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
