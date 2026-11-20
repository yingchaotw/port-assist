// AccessPort (Rust Edition) High-Performance Multi-Port Frontend Controller
(() => {
  const getTauriInvoke = () => {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke;
    }
    if (window.__TAURI__ && window.__TAURI__.tauri && window.__TAURI__.tauri.invoke) {
      return window.__TAURI__.tauri.invoke;
    }
    return null;
  };

  const getTauriListen = () => {
    if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
      return window.__TAURI__.event.listen;
    }
    return null;
  };

  // ==================== CONSTANTS & FAST LOOKUP TABLES ====================
  let ROW_HEIGHT = 20; // exact pixel height of each .hex-row for virtual scrolling
  let currentHbWidth = 24;
  let currentAbWidth = 9;
  const OVERSCAN_ROWS = 5; // extra rows rendered above and below visible viewport
  const MAX_SINGLE_ROW_COLS = 512; // allow up to 512 bytes on a single line without wrapping

  const HEX2_TABLE = Array.from({ length: 256 }, (_, i) =>
    i.toString(16).toUpperCase().padStart(2, "0")
  );
  const ASCII_TABLE = Array.from({ length: 256 }, (_, i) =>
    i >= 0x20 && i <= 0x7e ? String.fromCharCode(i) : "."
  );

  const toHex2 = (b) => HEX2_TABLE[b & 0xff];
  const toHex8 = (n) => n.toString(16).toUpperCase().padStart(8, "0");
  const toPrintableAscii = (b) => ASCII_TABLE[b & 0xff];

  const bytesToHexString = (bytes, wrap16 = false) => {
    if (!bytes || bytes.length === 0) return "";
    if (!wrap16) {
      return bytes.map(toHex2).join(" ");
    }
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const slice = bytes.slice(i, i + 16);
      lines.push(slice.map(toHex2).join(" "));
    }
    return lines.join("\n");
  };

  const bytesToUtf8Text = (bytes) => {
    if (!bytes || bytes.length === 0) return "";
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
    } catch {
      return bytes.map((b) => String.fromCharCode(b)).join("");
    }
  };

  const utf8TextToBytes = (text) => Array.from(new TextEncoder().encode(text));

  const parseHexInput = (raw) => {
    const cleaned = raw.replace(/[^0-9a-fA-F]/g, "");
    const bytes = [];
    for (let i = 0; i < cleaned.length; i += 2) {
      const pair = cleaned.substring(i, i + 2);
      bytes.push(parseInt(pair, 16));
    }
    return {
      bytes,
      hasOddNibble: cleaned.length % 2 !== 0,
    };
  };

  const formatDateToTimeStr = (d) => {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  };

  const formatTimestamp = () => formatDateToTimeStr(new Date());

  // ==================== MULTI-SESSION STATE ====================
  let nextSessionSeq = 1;
  let availablePortsCache = [];
  const sessions = [];
  let activeSessionId = "";

  function createSessionObject(preferredPort) {
    const seq = nextSessionSeq++;
    const id = `session-${seq}`;
    const initialBytes = utf8TextToBytes("AT+GMR\r\n");

    return {
      id,
      seq,
      customTitle: "",
      isOpen: false,
      connType: "serial", // 'serial' | 'tcp_client' | 'tcp_server' | 'udp'
      portName: preferredPort || "LOOPBACK",
      baudRate: "115200",
      parity: "None",
      dataBits: "8",
      stopBits: "1",
      flowControl: "None",

      tcpClientHost: "127.0.0.1",
      tcpClientPort: "8080",
      tcpServerHost: "0.0.0.0",
      tcpServerPort: "8080",
      tcpServerClients: 0,
      udpLocalPort: "8081",
      udpHost: "127.0.0.1",
      udpPort: "8080",

      pcanChannel: "PCAN_USBBUS1",
      pcanBaud: "500000",
      canTxId: "7DF",
      canTxType: "std",

      rxMode: "dual", // 'dual' | 'hex' | 'text' | 'packets'
      txTab: "editor", // 'editor' | 'datalist'
      rxBytes: [], // pure RX bytes for RX counter & export
      viewBytes: [], // displayed bytes (RX + optional inline TX)
      rxRawChunks: [], // { perfMs, timeStr, dir: 'RX'|'TX', bytes: number[] }
      rxByteFrameIds: [], // frameId for each byte in viewBytes
      rxFrames: [], // { id, dir: 'RX'|'TX', startIdx, length, timeStr, lastPerfMs }
      rowSlices: [], // precomputed virtual row descriptors { rowStart, rowEnd, isNewFrameRow, frameObj }
      maxCols: 16,

      frameBreakEnabled: true,
      frameRule: "timeout_maxlen", // 'timeout_maxlen' | 'delimiter' | 'fixed_len'
      frameTimeoutMs: 20,
      frameMaxLen: 0, // 0 = no max length limit (in fixed_len, defaults to 16)
      frameDelimHex: "0D 0A",
      frameLayout: "frame_single", // 'frame_single' | 'continuous_16' | 'continuous_32' | 'frame_wrap16'
      showTimestamp: true,
      showTxInline: true,
      rxPaused: false,

      txBytes: initialBytes,
      txHexText: bytesToHexString(initialBytes, true),
      txAsciiText: bytesToUtf8Text(initialBytes),
      txHasOddNibble: false,
      txCrlf: false,

      packets: [],
      fixedMap: new Map(),
      rxPktCount: 0,
      txByteCount: 0,
      txPktCount: 0,
      selectedRxIndex: -1,
      unreadRxBytes: 0,

      dtr: false,
      rts: false,
      cts: false,
      dsr: false,
      cd: false,
      ri: false,

      autoSendEnabled: false,
      autoSendInterval: 1000,
      autoSendMaxCount: 0,
      autoSendCurrentCount: 0,
      autoSendTimer: null,

      statusText: `分頁 #${seq} 就緒 — 串口未開啟`,
      datalistCursor: 0,
      datalist: [
        { enabled: true, name: "AT 測試指令", format: "ASCII", payload: "AT+GMR\\r\\n" },
        { enabled: true, name: "Modbus 讀保持暫存器", format: "HEX", payload: "01 03 00 00 00 02 C4 0B" },
        { enabled: false, name: "查詢設備狀態", format: "HEX", payload: "AA 55 01 00 00 56" },
        { enabled: false, name: "心跳封包 (Heartbeat)", format: "ASCII", payload: "PING\\r\\n" },
      ],
    };
  }

  const getSessionById = (id) => sessions.find((s) => s.id === id) || null;
  const getActiveSession = () => getSessionById(activeSessionId) || sessions[0];

  // ==================== DOM ELEMENTS ====================
  const el = {
    titlebar: document.getElementById("titlebar"),
    appLogoDrag: document.getElementById("app-logo-drag"),
    titlebarTabsArea: document.getElementById("titlebar-tabs-area"),
    titlebarDragSpacer: document.getElementById("titlebar-drag-spacer"),
    btnTabsLeft: document.getElementById("btn-tabs-left"),
    btnTabsRight: document.getElementById("btn-tabs-right"),
    btnThemeToggle: document.getElementById("btn-theme-toggle"),
    menuFontBtns: document.querySelectorAll(".menu-font-btn"),
    sessionTabsList: document.getElementById("session-tabs-list"),
    btnNewSession: document.getElementById("btn-new-session"),
    sessionSummary: document.getElementById("session-summary"),
    btnWinMin: document.getElementById("btn-win-min"),
    btnWinMax: document.getElementById("btn-win-max"),
    btnWinClose: document.getElementById("btn-win-close"),

    btnPortToggle: document.getElementById("btn-port-toggle"),
    portLed: document.getElementById("port-led"),
    portToggleLabel: document.getElementById("port-toggle-label"),
    selConnType: document.getElementById("sel-conn-type"),
    paramsSerial: document.getElementById("params-serial"),
    paramsNet: document.getElementById("params-net"),
    netFieldsTcpClient: document.getElementById("net-fields-tcp-client"),
    netFieldsTcpServer: document.getElementById("net-fields-tcp-server"),
    netFieldsUdp: document.getElementById("net-fields-udp"),

    inpTcpClientHost: document.getElementById("inp-tcp-client-host"),
    inpTcpClientPort: document.getElementById("inp-tcp-client-port"),
    inpTcpServerPort: document.getElementById("inp-tcp-server-port"),
    inpTcpServerHost: document.getElementById("inp-tcp-server-host"),
    netServerClientsPill: document.getElementById("net-server-clients-pill"),
    inpUdpLocalPort: document.getElementById("inp-udp-local-port"),
    inpUdpHost: document.getElementById("inp-udp-host"),
    inpUdpPort: document.getElementById("inp-udp-port"),

    paramsPcan: document.getElementById("params-pcan"),
    selPcanChannel: document.getElementById("sel-pcan-channel"),
    btnRefreshPcan: document.getElementById("btn-refresh-pcan"),
    selPcanBaud: document.getElementById("sel-pcan-baud"),
    txCanBar: document.getElementById("tx-can-bar"),
    inpCanTxId: document.getElementById("inp-can-tx-id"),
    selCanTxType: document.getElementById("sel-can-tx-type"),

    selPort: document.getElementById("sel-port"),
    btnRefreshPorts: document.getElementById("btn-refresh-ports"),
    baudCombo: document.getElementById("baud-combo"),
    inpBaud: document.getElementById("inp-baud"),
    btnBaudDropdown: document.getElementById("btn-baud-dropdown"),
    baudMenu: document.getElementById("baud-menu"),
    selParity: document.getElementById("sel-parity"),
    selDatabits: document.getElementById("sel-databits"),
    selStopbits: document.getElementById("sel-stopbits"),
    selFlow: document.getElementById("sel-flow"),
    btnSend: document.getElementById("btn-send"),
    btnTxSendPlane: document.getElementById("btn-tx-send-plane"),
    autoSendBox: document.getElementById("auto-send-box"),
    chkAutoSend: document.getElementById("chk-auto-send"),
    ledAutoSend: document.getElementById("led-auto-send"),
    inpAutoInterval: document.getElementById("inp-auto-interval"),
    inpAutoMaxCount: document.getElementById("inp-auto-max-count"),
    autoSendProgress: document.getElementById("auto-send-progress"),
    btnClearRx: document.getElementById("btn-clear-rx"),
    btnClearTx: document.getElementById("btn-clear-tx"),

    rxSelectionInfo: document.getElementById("rx-selection-info"),
    chkFrameBreak: document.getElementById("chk-frame-break"),
    selFrameRule: document.getElementById("sel-frame-rule"),
    wrapFrameTimeout: document.getElementById("wrap-frame-timeout"),
    inpFrameTimeout: document.getElementById("inp-frame-timeout"),
    wrapFrameDelim: document.getElementById("wrap-frame-delim"),
    inpFrameDelim: document.getElementById("inp-frame-delim"),
    wrapFrameMaxlen: document.getElementById("wrap-frame-maxlen"),
    lblFrameMaxlen: document.getElementById("lbl-frame-maxlen"),
    inpFrameMaxlen: document.getElementById("inp-frame-maxlen"),
    selFrameLayout: document.getElementById("sel-frame-layout"),
    rxFrameCount: document.getElementById("rx-frame-count"),
    chkShowTimestamp: document.getElementById("chk-show-timestamp"),
    chkShowTxInline: document.getElementById("chk-show-tx-inline"),
    btnRxPause: document.getElementById("btn-rx-pause"),
    rxModeGroup: document.getElementById("rx-mode-group"),
    chkRxAutoscroll: document.getElementById("chk-rx-autoscroll"),
    btnCopyRxHex: document.getElementById("btn-copy-rx-hex"),
    btnCopyRxText: document.getElementById("btn-copy-rx-text"),
    btnSaveRxLog: document.getElementById("btn-save-rx-log"),
    rxHexRuler: document.getElementById("rx-hex-ruler"),
    rxViewport: document.getElementById("rx-viewport"),
    rxHexGrid: document.getElementById("rx-hex-grid"),
    rxTextView: document.getElementById("rx-text-view"),
    rxPacketView: document.getElementById("rx-packet-view"),
    rxFixedView: document.getElementById("rx-fixed-view"),
    fixedTableBody: document.getElementById("fixed-table-body"),

    appBody: document.querySelector(".app-body"),
    leftSidebar: document.getElementById("left-sidebar"),
    sidebarSplitter: document.getElementById("sidebar-splitter"),
    splitter: document.getElementById("pane-splitter"),
    workspace: document.getElementById("workspace"),
    rxPane: document.getElementById("rx-pane"),
    txPane: document.getElementById("tx-pane"),

    txTabs: document.querySelectorAll(".tx-tab"),
    txTabEditor: document.getElementById("tx-tab-editor"),
    txTabDatalist: document.getElementById("tx-tab-datalist"),
    scpiCombo: document.getElementById("scpi-combo"),
    btnScpiMenu: document.getElementById("btn-scpi-menu"),
    scpiMenu: document.getElementById("scpi-menu"),
    chkTxCrlf: document.getElementById("chk-tx-crlf"),
    txLengthPill: document.getElementById("tx-length-pill"),
    btnTxHexView: document.getElementById("btn-tx-hex-view"),
    txHexGridWrap: document.getElementById("tx-hex-grid-wrap"),
    txRulerHexCols: document.getElementById("tx-ruler-hex-cols"),
    txHexGrid: document.getElementById("tx-hex-grid"),
    txHexWrap: document.getElementById("tx-hex-wrap"),
    txOffsetGutter: document.getElementById("tx-offset-gutter"),
    txHexInput: document.getElementById("tx-hex-input"),
    txAsciiInput: document.getElementById("tx-ascii-input"),
    txHexStatus: document.getElementById("tx-hex-status"),

    btnAddRow: document.getElementById("btn-add-row"),
    btnLoadScpiTemplate: document.getElementById("btn-load-scpi-template"),
    btnImportDatalist: document.getElementById("btn-import-datalist"),
    inpImportDatalist: document.getElementById("inp-import-datalist"),
    btnExportDatalist: document.getElementById("btn-export-datalist"),
    datalistTbody: document.getElementById("datalist-tbody"),

    statusDot: document.getElementById("status-dot"),
    statusMsg: document.getElementById("status-msg"),
    btnLineDtr: document.getElementById("btn-line-dtr"),
    btnLineRts: document.getElementById("btn-line-rts"),
    ledDtr: document.getElementById("led-dtr"),
    ledRts: document.getElementById("led-rts"),
    ledCts: document.getElementById("led-cts"),
    ledDsr: document.getElementById("led-dsr"),
    ledCd: document.getElementById("led-cd"),
    ledRi: document.getElementById("led-ri"),
    countRxBytes: document.getElementById("count-rx-bytes"),
    countRxPkts: document.getElementById("count-rx-pkts"),
    countTxBytes: document.getElementById("count-tx-bytes"),
    countTxPkts: document.getElementById("count-tx-pkts"),
    btnResetCounts: document.getElementById("btn-reset-counts"),
  };

  // ==================== VSYNC 120HZ/60HZ ZERO-DELAY RENDER SCHEDULER ====================
  let rafPending = false;
  let tabsRenderPending = false;
  let pendingAutoscroll = false;

  function scheduleActiveRender(scrollToBottom = false) {
    if (scrollToBottom) {
      pendingAutoscroll = true;
    }
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const sess = getActiveSession();
      if (!sess) return;
      el.rxFrameCount.textContent = `${sess.rxFrames.length} 幀`;
      updateCountersUi(sess);
      if (!sess.rxPaused) {
        renderRxView(sess, pendingAutoscroll);
        pendingAutoscroll = false;
      }
      if (tabsRenderPending) {
        tabsRenderPending = false;
        renderSessionTabs();
      }
    });
  }

  // ==================== SESSION TABS BAR ====================
  function getConnSummary(sess) {
    if (sess.connType === "tcp_client") {
      return `TCP-C :${sess.tcpClientPort || 8080}`;
    } else if (sess.connType === "tcp_server") {
      return `TCP-S :${sess.tcpServerPort || 8080}`;
    } else if (sess.connType === "udp") {
      return `UDP :${sess.udpLocalPort || "Auto"}`;
    } else if (sess.connType === "pcan") {
      return sess.pcanChannel || "PCAN_USBBUS1";
    }
    return sess.portName || "LOOPBACK";
  }

  function formatSessionTabTitle(sess) {
    if (sess.customTitle && sess.customTitle.trim()) {
      return sess.isOpen ? `${sess.customTitle} (${getConnSummary(sess)})` : sess.customTitle;
    }
    const summary = getConnSummary(sess);
    if (sess.isOpen) {
      if (sess.connType === "serial" || !sess.connType) {
        return `${sess.portName} @ ${sess.baudRate}`;
      }
      return summary;
    }
    return `分頁 #${sess.seq} (${summary})`;
  }

  function renderSessionTabs() {
    el.sessionTabsList.innerHTML = "";
    let openCount = 0;

    sessions.forEach((sess) => {
      if (sess.isOpen) openCount++;

      const tab = document.createElement("div");
      tab.className = "session-tab" + (sess.id === activeSessionId ? " active" : "");
      tab.dataset.sid = sess.id;
      tab.title = "點擊切換分頁；雙擊可改名；向下拖曳或右鍵可獨立成新視窗";

      tab.addEventListener("contextmenu", (e) => {
        if (sessions.length <= 1) return;
        e.preventDefault();
        detachSessionToWindow(sess, e.screenX, e.screenY);
      });

      tab.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".tab-close") || sessions.length <= 1) return;
        e.preventDefault();
        const pointerId = e.pointerId;
        const startY = e.clientY;
        let isDetaching = false;
        let ghostEl = null;

        try {
          tab.setPointerCapture(pointerId);
        } catch (_) {}

        const cleanup = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          try {
            if (tab.hasPointerCapture(pointerId)) tab.releasePointerCapture(pointerId);
          } catch (_) {}
          if (ghostEl) {
            ghostEl.remove();
            ghostEl = null;
          }
        };

        const onMove = (ev) => {
          const dy = ev.clientY - startY;
          if (!isDetaching && Math.abs(dy) > 22) {
            isDetaching = true;
            const sel = window.getSelection();
            if (sel) sel.removeAllRanges();
            ghostEl = document.createElement("div");
            ghostEl.className = "tab-detach-ghost";
            ghostEl.textContent = `↗ 放開以獨立視窗開啟：${formatSessionTabTitle(sess)}`;
            document.body.appendChild(ghostEl);
          }
          if (isDetaching && ghostEl) {
            ghostEl.style.left = `${ev.clientX + 12}px`;
            ghostEl.style.top = `${ev.clientY + 12}px`;
          }
        };

        const onUp = (ev) => {
          const shouldDetach = isDetaching;
          cleanup();
          if (shouldDetach) {
            detachSessionToWindow(sess, ev.screenX, ev.screenY);
          }
        };

        const onCancel = () => {
          cleanup();
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
      });

      const led = document.createElement("span");
      led.className = "tab-led" + (sess.isOpen ? " open" : "");
      tab.appendChild(led);

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = (sess.autoSendEnabled ? "[定時] " : "") + formatSessionTabTitle(sess);
      tab.appendChild(label);

      if (sess.unreadRxBytes > 0 && sess.id !== activeSessionId) {
        const badge = document.createElement("span");
        badge.className = "tab-badge";
        badge.textContent =
          sess.unreadRxBytes > 999
            ? `+${(sess.unreadRxBytes / 1024).toFixed(1)}K`
            : `+${sess.unreadRxBytes}B`;
        tab.appendChild(badge);
      }

      if (sessions.length > 1) {
        const closeBtn = document.createElement("button");
        closeBtn.className = "tab-close";
        closeBtn.dataset.closeSid = sess.id;
        closeBtn.title = "關閉此串口分頁 (Ctrl+W)";
        closeBtn.textContent = "×";
        tab.appendChild(closeBtn);
      }

      el.sessionTabsList.appendChild(tab);
    });

    el.sessionSummary.textContent = `${openCount}/${sessions.length} 連線`;
    requestAnimationFrame(() => {
      updateTabScrollButtons();
      const activeEl = el.sessionTabsList.querySelector(".session-tab.active");
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    });
  }

  function updateTabScrollButtons() {
    if (!el.sessionTabsList) return;
    const isOverflowing = el.sessionTabsList.scrollWidth > el.sessionTabsList.clientWidth + 2;
    el.btnTabsLeft.classList.toggle("hidden", !isOverflowing);
    el.btnTabsRight.classList.toggle("hidden", !isOverflowing);
  }

  function saveCurrentToolbarToSession(sess) {
    if (!sess) return;
    if (!sess.isOpen) {
      sess.connType = el.selConnType.value || sess.connType || "serial";
      sess.portName = el.selPort.value || sess.portName;
      sess.baudRate = el.inpBaud.value.trim() || sess.baudRate;
      sess.parity = el.selParity.value;
      sess.dataBits = el.selDatabits.value;
      sess.stopBits = el.selStopbits.value;
      sess.flowControl = el.selFlow.value;

      sess.tcpClientHost = el.inpTcpClientHost.value.trim() || sess.tcpClientHost || "127.0.0.1";
      sess.tcpClientPort = parseInt(el.inpTcpClientPort.value, 10) || sess.tcpClientPort || 8080;
      sess.tcpServerPort = parseInt(el.inpTcpServerPort.value, 10) || sess.tcpServerPort || 8080;
      sess.tcpServerHost = el.inpTcpServerHost.value.trim() || sess.tcpServerHost || "0.0.0.0";
      sess.udpLocalPort = parseInt(el.inpUdpLocalPort.value, 10) || 0;
      sess.udpHost = el.inpUdpHost.value.trim() || sess.udpHost || "127.0.0.1";
      sess.udpPort = parseInt(el.inpUdpPort.value, 10) || sess.udpPort || 8080;

      sess.pcanChannel = el.selPcanChannel ? el.selPcanChannel.value : (sess.pcanChannel || "PCAN_USBBUS1");
      sess.pcanBaud = el.selPcanBaud ? el.selPcanBaud.value : (sess.pcanBaud || "500000");
    }
    if (el.inpCanTxId) sess.canTxId = el.inpCanTxId.value.trim() || sess.canTxId || "7DF";
    if (el.selCanTxType) sess.canTxType = el.selCanTxType.value || sess.canTxType || "std";
    sess.autoSendInterval = Math.max(5, parseInt(el.inpAutoInterval.value, 10) || 1000);
    sess.autoSendMaxCount = Math.max(0, parseInt(el.inpAutoMaxCount.value, 10) || 0);
    sess.txCrlf = el.chkTxCrlf.checked;
  }

  function updateAutoSendUi(sess) {
    if (!sess || sess.id !== activeSessionId) return;
    el.chkAutoSend.checked = sess.autoSendEnabled;
    el.inpAutoInterval.value = sess.autoSendInterval;
    el.inpAutoMaxCount.value = sess.autoSendMaxCount;
    el.autoSendBox.classList.toggle("running", sess.autoSendEnabled);
    el.ledAutoSend.classList.toggle("on", sess.autoSendEnabled);
    const maxStr = sess.autoSendMaxCount > 0 ? String(sess.autoSendMaxCount) : '<span class="inf-sym">∞</span>';
    el.autoSendProgress.innerHTML = `${sess.autoSendCurrentCount} / ${maxStr}`;
  }

  function updateRxPauseUi(sess) {
    if (!sess || sess.id !== activeSessionId || !el.btnRxPause) return;
    el.btnRxPause.classList.toggle("paused", Boolean(sess.rxPaused));
    el.btnRxPause.textContent = sess.rxPaused ? "▶ 繼續渲染 (背景接收中)" : "⏸ 暫停畫面";
  }

  function updateFrameRuleUi(sess) {
    if (!sess || sess.id !== activeSessionId) return;
    const rule = sess.frameRule || "timeout_maxlen";
    el.chkFrameBreak.checked = sess.frameBreakEnabled;
    el.selFrameRule.value = rule;
    el.inpFrameTimeout.value = sess.frameTimeoutMs;
    el.inpFrameMaxlen.value = sess.frameMaxLen;
    el.inpFrameDelim.value = sess.frameDelimHex || "0D 0A";
    el.selFrameLayout.value = sess.frameLayout || "frame_single";

    const showTimeout = rule === "timeout_maxlen" || rule === "delimiter";
    const showDelim = rule === "delimiter";
    const showMaxlen = true;

    el.wrapFrameTimeout.style.display = showTimeout ? "inline-flex" : "none";
    el.wrapFrameDelim.style.display = showDelim ? "inline-flex" : "none";
    el.wrapFrameMaxlen.style.display = showMaxlen ? "inline-flex" : "none";
    el.lblFrameMaxlen.textContent = rule === "fixed_len" ? "固定" : "最大";
  }

  function syncSessionToDom(sess) {
    if (!sess) return;

    populatePortSelectForSession(sess);

    el.inpBaud.value = sess.baudRate;
    el.selParity.value = sess.parity;
    el.selDatabits.value = sess.dataBits;
    el.selStopbits.value = sess.stopBits;
    el.selFlow.value = sess.flowControl;

    updateAutoSendUi(sess);
    updateFrameRuleUi(sess);
    updateRxPauseUi(sess);
    el.chkTxCrlf.checked = sess.txCrlf;
    el.chkShowTimestamp.checked = sess.showTimestamp !== false;
    el.chkShowTxInline.checked = sess.showTxInline !== false;
    el.rxViewport.classList.toggle("show-ts", sess.showTimestamp !== false);
    el.rxFrameCount.textContent = `${sess.rxFrames.length} 幀`;

    el.rxModeGroup.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === sess.rxMode);
    });

    el.txTabs.forEach((t) => {
      t.classList.toggle("active", t.dataset.txtab === sess.txTab);
    });
    el.txTabEditor.classList.toggle("hidden", sess.txTab !== "editor");
    el.txTabDatalist.classList.toggle("hidden", sess.txTab !== "datalist");

    isSyncingTx = true;
    el.txHexInput.value = sess.txHexText;
    el.txAsciiInput.value = sess.txAsciiText;
    if (sess.txHasOddNibble) {
      el.txHexStatus.textContent = "提示：尚有未湊滿 2 位數的半位元組";
      el.txHexStatus.classList.add("error");
    } else {
      el.txHexStatus.textContent = `格式正常 (${sess.txBytes.length} Bytes)`;
      el.txHexStatus.classList.remove("error");
    }
    updateTxGutterAndPill(sess);
    renderTxHexGrid(sess);
    isSyncingTx = false;

    renderDataList(sess);
    updatePortUi(sess);
    updateCountersUi(sess);
    renderRxView(sess, true);

    if (sess.selectedRxIndex >= 0 && sess.selectedRxIndex < sess.viewBytes.length) {
      highlightRxByte(sess.selectedRxIndex);
    } else {
      el.rxSelectionInfo.textContent =
        "滑鼠指向或點擊任一 Byte 以檢視位址、所屬數據幀、Hex / Dec / Bin 與 ASCII 資訊";
      el.rxHexRuler.querySelectorAll(".col-active").forEach((n) => n.classList.remove("col-active"));
    }

    el.statusMsg.textContent = sess.statusText;
    el.statusMsg.title = sess.statusText;
  }

  function switchSession(targetId) {
    const prev = getActiveSession();
    if (prev && prev.id !== targetId) {
      saveCurrentToolbarToSession(prev);
    }
    const target = getSessionById(targetId);
    if (!target) return;

    activeSessionId = target.id;
    target.unreadRxBytes = 0;
    renderSessionTabs();
    syncSessionToDom(target);
  }

  function addNewSession() {
    const current = getActiveSession();
    if (current) {
      saveCurrentToolbarToSession(current);
    }

    const openedPorts = new Set(sessions.filter((s) => s.isOpen).map((s) => s.portName));
    const freeHardwarePort = availablePortsCache.find((p) => !openedPorts.has(p.name));
    const defaultPort = freeHardwarePort ? freeHardwarePort.name : "LOOPBACK";

    const newSess = createSessionObject(defaultPort);
    sessions.push(newSess);
    activeSessionId = newSess.id;
    renderSessionTabs();
    syncSessionToDom(newSess);
  }

  async function closeSessionTab(sessionId) {
    if (sessions.length <= 1) return;
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return;

    const sess = sessions[idx];
    stopAutoSendForSession(sess);

    if (sess.isOpen) {
      const invoke = getTauriInvoke();
      if (invoke) {
        try {
          await invoke("close_serial_port", { sessionId: sess.id });
        } catch (err) {
          console.error(err);
        }
      }
      sess.isOpen = false;
    }

    sessions.splice(idx, 1);
    if (activeSessionId === sessionId) {
      const nextSess = sessions[Math.max(0, idx - 1)] || sessions[0];
      activeSessionId = nextSess.id;
      nextSess.unreadRxBytes = 0;
      syncSessionToDom(nextSess);
    }
    renderSessionTabs();
  }

  el.sessionTabsList.addEventListener("click", (e) => {
    const closeBtn = e.target.closest("[data-close-sid]");
    if (closeBtn) {
      e.stopPropagation();
      closeSessionTab(closeBtn.dataset.closeSid);
      return;
    }
    const tab = e.target.closest(".session-tab");
    if (tab && tab.dataset.sid) {
      switchSession(tab.dataset.sid);
    }
  });

  el.sessionTabsList.addEventListener("dblclick", (e) => {
    const tab = e.target.closest(".session-tab");
    if (!tab || !tab.dataset.sid) return;
    const sess = getSessionById(tab.dataset.sid);
    if (!sess) return;
    const name = prompt("請輸入此串口分頁的自訂名稱（留空則恢復預設顯示）：", sess.customTitle || "");
    if (name !== null) {
      sess.customTitle = name.trim();
      renderSessionTabs();
    }
  });

  el.btnNewSession.addEventListener("click", addNewSession);

  el.btnTabsLeft.addEventListener("click", () => {
    el.sessionTabsList.scrollBy({ left: -160, behavior: "smooth" });
  });
  el.btnTabsRight.addEventListener("click", () => {
    el.sessionTabsList.scrollBy({ left: 160, behavior: "smooth" });
  });
  el.sessionTabsList.addEventListener("wheel", (e) => {
    if (e.deltaY !== 0) {
      e.preventDefault();
      el.sessionTabsList.scrollLeft += e.deltaY;
    }
  });
  window.addEventListener("resize", () => {
    updateTabScrollButtons();
    scheduleActiveRender(false);
  });

  function handleTitlebarMouseDown(e) {
    if (e.button !== 0) return;
    const invoke = getTauriInvoke();
    if (!invoke) return;
    if (e.detail === 2) {
      invoke("win_toggle_maximize").catch(() => {});
    } else {
      invoke("win_start_drag").catch(() => {});
    }
  }

  el.titlebarDragSpacer.addEventListener("mousedown", handleTitlebarMouseDown);
  el.appLogoDrag.addEventListener("mousedown", handleTitlebarMouseDown);
  el.titlebarTabsArea.addEventListener("mousedown", (e) => {
    if (e.target === el.titlebarTabsArea) {
      handleTitlebarMouseDown(e);
    }
  });

  el.btnWinMin.addEventListener("click", () => {
    const invoke = getTauriInvoke();
    if (invoke) invoke("win_minimize").catch(() => {});
  });
  el.btnWinMax.addEventListener("click", () => {
    const invoke = getTauriInvoke();
    if (invoke) invoke("win_toggle_maximize").catch(() => {});
  });
  el.btnWinClose.addEventListener("click", () => {
    const invoke = getTauriInvoke();
    if (invoke) invoke("win_close").catch(() => {});
  });

  // ==================== PORT MANAGEMENT ====================
  async function refreshPorts() {
    const invoke = getTauriInvoke();
    let ports = [];
    if (invoke) {
      try {
        ports = await invoke("list_serial_ports");
      } catch (err) {
        console.error("Failed to list ports:", err);
      }
    }
    availablePortsCache = ports;
    const sess = getActiveSession();
    if (sess) {
      populatePortSelectForSession(sess);
    }
  }

  function populatePortSelectForSession(sess) {
    el.selPort.innerHTML = "";
    availablePortsCache.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.label || p.name;
      el.selPort.appendChild(opt);
    });

    const loopOpt = document.createElement("option");
    loopOpt.value = "LOOPBACK";
    loopOpt.textContent = "LOOPBACK (內建迴路測試串口)";
    el.selPort.appendChild(loopOpt);

    if (sess.portName && Array.from(el.selPort.options).some((o) => o.value === sess.portName)) {
      el.selPort.value = sess.portName;
    } else if (availablePortsCache.length > 0) {
      el.selPort.value = availablePortsCache[0].name;
      sess.portName = el.selPort.value;
    } else {
      el.selPort.value = "LOOPBACK";
      sess.portName = "LOOPBACK";
    }
  }

  async function togglePortForActiveSession() {
    const sess = getActiveSession();
    if (!sess) return;
    const invoke = getTauriInvoke();

    if (!sess.isOpen) {
      if (sess.connType === "tcp_client") {
        sess.tcpClientHost = el.inpTcpClientHost.value.trim() || "127.0.0.1";
        sess.tcpClientPort = parseInt(el.inpTcpClientPort.value, 10) || 8080;
        try {
          if (invoke) {
            const res = await invoke("open_network_socket", {
              sessionId: sess.id,
              config: {
                connType: "tcp_client",
                remoteHost: sess.tcpClientHost,
                remotePort: sess.tcpClientPort,
              },
            });
            setSessionStatus(sess, res || `TCP Client 連線成功至 ${sess.tcpClientHost}:${sess.tcpClientPort}`);
          }
          sess.isOpen = true;
          sess.dtr = true;
          sess.rts = true;
          updatePortUi(sess);
          renderSessionTabs();
        } catch (err) {
          setSessionStatus(sess, `TCP 連線失敗: ${err}`);
          alert(`無法連線至 TCP 伺服器 ${sess.tcpClientHost}:${sess.tcpClientPort}：\n${err}`);
        }
        return;
      }

      if (sess.connType === "tcp_server") {
        sess.tcpServerPort = parseInt(el.inpTcpServerPort.value, 10) || 8080;
        sess.tcpServerHost = el.inpTcpServerHost.value.trim() || "0.0.0.0";
        sess.tcpServerClients = 0;
        try {
          if (invoke) {
            const res = await invoke("open_network_socket", {
              sessionId: sess.id,
              config: {
                connType: "tcp_server",
                localHost: sess.tcpServerHost,
                localPort: sess.tcpServerPort,
              },
            });
            setSessionStatus(sess, res || `TCP Server 啟動成功，監聽於 ${sess.tcpServerHost}:${sess.tcpServerPort}`);
          }
          sess.isOpen = true;
          sess.dtr = true;
          sess.rts = true;
          updatePortUi(sess);
          renderSessionTabs();
        } catch (err) {
          setSessionStatus(sess, `TCP 伺服器啟動失敗: ${err}`);
          alert(`無法啟動 TCP 伺服器 (${sess.tcpServerHost}:${sess.tcpServerPort})：\n${err}`);
        }
        return;
      }

      if (sess.connType === "udp") {
        sess.udpLocalPort = parseInt(el.inpUdpLocalPort.value, 10) || 0;
        sess.udpHost = el.inpUdpHost.value.trim() || "127.0.0.1";
        sess.udpPort = parseInt(el.inpUdpPort.value, 10) || 8080;
        try {
          if (invoke) {
            const res = await invoke("open_network_socket", {
              sessionId: sess.id,
              config: {
                connType: "udp",
                localPort: sess.udpLocalPort,
                remoteHost: sess.udpHost,
                remotePort: sess.udpPort,
              },
            });
            setSessionStatus(sess, res || `UDP 已開啟 (本地:${sess.udpLocalPort || "Auto"} -> 目標:${sess.udpHost}:${sess.udpPort})`);
          }
          sess.isOpen = true;
          sess.dtr = true;
          sess.rts = true;
          updatePortUi(sess);
          renderSessionTabs();
        } catch (err) {
          setSessionStatus(sess, `開啟 UDP 失敗: ${err}`);
          alert(`無法開啟 UDP：\n${err}`);
        }
        return;
      }

      if (sess.connType === "pcan") {
        sess.pcanChannel = el.selPcanChannel.value || "PCAN_USBBUS1";
        sess.pcanBaud = el.selPcanBaud.value || "500000";
        const baudNum = parseInt(sess.pcanBaud, 10) || 500000;
        try {
          if (invoke) {
            const res = await invoke("open_pcan_channel", {
              sessionId: sess.id,
              config: {
                channel: sess.pcanChannel,
                baudRate: baudNum,
              },
            });
            setSessionStatus(sess, `PCAN 已開啟 (${res})`);
          }
          sess.isOpen = true;
          updatePortUi(sess);
          renderSessionTabs();
        } catch (err) {
          setSessionStatus(sess, `開啟 PCAN 失敗: ${err}`);
        }
        return;
      }

      // Default: Serial COM Port
      const baudRate = parseInt(el.inpBaud.value, 10);
      if (isNaN(baudRate) || baudRate <= 0 || baudRate > 20000000) {
        alert("請輸入有效的自訂波特率 (例如: 9600、115200、250000、1000000)");
        el.inpBaud.focus();
        return;
      }

      sess.portName = el.selPort.value;
      sess.baudRate = String(baudRate);
      sess.parity = el.selParity.value;
      sess.dataBits = el.selDatabits.value;
      sess.stopBits = el.selStopbits.value;
      sess.flowControl = el.selFlow.value;

      const config = {
        portName: sess.portName,
        baudRate,
        parity: sess.parity,
        dataBits: parseInt(sess.dataBits, 10),
        stopBits: parseInt(sess.stopBits, 10),
        flowControl: sess.flowControl,
      };

      try {
        if (invoke) {
          await invoke("open_serial_port", { sessionId: sess.id, config });
        }
        sess.isOpen = true;
        sess.dtr = true;
        sess.rts = true;
        updatePortUi(sess);
        renderSessionTabs();
        setSessionStatus(
          sess,
          `[${formatSessionTabTitle(sess)}] 已開啟 (${config.baudRate} bps, ${config.parity[0]}, ${config.dataBits}, ${config.stopBits})`
        );
      } catch (err) {
        setSessionStatus(sess, `開啟串口失敗: ${err}`);
        alert(`無法開啟串口 ${config.portName}：\n${err}`);
      }
    } else {
      stopAutoSendForSession(sess);
      try {
        if (invoke) {
          await invoke("close_serial_port", { sessionId: sess.id });
        }
      } catch (err) {
        console.error(err);
      }
      sess.isOpen = false;
      sess.cts = false;
      sess.dsr = false;
      sess.cd = false;
      sess.ri = false;
      updatePortUi(sess);
      renderSessionTabs();
      setSessionStatus(sess, `[${formatSessionTabTitle(sess)}] 通訊已關閉`);
    }
  }

  function updatePortUi(sess) {
    if (!sess || sess.id !== activeSessionId) return;
    el.btnPortToggle.classList.toggle("open", sess.isOpen);
    el.portLed.classList.toggle("on", sess.isOpen);

    if (sess.connType === "tcp_client") {
      el.portToggleLabel.textContent = sess.isOpen ? "中斷連線" : "連線伺服器";
    } else if (sess.connType === "tcp_server") {
      el.portToggleLabel.textContent = sess.isOpen ? "停止監聽" : "啟動監聽";
    } else if (sess.connType === "udp") {
      el.portToggleLabel.textContent = sess.isOpen ? "關閉 UDP" : "開啟 UDP";
    } else if (sess.connType === "pcan") {
      el.portToggleLabel.textContent = sess.isOpen ? "關閉 PCAN" : "開啟 PCAN";
    } else {
      el.portToggleLabel.textContent = sess.isOpen ? "關閉串口" : "開啟串口";
    }

    el.statusDot.classList.toggle("open", sess.isOpen);

    el.selConnType.value = sess.connType || "serial";
    el.selConnType.disabled = sess.isOpen;

    const isPcan = sess.connType === "pcan";
    const isNet = !isPcan && sess.connType !== "serial" && Boolean(sess.connType);
    el.paramsSerial.classList.toggle("hidden", isNet || isPcan);
    el.paramsNet.classList.toggle("hidden", !isNet);
    if (el.paramsPcan) el.paramsPcan.classList.toggle("hidden", !isPcan);
    if (el.txCanBar) el.txCanBar.classList.toggle("hidden", !isPcan);

    if (isPcan) {
      if (el.selPcanChannel) {
        el.selPcanChannel.value = sess.pcanChannel || "PCAN_USBBUS1";
        el.selPcanChannel.disabled = sess.isOpen;
      }
      if (el.selPcanBaud) {
        el.selPcanBaud.value = sess.pcanBaud || "500000";
        el.selPcanBaud.disabled = sess.isOpen;
      }
      if (el.btnRefreshPcan) el.btnRefreshPcan.disabled = sess.isOpen;
    }
    if (el.inpCanTxId) el.inpCanTxId.value = sess.canTxId || "7DF";
    if (el.selCanTxType) el.selCanTxType.value = sess.canTxType || "std";

    if (isNet) {
      el.netFieldsTcpClient.classList.toggle("hidden", sess.connType !== "tcp_client");
      el.netFieldsTcpServer.classList.toggle("hidden", sess.connType !== "tcp_server");
      el.netFieldsUdp.classList.toggle("hidden", sess.connType !== "udp");

      el.inpTcpClientHost.value = sess.tcpClientHost || "127.0.0.1";
      el.inpTcpClientPort.value = sess.tcpClientPort || "8080";
      el.inpTcpClientHost.disabled = sess.isOpen;
      el.inpTcpClientPort.disabled = sess.isOpen;

      el.inpTcpServerPort.value = sess.tcpServerPort || "8080";
      el.inpTcpServerHost.value = sess.tcpServerHost || "0.0.0.0";
      el.inpTcpServerPort.disabled = sess.isOpen;
      el.inpTcpServerHost.disabled = sess.isOpen;
      el.netServerClientsPill.textContent = `${sess.tcpServerClients || 0} 客戶端`;

      el.inpUdpLocalPort.value = sess.udpLocalPort || "8081";
      el.inpUdpHost.value = sess.udpHost || "127.0.0.1";
      el.inpUdpPort.value = sess.udpPort || "8080";
      el.inpUdpLocalPort.disabled = sess.isOpen;
    } else {
      el.selPort.disabled = sess.isOpen;
      el.inpBaud.disabled = sess.isOpen;
      el.btnBaudDropdown.disabled = sess.isOpen;
      if (sess.isOpen) {
        el.baudMenu.classList.add("hidden");
      }
      el.selParity.disabled = sess.isOpen;
      el.selDatabits.disabled = sess.isOpen;
      el.selStopbits.disabled = sess.isOpen;
      el.selFlow.disabled = sess.isOpen;
      el.btnRefreshPorts.disabled = sess.isOpen;
    }

    updateModemLeds(sess);
  }

  function updateModemLeds(sess) {
    if (!sess || sess.id !== activeSessionId) return;
    el.ledDtr.classList.toggle("on", sess.isOpen && sess.dtr);
    el.ledRts.classList.toggle("on", sess.isOpen && sess.rts);
    el.ledCts.classList.toggle("on", sess.isOpen && sess.cts);
    el.ledDsr.classList.toggle("on", sess.isOpen && sess.dsr);
    el.ledCd.classList.toggle("on", sess.isOpen && sess.cd);
    el.ledRi.classList.toggle("on", sess.isOpen && sess.ri);
  }

  function setSessionStatus(sess, msg) {
    if (!sess) return;
    sess.statusText = msg;
    if (sess.id === activeSessionId) {
      el.statusMsg.textContent = msg;
      el.statusMsg.title = msg;
    }
  }

  // ==================== INCREMENTAL O(1) FRAME & ROW ENGINE ====================
  function rebuildRowSlicesForSession(sess) {
    const bytes = sess.viewBytes;
    const layout = sess.frameLayout || "frame_single";
    const rowSlices = [];
    let maxCols = layout === "continuous_32" ? 32 : 16;

    if (bytes.length > 0) {
      if (sess.frameBreakEnabled && layout === "frame_single" && sess.rxFrames.length > 0) {
        sess.rxFrames.forEach((frame, fIndex) => {
          for (
            let offsetInFrame = 0;
            offsetInFrame < frame.length;
            offsetInFrame += MAX_SINGLE_ROW_COLS
          ) {
            const rStart = frame.startIdx + offsetInFrame;
            const rEnd = Math.min(rStart + MAX_SINGLE_ROW_COLS, frame.startIdx + frame.length);
            const rowLen = rEnd - rStart;
            if (rowLen > maxCols) maxCols = rowLen;
            rowSlices.push({
              rowStart: rStart,
              rowEnd: rEnd,
              isNewFrameRow: offsetInFrame === 0 && fIndex > 0,
              frameObj: frame,
            });
          }
        });
      } else if (sess.frameBreakEnabled && layout === "frame_wrap16" && sess.rxFrames.length > 0) {
        maxCols = 16;
        sess.rxFrames.forEach((frame, fIndex) => {
          for (let offsetInFrame = 0; offsetInFrame < frame.length; offsetInFrame += 16) {
            const rStart = frame.startIdx + offsetInFrame;
            const rEnd = Math.min(rStart + 16, frame.startIdx + frame.length);
            rowSlices.push({
              rowStart: rStart,
              rowEnd: rEnd,
              isNewFrameRow: offsetInFrame === 0 && fIndex > 0,
              frameObj: frame,
            });
          }
        });
      } else {
        const stride = layout === "continuous_32" ? 32 : 16;
        maxCols = stride;
        for (let rStart = 0; rStart < bytes.length; rStart += stride) {
          const fid = sess.rxByteFrameIds[rStart] ?? 0;
          rowSlices.push({
            rowStart: rStart,
            rowEnd: Math.min(rStart + stride, bytes.length),
            isNewFrameRow: false,
            frameObj: sess.rxFrames[fid] || null,
          });
        }
      }
    }

    sess.rowSlices = rowSlices;
    sess.maxCols = maxCols;
  }

  // O(1) incremental update of rowSlices when bytes are appended to `frame`
  // Mutates incomplete tail rowSlice in place so its live DOM node can append new bytes 1-by-1!
  function incrementalUpdateRowsForFrame(sess, frame, prevFrameLength) {
    const layout = sess.frameLayout || "frame_single";

    if (sess.frameBreakEnabled && (layout === "frame_single" || layout === "frame_wrap16")) {
      const wrapWidth = layout === "frame_single" ? MAX_SINGLE_ROW_COLS : 16;
      let startOffset = 0;
      if (prevFrameLength > 0) {
        const rem = prevFrameLength % wrapWidth;
        if (rem !== 0) {
          const tailOffset = prevFrameLength - rem;
          const tailStart = frame.startIdx + tailOffset;
          const lastSlice =
            sess.rowSlices.length > 0 ? sess.rowSlices[sess.rowSlices.length - 1] : null;
          if (lastSlice && lastSlice.rowStart === tailStart) {
            const newEnd = Math.min(tailStart + wrapWidth, frame.startIdx + frame.length);
            lastSlice.rowEnd = newEnd;
            const rowLen = newEnd - tailStart;
            if (layout === "frame_single" && rowLen > sess.maxCols) {
              sess.maxCols = rowLen;
            }
            startOffset = tailOffset + wrapWidth;
          } else {
            if (lastSlice) sess.rowSlices.pop();
            startOffset = tailOffset;
          }
        } else {
          startOffset = prevFrameLength;
        }
      }
      for (
        let offsetInFrame = startOffset;
        offsetInFrame < frame.length;
        offsetInFrame += wrapWidth
      ) {
        const rStart = frame.startIdx + offsetInFrame;
        const rEnd = Math.min(rStart + wrapWidth, frame.startIdx + frame.length);
        const rowLen = rEnd - rStart;
        if (layout === "frame_single" && rowLen > sess.maxCols) {
          sess.maxCols = rowLen;
        }
        sess.rowSlices.push({
          rowStart: rStart,
          rowEnd: rEnd,
          isNewFrameRow: offsetInFrame === 0 && frame.id > 0,
          frameObj: frame,
        });
      }
    } else {
      // Continuous 16B or 32B mode: update incomplete tail slice in place, then push any new rows
      const stride = layout === "continuous_32" ? 32 : 16;
      sess.maxCols = stride;
      const totalBytes = sess.viewBytes.length;
      if (sess.rowSlices.length > 0) {
        const lastSlice = sess.rowSlices[sess.rowSlices.length - 1];
        if (lastSlice.rowEnd - lastSlice.rowStart < stride) {
          lastSlice.rowEnd = Math.min(lastSlice.rowStart + stride, totalBytes);
        }
      }
      const nextStart =
        sess.rowSlices.length > 0 ? sess.rowSlices[sess.rowSlices.length - 1].rowEnd : 0;
      for (let rStart = nextStart; rStart < totalBytes; rStart += stride) {
        const fid = sess.rxByteFrameIds[rStart] ?? 0;
        sess.rowSlices.push({
          rowStart: rStart,
          rowEnd: Math.min(rStart + stride, totalBytes),
          isNewFrameRow: false,
          frameObj: sess.rxFrames[fid] || null,
        });
      }
    }
  }

  // O(chunk.length) incremental chunk append — supports Timeout + MaxLen + Hex Delimiter + FixedLen!
  function appendChunkIncremental(sess, chunk) {
    const len = chunk.bytes.length;
    if (len === 0) return;
    const dir = chunk.dir || "RX";

    // Handle TX chunks
    if (dir === "TX") {
      sess.packets.push({
        time: chunk.timeStr,
        dir: "TX",
        previewBytes: chunk.bytes.length > 256 ? chunk.bytes.slice(0, 256) : chunk.bytes.slice(),
        byteLength: len,
        lastPerfMs: chunk.perfMs,
        closed: true,
      });

      if (!sess.fixedMap) sess.fixedMap = new Map();
      if (sess.connType !== "pcan") {
        const fixedKey = `${dir}_0`;
        let item = sess.fixedMap.get(fixedKey);
        const nowPerf = chunk.perfMs || performance.now();
        if (!item) {
          sess.fixedMap.set(fixedKey, {
            key: fixedKey,
            idStr: `[${dir}]`,
            rawId: 1,
            extended: false,
            rtr: false,
            typeStr: (sess.connType || "COM").toUpperCase(),
            dlc: len,
            data: chunk.bytes.slice(0, 32),
            prevData: [],
            count: 1,
            lastPerfMs: nowPerf,
            cycleMs: 0,
            timeStr: chunk.timeStr,
          });
        } else {
          item.count += 1;
          item.cycleMs = Math.max(0, nowPerf - item.lastPerfMs);
          item.lastPerfMs = nowPerf;
          item.timeStr = chunk.timeStr;
          item.dlc = len;
          item.prevData = item.data;
          item.data = chunk.bytes.slice(0, 32);
        }
      }
      if (!sess.showTxInline) return;

      const startByteCursor = sess.viewBytes.length;
      for (let i = 0; i < len; i++) {
        sess.viewBytes.push(chunk.bytes[i]);
      }
      const fid = sess.rxFrames.length;
      const txFrame = {
        id: fid,
        dir: "TX",
        startIdx: startByteCursor,
        length: len,
        prevRenderedLen: len,
        closed: true,
        timeStr: chunk.timeStr,
        lastPerfMs: chunk.perfMs,
      };
      sess.rxFrames.push(txFrame);
      for (let i = 0; i < len; i++) {
        sess.rxByteFrameIds.push(fid);
      }
      incrementalUpdateRowsForFrame(sess, txFrame, 0);
      return;
    }

    // Handle RX chunks
    if (!sess.fixedMap) sess.fixedMap = new Map();
    if (sess.connType !== "pcan") {
      const fixedKey = "RX_0";
      let item = sess.fixedMap.get(fixedKey);
      const nowPerf = chunk.perfMs || performance.now();
      if (!item) {
        sess.fixedMap.set(fixedKey, {
          key: fixedKey,
          idStr: "[RX]",
          rawId: 0,
          extended: false,
          rtr: false,
          typeStr: (sess.connType || "COM").toUpperCase(),
          dlc: len,
          data: chunk.bytes.slice(0, 32),
          prevData: [],
          count: 1,
          lastPerfMs: nowPerf,
          cycleMs: 0,
          timeStr: chunk.timeStr,
        });
      } else {
        item.count += 1;
        item.cycleMs = Math.max(0, nowPerf - item.lastPerfMs);
        item.lastPerfMs = nowPerf;
        item.timeStr = chunk.timeStr;
        item.dlc = len;
        item.prevData = item.data;
        item.data = chunk.bytes.slice(0, 32);
      }
    }
    const rule = sess.frameRule || "timeout_maxlen";
    const useTimeout =
      sess.frameBreakEnabled &&
      (rule === "timeout_maxlen" || rule === "delimiter") &&
      sess.frameTimeoutMs > 0;
    const timeoutMs = Math.max(1, sess.frameTimeoutMs || 20);
    const maxLen = !sess.frameBreakEnabled
      ? 0
      : rule === "fixed_len"
      ? Math.max(1, sess.frameMaxLen || 16)
      : Math.max(0, sess.frameMaxLen || 0);
    const delimBytes =
      sess.frameBreakEnabled && rule === "delimiter"
        ? parseHexInput(sess.frameDelimHex || "").bytes
        : [];
    const delimLen = delimBytes.length;

    // 1. Check if the currently open RX frame timed out before this chunk arrived
    const tailFrame = sess.rxFrames.length > 0 ? sess.rxFrames[sess.rxFrames.length - 1] : null;
    if (
      tailFrame &&
      tailFrame.dir === "RX" &&
      !tailFrame.closed &&
      useTimeout &&
      chunk.perfMs - tailFrame.lastPerfMs > timeoutMs
    ) {
      tailFrame.closed = true;
      const tailPkt = sess.packets.length > 0 ? sess.packets[sess.packets.length - 1] : null;
      if (tailPkt && tailPkt.dir === "RX") tailPkt.closed = true;
    }

    // Helper to compute exact per-frame timestamp when a frame starts at `byteIdxInChunk`
    const baud = Math.max(300, parseInt(sess.baudRate, 10) || 115200);
    const msPerByte = 10000 / baud;
    const getFrameTimeAtOffset = (byteIdxInChunk) => {
      if (byteIdxInChunk <= 0 || typeof chunk.wallMs !== "number") {
        return chunk.timeStr;
      }
      return formatDateToTimeStr(new Date(Math.round(chunk.wallMs + byteIdxInChunk * msPerByte)));
    };

    // 2. Fast block path when no Hex delimiter is active (handles pure timeout, disabled, AND maxLen / fixed_len!)
    if (delimLen === 0) {
      let offset = 0;
      while (offset < len) {
        let curFrame = sess.rxFrames.length > 0 ? sess.rxFrames[sess.rxFrames.length - 1] : null;
        let curPkt = sess.packets.length > 0 ? sess.packets[sess.packets.length - 1] : null;

        if (!curFrame || curFrame.closed || curFrame.dir !== "RX") {
          const fid = sess.rxFrames.length;
          const fTimeStr = getFrameTimeAtOffset(offset);
          curFrame = {
            id: fid,
            dir: "RX",
            startIdx: sess.viewBytes.length,
            length: 0,
            prevRenderedLen: 0,
            closed: false,
            timeStr: fTimeStr,
            lastPerfMs: chunk.perfMs + offset * msPerByte,
          };
          sess.rxFrames.push(curFrame);

          curPkt = {
            time: fTimeStr,
            dir: "RX",
            previewBytes: [],
            byteLength: 0,
            lastPerfMs: chunk.perfMs + offset * msPerByte,
            closed: false,
          };
          sess.packets.push(curPkt);
          sess.rxPktCount += 1;
        }

        const prevLen = curFrame.length;
        const remainingInChunk = len - offset;
        const take =
          maxLen > 0
            ? Math.min(remainingInChunk, Math.max(1, maxLen - curFrame.length))
            : remainingInChunk;
        const endOffset = offset + take;
        const fid = curFrame.id;

        for (let i = offset; i < endOffset; i++) {
          const b = chunk.bytes[i];
          sess.viewBytes.push(b);
          sess.rxByteFrameIds.push(fid);
        }

        if (curPkt) {
          for (let i = offset; i < endOffset && curPkt.previewBytes.length < 256; i++) {
            curPkt.previewBytes.push(chunk.bytes[i]);
          }
          curPkt.byteLength += take;
          curPkt.lastPerfMs = chunk.perfMs + endOffset * msPerByte;
        }

        curFrame.length += take;
        curFrame.prevRenderedLen = curFrame.length;
        curFrame.lastPerfMs = chunk.perfMs + endOffset * msPerByte;

        if (maxLen > 0 && curFrame.length >= maxLen) {
          curFrame.closed = true;
          if (curPkt) curPkt.closed = true;
        }

        incrementalUpdateRowsForFrame(sess, curFrame, prevLen);
        offset = endOffset;
      }
      return;
    }

    // 3. Byte-exact segmentation when Hex Delimiter is active (+ optional MaxLen & Timeout)
    const touchedFrames = [];
    for (let i = 0; i < len; i++) {
      const b = chunk.bytes[i];
      let curFrame = sess.rxFrames.length > 0 ? sess.rxFrames[sess.rxFrames.length - 1] : null;
      let curPkt = sess.packets.length > 0 ? sess.packets[sess.packets.length - 1] : null;

      if (!curFrame || curFrame.closed || curFrame.dir !== "RX") {
        const fid = sess.rxFrames.length;
        const fTimeStr = getFrameTimeAtOffset(i);
        curFrame = {
          id: fid,
          dir: "RX",
          startIdx: sess.viewBytes.length,
          length: 0,
          prevRenderedLen: 0,
          closed: false,
          timeStr: fTimeStr,
          lastPerfMs: chunk.perfMs + i * msPerByte,
        };
        sess.rxFrames.push(curFrame);

        curPkt = {
          time: fTimeStr,
          dir: "RX",
          previewBytes: [],
          byteLength: 0,
          lastPerfMs: chunk.perfMs + i * msPerByte,
          closed: false,
        };
        sess.packets.push(curPkt);
        sess.rxPktCount += 1;
      }

      if (touchedFrames[touchedFrames.length - 1] !== curFrame) {
        touchedFrames.push(curFrame);
      }

      sess.viewBytes.push(b);
      sess.rxByteFrameIds.push(curFrame.id);
      curFrame.length += 1;
      curFrame.lastPerfMs = chunk.perfMs;
      if (curPkt) {
        if (curPkt.previewBytes.length < 256) {
          curPkt.previewBytes.push(b);
        }
        curPkt.byteLength += 1;
        curPkt.lastPerfMs = chunk.perfMs;
      }

      // Check Max Frame Length condition
      if (maxLen > 0 && curFrame.length >= maxLen) {
        curFrame.closed = true;
        if (curPkt) curPkt.closed = true;
      } else if (delimLen > 0 && curFrame.length >= delimLen) {
        // Check Hex Delimiter suffix match
        let matched = true;
        const baseIdx = sess.viewBytes.length - delimLen;
        for (let k = 0; k < delimLen; k++) {
          if (sess.viewBytes[baseIdx + k] !== delimBytes[k]) {
            matched = false;
            break;
          }
        }
        if (matched) {
          curFrame.closed = true;
          if (curPkt) curPkt.closed = true;
        }
      }
    }

    for (let f = 0; f < touchedFrames.length; f++) {
      const frame = touchedFrames[f];
      incrementalUpdateRowsForFrame(sess, frame, frame.prevRenderedLen || 0);
      frame.prevRenderedLen = frame.length;
    }
  }

  // Full recalculation ONLY when user changes settings (timeout / layout / TX toggle)
  function recalculateFramesForSession(sess) {
    if (!sess) return;
    sess.viewBytes = [];
    sess.rxByteFrameIds = [];
    sess.rxFrames = [];
    sess.rowSlices = [];
    sess.packets = [];
    sess.rxPktCount = 0;
    sess.maxCols = sess.frameLayout === "continuous_32" ? 32 : 16;

    for (let i = 0; i < sess.rxRawChunks.length; i++) {
      appendChunkIncremental(sess, sess.rxRawChunks[i]);
    }
    rebuildRowSlicesForSession(sess);

    if (sess.id === activeSessionId) {
      el.rxFrameCount.textContent = `${sess.rxFrames.length} 幀`;
      updateCountersUi(sess);
    }
  }

  function onReceiveBatchForSession(sessionId, batchNowMs, chunks) {
    const sess = getSessionById(sessionId);
    if (!sess || !chunks || chunks.length === 0) return;

    const wallNowMs = Date.now();
    let batchTotalBytes = 0;

    for (let c = 0; c < chunks.length; c++) {
      const raw = chunks[c];
      const data = raw.data;
      if (!data || data.length === 0) continue;

      const deltaMs = Math.max(0, (batchNowMs || raw.perfMs) - raw.perfMs);
      const wallMs = wallNowMs - deltaMs;
      const timeStr = formatDateToTimeStr(new Date(Math.round(wallMs)));
      const cleanBytes = new Array(data.length);

      for (let i = 0; i < data.length; i++) {
        const b = data[i] & 0xff;
        cleanBytes[i] = b;
        sess.rxBytes.push(b);
      }
      batchTotalBytes += data.length;

      const chunkObj = {
        perfMs: raw.perfMs,
        wallMs,
        timeStr,
        dir: "RX",
        bytes: cleanBytes,
      };
      sess.rxRawChunks.push(chunkObj);
      appendChunkIncremental(sess, chunkObj);
    }

    if (batchTotalBytes === 0) return;

    if (sess.id === activeSessionId) {
      scheduleActiveRender(true);
    } else {
      sess.unreadRxBytes += batchTotalBytes;
      tabsRenderPending = true;
      scheduleActiveRender(false);
    }
  }

  // ==================== VIRTUALIZED VIEWPORT RENDERING ====================
  let vTopSpacer = null;
  let vRowsHost = null;
  let vBottomSpacer = null;
  let activeHighlightedEls = [];

  function ensureVirtualHostStructure() {
    if (
      vTopSpacer &&
      vRowsHost &&
      vBottomSpacer &&
      el.rxHexGrid.firstElementChild === vTopSpacer
    ) {
      return;
    }
    el.rxHexGrid.innerHTML = "";
    vTopSpacer = document.createElement("div");
    vTopSpacer.className = "v-spacer-top";
    vRowsHost = document.createElement("div");
    vRowsHost.className = "v-rows-host";
    vBottomSpacer = document.createElement("div");
    vBottomSpacer.className = "v-spacer-bottom";
    el.rxHexGrid.appendChild(vTopSpacer);
    el.rxHexGrid.appendChild(vRowsHost);
    el.rxHexGrid.appendChild(vBottomSpacer);
  }

  function renderRxView(sess, scrollToBottom = false) {
    if (!sess || sess.id !== activeSessionId) return;
    const mode = sess.rxMode;
    el.rxViewport.classList.toggle("show-ts", sess.showTimestamp !== false);
    el.rxHexRuler.classList.toggle("hidden", mode === "text" || mode === "packets" || mode === "fixed");
    const rulerAscii = document.getElementById("ruler-ascii-cols");
    if (rulerAscii) {
      rulerAscii.classList.toggle("hidden", mode === "hex" || mode === "fixed");
    }
    el.rxHexGrid.classList.toggle("hidden", mode === "text" || mode === "packets" || mode === "fixed");
    el.rxTextView.classList.toggle("hidden", mode !== "text");
    el.rxPacketView.classList.toggle("hidden", mode !== "packets");
    if (el.rxFixedView) {
      el.rxFixedView.classList.toggle("hidden", mode !== "fixed");
    }

    if (mode === "dual" || mode === "hex") {
      renderVirtualizedHexGrid(sess, mode === "dual", scrollToBottom);
    } else if (mode === "text") {
      renderTextViewWindowed(sess, scrollToBottom);
    } else if (mode === "packets") {
      renderPacketTimelineWindowed(sess, scrollToBottom);
    } else if (mode === "fixed") {
      renderFixedTable(sess);
    }
  }

  function updateRulerForColumns(cols, showAscii) {
    const safeCols = Math.max(16, Math.min(MAX_SINGLE_ROW_COLS, cols));
    const rulerHex = document.getElementById("ruler-hex-cols");
    const rulerAscii = document.getElementById("ruler-ascii-cols");
    if (!rulerHex || !rulerAscii) return;

    const rulerStateKey = `${safeCols}_${showAscii ? 1 : 0}_${currentHbWidth}_${currentAbWidth}`;
    if (rulerHex.dataset.rulerState === rulerStateKey) {
      return;
    }
    rulerHex.dataset.rulerState = rulerStateKey;

    const gapCount = Math.floor((safeCols - 1) / 8);
    const hexColWidth = safeCols * currentHbWidth + gapCount * 10 + 4;
    const asciiColWidth = showAscii ? safeCols * currentAbWidth + 16 : 0;

    el.rxViewport.style.setProperty("--hex-col-width", `${hexColWidth}px`);
    el.rxViewport.style.setProperty("--ascii-col-width", `${asciiColWidth}px`);
    rulerAscii.classList.toggle("hidden", !showAscii);

    if (Number(rulerHex.dataset.renderedCols) === safeCols) {
      return;
    }
    rulerHex.dataset.renderedCols = String(safeCols);

    const hexFrag = document.createDocumentFragment();
    const asciiFrag = document.createDocumentFragment();

    for (let c = 0; c < safeCols; c++) {
      const hasGap = c % 8 === 7 && c < safeCols - 1;
      const hb = document.createElement("span");
      hb.className = "hb" + (hasGap ? " mid-gap" : "");
      hb.dataset.col = c;
      hb.textContent = toHex2(c);
      hexFrag.appendChild(hb);

      const ab = document.createElement("span");
      ab.className = "ab";
      ab.dataset.col = c;
      ab.textContent = (c % 16).toString(16).toUpperCase();
      asciiFrag.appendChild(ab);
    }

    rulerHex.innerHTML = "";
    rulerHex.appendChild(hexFrag);
    rulerAscii.innerHTML = "";
    rulerAscii.appendChild(asciiFrag);
  }

  function createRowDomShell(slice, showAscii) {
    const { rowStart, isNewFrameRow, frameObj } = slice;
    const rowEl = document.createElement("div");
    rowEl.className = "hex-row" + (isNewFrameRow ? " frame-break-row" : "");
    rowEl._slice = slice;

    const tsEl = document.createElement("span");
    tsEl.className = "row-ts";
    if (frameObj) {
      const dir = frameObj.dir || "RX";
      const dirLower = dir.toLowerCase();
      const tagEl = document.createElement("span");
      tagEl.className = `dir-tag ${dirLower}`;
      tagEl.textContent = dir;
      const tTextEl = document.createElement("span");
      tTextEl.textContent = frameObj.timeStr;
      tsEl.appendChild(tagEl);
      tsEl.appendChild(tTextEl);
    }
    rowEl.appendChild(tsEl);

    const offsetEl = document.createElement("span");
    offsetEl.className = "row-offset";
    offsetEl.textContent = toHex8(rowStart);
    rowEl.appendChild(offsetEl);

    const hexContainer = document.createElement("span");
    hexContainer.className = "row-hex";

    const asciiContainer = document.createElement("span");
    asciiContainer.className = "row-ascii" + (showAscii ? "" : " hidden");

    rowEl._hexContainer = hexContainer;
    rowEl._asciiContainer = asciiContainer;
    rowEl.appendChild(hexContainer);
    rowEl.appendChild(asciiContainer);
    return rowEl;
  }

  // Appends only newly arrived bytes (`slice._renderedIdx .. slice.rowEnd`) 1-by-1 into the existing row DOM!
  function appendBytesToRowDom(sess, slice, showAscii, isContinuousMode) {
    const { rowStart, rowEnd } = slice;
    const startIdx = slice._renderedIdx !== undefined ? slice._renderedIdx : rowStart;
    if (startIdx >= rowEnd) return;

    const bytes = sess.viewBytes;
    const hexContainer = slice._dom._hexContainer;
    const asciiContainer = slice._dom._asciiContainer;

    for (let idx = startIdx; idx < rowEnd; idx++) {
      const b = bytes[idx];
      const col = idx - rowStart;
      const hasGap = col % 8 === 7 && col < MAX_SINGLE_ROW_COLS - 1;
      const fid = sess.rxByteFrameIds[idx] ?? 0;
      const byteFrame = sess.rxFrames[fid];
      const isTxByte = byteFrame && byteFrame.dir === "TX";
      const isNewFrameStart =
        sess.frameBreakEnabled &&
        isContinuousMode &&
        idx > 0 &&
        sess.rxByteFrameIds[idx - 1] !== fid;

      let frameClasses = "";
      if (isTxByte) {
        frameClasses += " tx-byte";
      } else if (sess.frameBreakEnabled) {
        frameClasses += ` frame-c${fid % 4}`;
      }
      if (sess.frameBreakEnabled && isNewFrameStart) {
        frameClasses += " frame-start";
      }

      const hb = document.createElement("span");
      hb.className = "hb" + (hasGap ? " mid-gap" : "") + frameClasses;
      hb._idx = idx;
      hb.textContent = toHex2(b);
      hexContainer.appendChild(hb);

      if (showAscii) {
        const ab = document.createElement("span");
        ab.className = "ab" + frameClasses;
        ab._idx = idx;
        ab.textContent = toPrintableAscii(b);
        asciiContainer.appendChild(ab);
      }
    }

    slice._renderedIdx = rowEnd;
  }

  function renderVirtualizedHexGrid(sess, showAscii, scrollToBottom = false) {
    const bytes = sess.viewBytes;
    const rowSlices = sess.rowSlices;
    const maxCols = Math.min(MAX_SINGLE_ROW_COLS, sess.maxCols || 16);

    updateRulerForColumns(maxCols, showAscii);

    if (!bytes || bytes.length === 0 || rowSlices.length === 0) {
      vTopSpacer = null;
      vRowsHost = null;
      vBottomSpacer = null;
      el.rxHexGrid.innerHTML = `<div class="empty-placeholder">此分頁（${formatSessionTabTitle(sess)}）尚無收發數據。開啟串口並傳送數據後，此處將即時顯示時間戳記、十六進位與 ASCII 並排資料。</div>`;
      return;
    }

    ensureVirtualHostStructure();

    const totalRows = rowSlices.length;
    const totalHeight = totalRows * ROW_HEIGHT;
    const viewportHeight = el.rxViewport.clientHeight || 420;
    const doAutoScroll = scrollToBottom && el.chkRxAutoscroll.checked;

    const scrollTop = doAutoScroll
      ? Math.max(0, totalHeight - viewportHeight)
      : el.rxViewport.scrollTop;

    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
    const endRow = Math.min(
      totalRows,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS
    );

    const topPadHeight = startRow * ROW_HEIGHT;
    const bottomPadHeight = Math.max(0, (totalRows - endRow) * ROW_HEIGHT);

    vTopSpacer.style.height = `${topPadHeight}px`;
    vBottomSpacer.style.height = `${bottomPadHeight}px`;

    const layout = sess.frameLayout || "frame_single";
    const isContinuousMode =
      layout === "continuous_16" || layout === "continuous_32" || !sess.frameBreakEnabled;
    const modeKey = `${showAscii ? 1 : 0}|${sess.frameBreakEnabled ? 1 : 0}|${isContinuousMode ? 1 : 0}`;

    const desiredNodes = [];
    const desiredSet = new Set();

    for (let r = startRow; r < endRow; r++) {
      const slice = rowSlices[r];
      if (!slice._dom || slice._modeKey !== modeKey) {
        slice._dom = createRowDomShell(slice, showAscii);
        slice._modeKey = modeKey;
        slice._renderedIdx = slice.rowStart;
      }
      if (slice._renderedIdx < slice.rowEnd) {
        appendBytesToRowDom(sess, slice, showAscii, isContinuousMode);
      }
      desiredNodes.push(slice._dom);
      desiredSet.add(slice._dom);
    }

    // Keyed DOM reconciliation: keep existing visible rows in place without re-mounting!
    let child = vRowsHost.firstElementChild;
    while (child) {
      const next = child.nextElementSibling;
      if (!desiredSet.has(child)) {
        vRowsHost.removeChild(child);
      }
      child = next;
    }

    for (let i = 0; i < desiredNodes.length; i++) {
      const targetNode = desiredNodes[i];
      const currentAtPos = vRowsHost.children[i];
      if (currentAtPos !== targetNode) {
        vRowsHost.insertBefore(targetNode, currentAtPos || null);
      }
    }

    if (doAutoScroll) {
      el.rxViewport.scrollTop = totalHeight;
    }

    if (sess.selectedRxIndex >= 0 && sess.selectedRxIndex < bytes.length) {
      applyHighlightToVisibleDom(sess, sess.selectedRxIndex);
    }
  }

  // Re-render visible virtual rows on viewport scroll
  let scrollRaf = false;
  el.rxViewport.addEventListener("scroll", () => {
    if (scrollRaf) return;
    const sess = getActiveSession();
    if (!sess || (sess.rxMode !== "dual" && sess.rxMode !== "hex")) return;
    scrollRaf = true;
    requestAnimationFrame(() => {
      scrollRaf = false;
      renderVirtualizedHexGrid(sess, sess.rxMode === "dual", false);
    });
  });

  function renderTextViewWindowed(sess, scrollToBottom) {
    if (sess.rxFrames.length === 0) {
      el.rxTextView.textContent = "（此分頁尚無收發數據）";
      return;
    }
    if (sess.showTimestamp) {
      const maxFrames = 300;
      const startFrame = Math.max(0, sess.rxFrames.length - maxFrames);
      const lines = [];
      if (startFrame > 0) {
        lines.push(`... (為保持高速流暢，僅顯示最新 ${maxFrames} 幀文字，完整數據已保留於緩衝區) ...`);
      }
      for (let i = startFrame; i < sess.rxFrames.length; i++) {
        const f = sess.rxFrames[i];
        const slice = sess.viewBytes.slice(f.startIdx, Math.min(f.startIdx + f.length, f.startIdx + 2048));
        lines.push(`[${f.timeStr} ${f.dir}] ${bytesToUtf8Text(slice)}`);
      }
      el.rxTextView.textContent = lines.join("\n");
    } else {
      const maxTailBytes = 32768;
      const tail =
        sess.viewBytes.length > maxTailBytes
          ? sess.viewBytes.slice(sess.viewBytes.length - maxTailBytes)
          : sess.viewBytes;
      el.rxTextView.textContent = bytesToUtf8Text(tail);
    }
    if (scrollToBottom && el.chkRxAutoscroll.checked) {
      el.rxViewport.scrollTop = el.rxViewport.scrollHeight;
    }
  }

  function renderPacketTimelineWindowed(sess, scrollToBottom) {
    if (sess.packets.length === 0) {
      el.rxPacketView.innerHTML = `<div class="empty-placeholder">此分頁尚無收發封包紀錄。</div>`;
      return;
    }
    const maxPkts = 200;
    const startIdx = Math.max(0, sess.packets.length - maxPkts);
    const fragment = document.createDocumentFragment();

    for (let i = startIdx; i < sess.packets.length; i++) {
      const pkt = sess.packets[i];
      const row = document.createElement("div");
      row.className = "pkt-item";
      const previewBytes = pkt.previewBytes || pkt.bytes || [];
      const totalLen = pkt.byteLength !== undefined ? pkt.byteLength : previewBytes.length;
      const hexStr =
        bytesToHexString(previewBytes, false) + (totalLen > 256 ? " ..." : "");
      const asciiStr = previewBytes.map(toPrintableAscii).join("");
      const canTag = pkt.canMeta ? `<span class="pkt-can-meta">[${pkt.canMeta}]</span> ` : "";
      row.innerHTML = `
        <span class="pkt-time">${pkt.time}</span>
        <span class="pkt-dir ${pkt.dir.toLowerCase()}">${pkt.dir}</span>
        <span class="pkt-len">${totalLen} B</span>
        <span class="pkt-payload">${canTag}${hexStr} <span class="pkt-ascii-sub">| ${asciiStr.replace(/</g, "&lt;")}</span></span>
      `;
      fragment.appendChild(row);
    }
    el.rxPacketView.innerHTML = "";
    el.rxPacketView.appendChild(fragment);
    if (scrollToBottom && el.chkRxAutoscroll.checked) {
      el.rxViewport.scrollTop = el.rxViewport.scrollHeight;
    }
  }

  function formatFixedHexData(dataBytes, prevData) {
    if (!dataBytes || dataBytes.length === 0) return '<span style="color:#94a3b8;">-</span>';
    return dataBytes
      .map((b, i) => {
        const hex = b.toString(16).toUpperCase().padStart(2, "0");
        const isMod = prevData && prevData.length > i && prevData[i] !== b;
        return isMod ? `<span class="byte-mod">${hex}</span>` : hex;
      })
      .join(" ");
  }

  function renderFixedTable(sess) {
    if (!el.fixedTableBody) return;
    if (!sess.fixedMap || sess.fixedMap.size === 0) {
      el.fixedTableBody._rowMap = null;
      el.fixedTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 28px; color:#94a3b8; font-size: 13px;">此分頁尚無接收數據。<br><span style="font-size: 11px; opacity: 0.8;">（固定行模式將依 CAN ID 或幀識別碼原地覆蓋更新最新數據、計數與週期時間）</span></td></tr>`;
      return;
    }

    let rowMap = el.fixedTableBody._rowMap;
    if (!rowMap || el.fixedTableBody._currentSessionId !== sess.id) {
      el.fixedTableBody.innerHTML = "";
      rowMap = new Map();
      el.fixedTableBody._rowMap = rowMap;
      el.fixedTableBody._currentSessionId = sess.id;
    }

    const sortedItems = Array.from(sess.fixedMap.values()).sort((a, b) => (a.rawId ?? 0) - (b.rawId ?? 0));

    for (let i = 0; i < sortedItems.length; i++) {
      const item = sortedItems[i];
      let rowObj = rowMap.get(item.key);

      if (!rowObj) {
        const tr = document.createElement("tr");
        tr.dataset.key = item.key;
        tr.innerHTML = `
          <td class="td-id">${item.idStr}</td>
          <td class="td-type ${item.typeStr.toLowerCase()}">${item.typeStr}</td>
          <td class="td-dlc">${item.dlc}</td>
          <td class="td-data">${formatFixedHexData(item.data, item.prevData)}</td>
          <td class="td-ascii">${item.data.map(toPrintableAscii).join("").replace(/</g, "&lt;")}</td>
          <td class="td-count">${item.count}</td>
          <td class="td-cycle">${item.cycleMs > 0 ? item.cycleMs.toFixed(1) : "-"}</td>
          <td class="td-time">${item.timeStr}</td>
        `;
        el.fixedTableBody.appendChild(tr);
        rowObj = {
          tr,
          tdDlc: tr.children[2],
          tdData: tr.children[3],
          tdAscii: tr.children[4],
          tdCount: tr.children[5],
          tdCycle: tr.children[6],
          tdTime: tr.children[7],
        };
        rowMap.set(item.key, rowObj);
      } else {
        rowObj.tdDlc.textContent = item.dlc;
        rowObj.tdData.innerHTML = formatFixedHexData(item.data, item.prevData);
        rowObj.tdAscii.textContent = item.data.map(toPrintableAscii).join("");
        rowObj.tdCount.textContent = item.count;
        rowObj.tdCycle.textContent = item.cycleMs > 0 ? item.cycleMs.toFixed(1) : "-";
        rowObj.tdTime.textContent = item.timeStr;
      }
    }
  }

  let lastHoverClientX = -1;
  let lastHoverClientY = -1;

  el.rxHexGrid.addEventListener("mouseover", (e) => {
    // Ignore synthetic mouseover events fired during auto-scroll when mouse hasn't moved
    if (e.clientX === lastHoverClientX && e.clientY === lastHoverClientY) return;
    lastHoverClientX = e.clientX;
    lastHoverClientY = e.clientY;
    const idx = e.target && e.target._idx;
    if (typeof idx !== "number") return;
    highlightRxByte(idx);
  });

  el.rxHexGrid.addEventListener("click", (e) => {
    const idx = e.target && e.target._idx;
    if (typeof idx !== "number") return;
    const sess = getActiveSession();
    if (sess) sess.selectedRxIndex = idx;
    highlightRxByte(idx);
  });

  function clearActiveHighlightEls() {
    for (let i = 0; i < activeHighlightedEls.length; i++) {
      activeHighlightedEls[i].classList.remove("active", "frame-active");
    }
    activeHighlightedEls.length = 0;
  }

  function applyHighlightToVisibleDom(sess, idx) {
    clearActiveHighlightEls();
    if (!vRowsHost) return null;

    const fid = sess.rxByteFrameIds[idx] ?? 0;
    const frameObj = sess.rxFrames[fid];
    const fStart = frameObj ? frameObj.startIdx : idx;
    const fEnd = frameObj ? frameObj.startIdx + frameObj.length : idx + 1;
    let activeCol = idx % 16;

    const rows = vRowsHost.children;
    for (let r = 0; r < rows.length; r++) {
      const rowEl = rows[r];
      const slice = rowEl._slice;
      if (!slice) continue;

      if (idx >= slice.rowStart && idx < slice.rowEnd) {
        const col = idx - slice.rowStart;
        activeCol = col;
        const hb = rowEl._hexContainer && rowEl._hexContainer.children[col];
        const ab = rowEl._asciiContainer && rowEl._asciiContainer.children[col];
        if (hb) {
          hb.classList.add("active");
          activeHighlightedEls.push(hb);
        }
        if (ab) {
          ab.classList.add("active");
          activeHighlightedEls.push(ab);
        }
      }

      if (sess.frameBreakEnabled && fEnd > slice.rowStart && fStart < slice.rowEnd) {
        const startCol = Math.max(0, fStart - slice.rowStart);
        const endCol = Math.min(slice.rowEnd - slice.rowStart, fEnd - slice.rowStart);
        const hexChildren = rowEl._hexContainer ? rowEl._hexContainer.children : null;
        const asciiChildren = rowEl._asciiContainer ? rowEl._asciiContainer.children : null;
        for (let c = startCol; c < endCol; c++) {
          if (hexChildren && hexChildren[c]) {
            hexChildren[c].classList.add("frame-active");
            activeHighlightedEls.push(hexChildren[c]);
          }
          if (asciiChildren && asciiChildren[c]) {
            asciiChildren[c].classList.add("frame-active");
            activeHighlightedEls.push(asciiChildren[c]);
          }
        }
      }
    }
    return activeCol;
  }

  function highlightRxByte(idx) {
    const sess = getActiveSession();
    const bytes = (sess && sess.viewBytes) || [];
    if (!sess || isNaN(idx) || idx < 0 || idx >= bytes.length) return;

    const activeCol = applyHighlightToVisibleDom(sess, idx);
    const col = activeCol !== null ? activeCol : idx % 16;

    el.rxHexRuler.querySelectorAll(".col-active").forEach((node) => {
      node.classList.remove("col-active");
    });
    el.rxHexRuler.querySelectorAll(`[data-col="${col}"]`).forEach((node) => {
      node.classList.add("col-active");
    });

    const fid = sess.rxByteFrameIds[idx] ?? 0;
    const b = bytes[idx];
    const bin = b.toString(2).padStart(8, "0");
    const ch = toPrintableAscii(b);
    const frameObj = sess.rxFrames[fid];
    const frameTag = frameObj
      ? `[${frameObj.dir || "RX"} 幀 #${fid + 1} | 時間: ${frameObj.timeStr} | 幀長: ${frameObj.length} B | 幀內位移: +${idx - frameObj.startIdx} (0x${toHex2(idx - frameObj.startIdx)})]   `
      : "";
    el.rxSelectionInfo.textContent = `${frameTag}位址: 0x${toHex8(idx)} (${idx})  |  Hex: 0x${toHex2(b)}  |  Dec: ${b}  |  Bin: ${bin}  |  ASCII: '${ch}'`;
  }

  // ==================== TRANSMIT DUAL EDITOR SYNC ====================
  let isSyncingTx = false;
  let txHexGridMode = true;

  function initTxHexRuler() {
    if (!el.txRulerHexCols || el.txRulerHexCols.childElementCount > 0) return;
    const frag = document.createDocumentFragment();
    for (let c = 0; c < 16; c++) {
      const hb = document.createElement("span");
      hb.className = "hb" + (c === 7 ? " mid-gap" : "");
      hb.dataset.col = c;
      hb.textContent = toHex2(c);
      frag.appendChild(hb);
    }
    el.txRulerHexCols.appendChild(frag);
  }
  initTxHexRuler();

  function highlightTxRulerCol(col) {
    if (!el.txRulerHexCols) return;
    const cells = el.txRulerHexCols.children;
    for (let i = 0; i < cells.length; i++) {
      cells[i].classList.toggle("col-active", i === col);
    }
  }

  function focusTxHexCell(idx) {
    const cell = el.txHexGrid && el.txHexGrid.querySelector(`.tx-hb[data-idx="${idx}"]`);
    if (cell) {
      cell.focus();
      cell.select();
    }
  }

  function renderTxHexGrid(sess) {
    if (!sess || sess.id !== activeSessionId || !el.txHexGrid) return;
    const bytes = sess.txBytes || [];
    const totalCells = bytes.length + 1;
    const rowCount = Math.max(1, Math.ceil(totalCells / 16));
    const frag = document.createDocumentFragment();

    for (let r = 0; r < rowCount; r++) {
      const rowStart = r * 16;
      const rowEl = document.createElement("div");
      rowEl.className = "tx-hex-row";

      const offsetEl = document.createElement("span");
      offsetEl.className = "row-offset";
      offsetEl.textContent = toHex8(rowStart);
      rowEl.appendChild(offsetEl);

      const hexEl = document.createElement("span");
      hexEl.className = "row-hex";

      for (let c = 0; c < 16; c++) {
        const idx = rowStart + c;
        if (idx > bytes.length) break;
        const inp = document.createElement("input");
        inp.type = "text";
        inp.maxLength = 2;
        inp.spellcheck = false;
        inp.dataset.idx = String(idx);
        inp.className = "tx-hb" + (c === 7 ? " mid-gap" : "");
        if (idx === bytes.length) {
          inp.classList.add("tx-hb-new");
          inp.placeholder = "+";
          inp.title = "輸入或貼上 Hex 位元組";
        } else {
          inp.value = toHex2(bytes[idx]);
          inp.title = `Offset 0x${toHex8(idx)} (${idx})`;
        }
        hexEl.appendChild(inp);
      }

      rowEl.appendChild(hexEl);
      frag.appendChild(rowEl);
    }

    el.txHexGrid.innerHTML = "";
    el.txHexGrid.appendChild(frag);
  }

  function syncTxFromBytes(sess, bytes) {
    sess.txBytes = Array.from(bytes);
    sess.txHexText = bytesToHexString(sess.txBytes, true);
    sess.txAsciiText = bytesToUtf8Text(sess.txBytes);
    sess.txHasOddNibble = false;
    isSyncingTx = true;
    el.txHexInput.value = sess.txHexText;
    el.txAsciiInput.value = sess.txAsciiText;
    el.txHexStatus.textContent = `格式正常 (${sess.txBytes.length} Bytes)`;
    el.txHexStatus.classList.remove("error");
    updateTxGutterAndPill(sess);
    isSyncingTx = false;
  }

  if (el.btnTxHexView) {
    el.btnTxHexView.addEventListener("click", () => {
      txHexGridMode = !txHexGridMode;
      el.txHexGridWrap.classList.toggle("hidden", !txHexGridMode);
      el.txHexWrap.classList.toggle("hidden", txHexGridMode);
      el.btnTxHexView.textContent = txHexGridMode ? "文字模式" : "拆格模式";
      const sess = getActiveSession();
      if (txHexGridMode && sess) {
        renderTxHexGrid(sess);
      }
    });
  }

  if (el.txHexGrid) {
    el.txHexGrid.addEventListener("focusin", (e) => {
      if (!e.target.classList.contains("tx-hb")) return;
      const idx = parseInt(e.target.dataset.idx, 10);
      if (!isNaN(idx)) {
        highlightTxRulerCol(idx % 16);
      }
      e.target.select();
    });

    el.txHexGrid.addEventListener("focusout", (e) => {
      if (!e.target.classList.contains("tx-hb")) return;
      const sess = getActiveSession();
      if (!sess) return;
      const idx = parseInt(e.target.dataset.idx, 10);
      if (isNaN(idx)) return;
      const clean = e.target.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
      if (clean.length === 1) {
        const val = parseInt(clean, 16);
        const nextBytes = [...sess.txBytes];
        if (idx === nextBytes.length) {
          nextBytes.push(val);
        } else {
          nextBytes[idx] = val;
        }
        syncTxFromBytes(sess, nextBytes);
        renderTxHexGrid(sess);
      } else if (clean.length === 0 && idx < sess.txBytes.length) {
        e.target.value = toHex2(sess.txBytes[idx]);
      }
      highlightTxRulerCol(-1);
    });

    el.txHexGrid.addEventListener("input", (e) => {
      if (!e.target.classList.contains("tx-hb") || isSyncingTx) return;
      const sess = getActiveSession();
      if (!sess) return;
      const idx = parseInt(e.target.dataset.idx, 10);
      if (isNaN(idx)) return;

      const clean = e.target.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
      if (e.target.value !== clean) {
        e.target.value = clean;
      }
      if (clean.length === 2) {
        const val = parseInt(clean, 16);
        const nextBytes = [...sess.txBytes];
        const isNew = idx >= nextBytes.length;
        if (isNew) {
          nextBytes.push(val);
        } else {
          nextBytes[idx] = val;
        }
        syncTxFromBytes(sess, nextBytes);
        renderTxHexGrid(sess);
        focusTxHexCell(idx + 1);
      } else if (clean.length === 1) {
        el.txHexStatus.textContent = "輸入中...";
      }
    });

    el.txHexGrid.addEventListener("paste", (e) => {
      if (!e.target.classList.contains("tx-hb")) return;
      const sess = getActiveSession();
      if (!sess) return;
      const idx = parseInt(e.target.dataset.idx, 10);
      if (isNaN(idx)) return;
      const pasted = (e.clipboardData || window.clipboardData).getData("text");
      const { bytes: pastedBytes } = parseHexInput(pasted);
      if (pastedBytes.length === 0) return;

      e.preventDefault();
      const nextBytes = [...sess.txBytes];
      nextBytes.splice(idx, pastedBytes.length, ...pastedBytes);
      syncTxFromBytes(sess, nextBytes);
      renderTxHexGrid(sess);
      focusTxHexCell(idx + pastedBytes.length);
    });

    el.txHexGrid.addEventListener("keydown", (e) => {
      if (!e.target.classList.contains("tx-hb")) return;
      const sess = getActiveSession();
      if (!sess) return;
      const idx = parseInt(e.target.dataset.idx, 10);
      if (isNaN(idx)) return;

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        triggerSessionSend(sess);
        return;
      }
      if (e.key === "Backspace") {
        const isEmptyOrSelectedAll =
          e.target.value === "" ||
          (e.target.selectionStart === 0 && e.target.selectionEnd === e.target.value.length);
        if (e.target.classList.contains("tx-hb-new") && e.target.value === "" && idx > 0) {
          e.preventDefault();
          const nextBytes = [...sess.txBytes];
          nextBytes.splice(idx - 1, 1);
          syncTxFromBytes(sess, nextBytes);
          renderTxHexGrid(sess);
          focusTxHexCell(idx - 1);
          return;
        }
        if (isEmptyOrSelectedAll && idx < sess.txBytes.length) {
          e.preventDefault();
          const nextBytes = [...sess.txBytes];
          nextBytes.splice(idx, 1);
          syncTxFromBytes(sess, nextBytes);
          renderTxHexGrid(sess);
          focusTxHexCell(Math.max(0, idx - 1));
          return;
        }
      }
      if (e.key === "Delete" && idx < sess.txBytes.length) {
        e.preventDefault();
        const nextBytes = [...sess.txBytes];
        nextBytes.splice(idx, 1);
        syncTxFromBytes(sess, nextBytes);
        renderTxHexGrid(sess);
        focusTxHexCell(Math.min(idx, nextBytes.length));
        return;
      }
      if (e.key === "ArrowLeft" && idx > 0) {
        e.preventDefault();
        focusTxHexCell(idx - 1);
      } else if (e.key === "ArrowRight" && idx < sess.txBytes.length) {
        e.preventDefault();
        focusTxHexCell(idx + 1);
      } else if (e.key === "ArrowUp" && idx >= 16) {
        e.preventDefault();
        focusTxHexCell(idx - 16);
      } else if (e.key === "ArrowDown" && idx + 16 <= sess.txBytes.length) {
        e.preventDefault();
        focusTxHexCell(idx + 16);
      }
    });
  }

  function updateTxGutterAndPill(sess) {
    if (!sess || sess.id !== activeSessionId) return;
    const len = sess.txBytes.length;
    el.txLengthPill.textContent = `長度: ${len} Bytes`;

    const rowCount = Math.max(1, Math.min(500, Math.ceil(len / 16)));
    const offsets = [];
    for (let r = 0; r < rowCount; r++) {
      offsets.push(toHex8(r * 16));
    }
    el.txOffsetGutter.textContent = offsets.join("\n");
  }

  el.txHexInput.addEventListener("input", () => {
    if (isSyncingTx) return;
    const sess = getActiveSession();
    if (!sess) return;
    isSyncingTx = true;

    const { bytes, hasOddNibble } = parseHexInput(el.txHexInput.value);
    sess.txBytes = bytes;
    sess.txHexText = el.txHexInput.value;
    sess.txAsciiText = bytesToUtf8Text(bytes);
    sess.txHasOddNibble = hasOddNibble;

    el.txAsciiInput.value = sess.txAsciiText;

    if (hasOddNibble) {
      el.txHexStatus.textContent = "提示：尚有未湊滿 2 位數的半位元組";
      el.txHexStatus.classList.add("error");
    } else {
      el.txHexStatus.textContent = `格式正常 (${bytes.length} Bytes)`;
      el.txHexStatus.classList.remove("error");
    }
    updateTxGutterAndPill(sess);
    renderTxHexGrid(sess);
    isSyncingTx = false;
  });

  el.txAsciiInput.addEventListener("input", () => {
    if (isSyncingTx) return;
    const sess = getActiveSession();
    if (!sess) return;
    isSyncingTx = true;

    const bytes = utf8TextToBytes(el.txAsciiInput.value);
    sess.txBytes = bytes;
    sess.txAsciiText = el.txAsciiInput.value;
    sess.txHexText = bytesToHexString(bytes, true);
    sess.txHasOddNibble = false;

    el.txHexInput.value = sess.txHexText;
    el.txHexStatus.textContent = `格式正常 (${bytes.length} Bytes)`;
    el.txHexStatus.classList.remove("error");
    updateTxGutterAndPill(sess);
    renderTxHexGrid(sess);
    isSyncingTx = false;
  });

  function handleTxInputEnterKey(e) {
    if (e.key === "Enter") {
      if (e.shiftKey) {
        // Shift + Enter: 保留換行
        return;
      }
      // Enter 直接發送
      e.preventDefault();
      triggerSessionSend(getActiveSession());
    }
  }

  el.txHexInput.addEventListener("keydown", handleTxInputEnterKey);
  el.txAsciiInput.addEventListener("keydown", handleTxInputEnterKey);

  function setTxEditorBytesForSession(sess, bytes) {
    if (!sess) return;
    sess.txBytes = Array.from(bytes);
    sess.txHexText = bytesToHexString(sess.txBytes, true);
    sess.txAsciiText = bytesToUtf8Text(sess.txBytes);
    sess.txHasOddNibble = false;

    if (sess.id === activeSessionId) {
      isSyncingTx = true;
      el.txHexInput.value = sess.txHexText;
      el.txAsciiInput.value = sess.txAsciiText;
      el.txHexStatus.textContent = `格式正常 (${sess.txBytes.length} Bytes)`;
      el.txHexStatus.classList.remove("error");
      updateTxGutterAndPill(sess);
      renderTxHexGrid(sess);
      isSyncingTx = false;
    }
  }

  // ==================== TRANSMIT EXECUTION ====================
  async function sendPayloadBytesForSession(sess, rawBytes) {
    if (!sess) return;
    if (!sess.isOpen) {
      if (sess.id === activeSessionId) {
        await togglePortForActiveSession();
      }
      if (!sess.isOpen) return;
    }

    const isPcan = sess.connType === "pcan";
    const bytesToSend = Array.from(rawBytes);

    let pcanFramePayload = null;
    if (isPcan) {
      const idStr = (sess.id === activeSessionId && el.inpCanTxId ? el.inpCanTxId.value : sess.canTxId || "7DF").trim();
      const typeStr = sess.id === activeSessionId && el.selCanTxType ? el.selCanTxType.value : sess.canTxType || "std";
      const parsedId = parseInt(idStr, 16);
      if (isNaN(parsedId) || parsedId < 0) {
        setSessionStatus(sess, `無效的 CAN ID (Hex): "${idStr}"`);
        return;
      }
      const extended = typeStr === "ext" || typeStr === "rtr_ext";
      const rtr = typeStr === "rtr_std" || typeStr === "rtr_ext";
      if (!rtr && bytesToSend.length === 0) {
        setSessionStatus(sess, "發送區為空，無數據可傳送");
        return;
      }
      if (!rtr && bytesToSend.length > 8) {
        setSessionStatus(sess, `Classic CAN 單幀最多 8 Bytes（目前 ${bytesToSend.length} Bytes）`);
        return;
      }
      pcanFramePayload = {
        id: parsedId,
        extended,
        rtr,
        data: rtr ? [] : bytesToSend,
      };
    } else if (bytesToSend.length === 0) {
      setSessionStatus(sess, "發送區為空，無數據可傳送");
      return;
    }

    const invoke = getTauriInvoke();
    try {
      if (invoke) {
        if (isPcan) {
          await invoke("write_pcan_frame", {
            sessionId: sess.id,
            frame: pcanFramePayload,
          });
        } else {
          await invoke("write_serial_bytes", {
            sessionId: sess.id,
            data: bytesToSend,
          });
        }
      } else {
        const simMs = performance.now();
        setTimeout(
          () =>
            onReceiveBatchForSession(sess.id, simMs + 10, [
              { perfMs: simMs + 10, data: bytesToSend },
            ]),
          10
        );
      }

      sess.txByteCount += bytesToSend.length;
      sess.txPktCount += 1;
      const txChunk = {
        perfMs: performance.now(),
        timeStr: formatTimestamp(),
        dir: "TX",
        bytes: bytesToSend,
      };
      sess.rxRawChunks.push(txChunk);
      appendChunkIncremental(sess, txChunk);

      if (sess.id === activeSessionId) {
        scheduleActiveRender(true);
      }
      setSessionStatus(sess, `已傳送 ${bytesToSend.length} Bytes 至 ${sess.portName}`);
    } catch (err) {
      setSessionStatus(sess, `傳送失敗: ${err}`);
    }
  }

  async function triggerSessionSend(sess) {
    if (!sess) return;
    if (sess.txTab === "datalist") {
      await sendNextDataListItemForSession(sess);
      return;
    }

    const bytes = [...sess.txBytes];
    const appendCrlf = sess.id === activeSessionId ? el.chkTxCrlf.checked : sess.txCrlf;
    if (appendCrlf) {
      bytes.push(0x0d, 0x0a);
    }
    await sendPayloadBytesForSession(sess, bytes);
  }

  // ==================== MULTI-SEND DATALIST (CHARLIST) ====================
  function parseDataListRowPayload(row) {
    if (row.format === "HEX") {
      return parseHexInput(row.payload).bytes;
    }
    const unescaped = row.payload
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
    return utf8TextToBytes(unescaped);
  }

  async function sendNextDataListItemForSession(sess) {
    const enabledRows = sess.datalist.filter((r) => r.enabled && r.payload.trim().length > 0);
    if (enabledRows.length === 0) {
      setSessionStatus(sess, "快捷發送列表中沒有勾選的項目");
      return;
    }
    const idx = sess.datalistCursor % enabledRows.length;
    sess.datalistCursor = (sess.datalistCursor + 1) % enabledRows.length;
    const item = enabledRows[idx];
    const bytes = parseDataListRowPayload(item);
    await sendPayloadBytesForSession(sess, bytes);
  }

  function escapeHtmlAttr(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderDataList(sess) {
    if (!sess || sess.id !== activeSessionId) return;
    el.datalistTbody.innerHTML = "";
    sess.datalist.forEach((row, index) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="text-align:center;">
          <input type="checkbox" class="dl-chk" data-idx="${index}" ${row.enabled ? "checked" : ""} />
        </td>
        <td>
          <input type="text" class="dl-name" data-idx="${index}" value="${escapeHtmlAttr(row.name)}" />
        </td>
        <td>
          <select class="dl-fmt" data-idx="${index}">
            <option value="HEX" ${row.format === "HEX" ? "selected" : ""}>HEX</option>
            <option value="ASCII" ${row.format === "ASCII" ? "selected" : ""}>ASCII</option>
          </select>
        </td>
        <td>
          <input type="text" class="dl-payload" data-idx="${index}" value="${escapeHtmlAttr(row.payload)}" />
        </td>
        <td>
          <button class="mini-btn dl-send" data-idx="${index}">傳送</button>
          <button class="mini-btn dl-del" data-idx="${index}" title="刪除此列">✕</button>
        </td>
      `;
      el.datalistTbody.appendChild(tr);
    });
  }

  el.datalistTbody.addEventListener("change", (e) => {
    const sess = getActiveSession();
    if (!sess) return;
    const idx = parseInt(e.target.dataset.idx, 10);
    if (isNaN(idx)) return;
    if (e.target.classList.contains("dl-chk")) {
      sess.datalist[idx].enabled = e.target.checked;
    } else if (e.target.classList.contains("dl-name")) {
      sess.datalist[idx].name = e.target.value;
    } else if (e.target.classList.contains("dl-fmt")) {
      sess.datalist[idx].format = e.target.value;
    } else if (e.target.classList.contains("dl-payload")) {
      sess.datalist[idx].payload = e.target.value;
    }
  });

  el.datalistTbody.addEventListener("click", async (e) => {
    const sess = getActiveSession();
    if (!sess) return;
    const idx = parseInt(e.target.dataset.idx, 10);
    if (isNaN(idx)) return;
    if (e.target.classList.contains("dl-send")) {
      const bytes = parseDataListRowPayload(sess.datalist[idx]);
      await sendPayloadBytesForSession(sess, bytes);
    } else if (e.target.classList.contains("dl-del")) {
      sess.datalist.splice(idx, 1);
      renderDataList(sess);
    }
  });

  el.btnAddRow.addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess) return;
    sess.datalist.push({
      enabled: true,
      name: `指令 #${sess.datalist.length + 1}`,
      format: "HEX",
      payload: "01 02 03 04",
    });
    renderDataList(sess);
  });

  // ==================== PER-SESSION TIMED SEND ====================
  async function executeTimedSendStep(sess) {
    if (!sess || !sess.autoSendEnabled) return;
    await triggerSessionSend(sess);

    if (!sess.isOpen) {
      stopAutoSendForSession(sess);
      return;
    }

    sess.autoSendCurrentCount += 1;
    updateAutoSendUi(sess);

    if (sess.autoSendMaxCount > 0 && sess.autoSendCurrentCount >= sess.autoSendMaxCount) {
      const doneCount = sess.autoSendCurrentCount;
      stopAutoSendForSession(sess);
      setSessionStatus(
        sess,
        `[定時發送完成] 已達設定上限 ${doneCount} / ${sess.autoSendMaxCount} 次，自動停止`
      );
    }
  }

  async function startAutoSendForSession(sess) {
    if (!sess) return;
    stopAutoSendForSession(sess);

    if (!sess.isOpen && sess.id === activeSessionId) {
      await togglePortForActiveSession();
      if (!sess.isOpen) {
        updateAutoSendUi(sess);
        return;
      }
    }

    const interval = Math.max(5, parseInt(el.inpAutoInterval.value, 10) || 1000);
    const maxCount = Math.max(0, parseInt(el.inpAutoMaxCount.value, 10) || 0);
    sess.autoSendInterval = interval;
    sess.autoSendMaxCount = maxCount;
    sess.autoSendCurrentCount = 0;
    sess.autoSendEnabled = true;

    updateAutoSendUi(sess);
    renderSessionTabs();

    await executeTimedSendStep(sess);
    if (!sess.autoSendEnabled) return;

    sess.autoSendTimer = setInterval(() => {
      executeTimedSendStep(sess);
    }, sess.autoSendInterval);
  }

  function stopAutoSendForSession(sess) {
    if (!sess) return;
    if (sess.autoSendTimer) {
      clearInterval(sess.autoSendTimer);
      sess.autoSendTimer = null;
    }
    sess.autoSendEnabled = false;
    updateAutoSendUi(sess);
    renderSessionTabs();
  }

  el.chkAutoSend.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    if (el.chkAutoSend.checked) {
      startAutoSendForSession(sess);
    } else {
      stopAutoSendForSession(sess);
      setSessionStatus(sess, `已停止定時發送 (本次共發送 ${sess.autoSendCurrentCount} 次)`);
    }
  });

  el.inpAutoInterval.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    const interval = Math.max(5, parseInt(el.inpAutoInterval.value, 10) || 1000);
    el.inpAutoInterval.value = interval;
    sess.autoSendInterval = interval;
    if (sess.autoSendEnabled && sess.autoSendTimer) {
      clearInterval(sess.autoSendTimer);
      sess.autoSendTimer = setInterval(() => {
        executeTimedSendStep(sess);
      }, sess.autoSendInterval);
      setSessionStatus(sess, `已更新定時發送週期為 ${interval} ms`);
    }
  });

  el.inpAutoMaxCount.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    const maxCount = Math.max(0, parseInt(el.inpAutoMaxCount.value, 10) || 0);
    el.inpAutoMaxCount.value = maxCount;
    sess.autoSendMaxCount = maxCount;
    updateAutoSendUi(sess);
    if (sess.autoSendEnabled && maxCount > 0 && sess.autoSendCurrentCount >= maxCount) {
      stopAutoSendForSession(sess);
      setSessionStatus(sess, `[定時發送完成] 已達設定上限 ${sess.autoSendCurrentCount} / ${maxCount} 次`);
    }
  });

  // ==================== COUNTERS & HARDWARE LINES ====================
  function updateCountersUi(sess) {
    if (!sess || sess.id !== activeSessionId) return;
    el.countRxBytes.textContent = sess.rxBytes.length.toLocaleString();
    el.countRxPkts.textContent = sess.rxPktCount.toLocaleString();
    el.countTxBytes.textContent = sess.txByteCount.toLocaleString();
    el.countTxPkts.textContent = sess.txPktCount.toLocaleString();
  }

  function clearRx() {
    const sess = getActiveSession();
    if (!sess) return;
    sess.rxBytes = [];
    sess.viewBytes = [];
    sess.rxRawChunks = [];
    sess.rxByteFrameIds = [];
    sess.rxFrames = [];
    sess.rowSlices = [];
    sess.maxCols = sess.frameLayout === "continuous_32" ? 32 : 16;
    sess.packets = [];
    sess.rxPktCount = 0;
    if (sess.fixedMap) sess.fixedMap.clear();
    if (el.fixedTableBody) {
      el.fixedTableBody._rowMap = null;
      el.fixedTableBody.innerHTML = "";
    }
    sess.selectedRxIndex = -1;
    el.rxSelectionInfo.textContent =
      "滑鼠指向或點擊任一 Byte 以檢視位址、所屬數據幀、Hex / Dec / Bin 與 ASCII 資訊";
    el.rxFrameCount.textContent = "0 幀";
    el.rxHexRuler.querySelectorAll(".col-active").forEach((n) => n.classList.remove("col-active"));
    updateCountersUi(sess);
    renderRxView(sess, false);
    setSessionStatus(sess, "已清空此分頁接收緩衝區");
  }

  function clearTx() {
    const sess = getActiveSession();
    if (!sess) return;
    setTxEditorBytesForSession(sess, []);
    setSessionStatus(sess, "已清空此分頁發送緩衝區");
  }

  function resetCounters() {
    const sess = getActiveSession();
    if (!sess) return;
    sess.rxPktCount = 0;
    sess.txByteCount = 0;
    sess.txPktCount = 0;
    sess.autoSendCurrentCount = 0;
    updateCountersUi(sess);
    updateAutoSendUi(sess);
    setSessionStatus(sess, "已重置此分頁收發與定時發送計數器");
  }

  el.btnLineDtr.addEventListener("click", async () => {
    const sess = getActiveSession();
    if (!sess || !sess.isOpen) return;
    sess.dtr = !sess.dtr;
    updateModemLeds(sess);
    const invoke = getTauriInvoke();
    if (invoke) {
      try {
        await invoke("set_control_lines", {
          sessionId: sess.id,
          dtr: sess.dtr,
          rts: sess.rts,
        });
      } catch (err) {
        console.error(err);
      }
    }
  });

  el.btnLineRts.addEventListener("click", async () => {
    const sess = getActiveSession();
    if (!sess || !sess.isOpen) return;
    sess.rts = !sess.rts;
    updateModemLeds(sess);
    const invoke = getTauriInvoke();
    if (invoke) {
      try {
        await invoke("set_control_lines", {
          sessionId: sess.id,
          dtr: sess.dtr,
          rts: sess.rts,
        });
      } catch (err) {
        console.error(err);
      }
    }
  });

  // ==================== RESIZABLE SPLITTER ====================
  let isDraggingSplitter = false;
  let isDraggingSidebar = false;

  if (el.sidebarSplitter && el.leftSidebar && el.appBody) {
    el.sidebarSplitter.addEventListener("mousedown", () => {
      isDraggingSidebar = true;
      el.sidebarSplitter.classList.add("dragging");
      document.body.style.cursor = "col-resize";
    });
  }

  el.splitter.addEventListener("mousedown", () => {
    isDraggingSplitter = true;
    document.body.style.cursor = "row-resize";
  });

  window.addEventListener("mousemove", (e) => {
    if (isDraggingSidebar && el.appBody && el.leftSidebar) {
      const rect = el.appBody.getBoundingClientRect();
      const newWidth = Math.max(185, Math.min(420, e.clientX - rect.left));
      el.leftSidebar.style.width = `${newWidth}px`;
      return;
    }
    if (!isDraggingSplitter) return;
    const rect = el.workspace.getBoundingClientRect();
    const totalHeight = rect.height;
    const pointerY = e.clientY - rect.top;
    const txHeight = Math.max(120, Math.min(totalHeight - 130, totalHeight - pointerY));
    el.txPane.style.flex = `0 0 ${txHeight}px`;
    scheduleActiveRender(false);
  });

  window.addEventListener("mouseup", () => {
    if (isDraggingSidebar) {
      isDraggingSidebar = false;
      if (el.sidebarSplitter) el.sidebarSplitter.classList.remove("dragging");
      document.body.style.cursor = "";
    }
    if (isDraggingSplitter) {
      isDraggingSplitter = false;
      document.body.style.cursor = "";
    }
  });

  // ==================== UI EVENT BINDINGS ====================
  el.btnPortToggle.addEventListener("click", togglePortForActiveSession);
  el.btnRefreshPorts.addEventListener("click", refreshPorts);
  if (el.btnSend) {
    el.btnSend.addEventListener("click", () => triggerSessionSend(getActiveSession()));
  }
  if (el.btnTxSendPlane) {
    el.btnTxSendPlane.addEventListener("click", () => triggerSessionSend(getActiveSession()));
  }
  el.btnClearRx.addEventListener("click", clearRx);
  el.btnClearTx.addEventListener("click", clearTx);
  el.btnResetCounts.addEventListener("click", resetCounters);

  el.selPort.addEventListener("change", () => {
    const sess = getActiveSession();
    if (sess && !sess.isOpen) {
      sess.portName = el.selPort.value;
      renderSessionTabs();
    }
  });

  el.selConnType.addEventListener("change", () => {
    const sess = getActiveSession();
    if (sess && !sess.isOpen) {
      sess.connType = el.selConnType.value;
      if (sess.connType === "pcan") {
        if ((!sess.fixedMap || sess.fixedMap.size === 0) && sess.rxBytes.length === 0) {
          setRxMode("fixed");
        }
        refreshPcanChannels();
      }
      updatePortUi(sess);
      renderSessionTabs();
    }
  });

  el.inpTcpClientHost.addEventListener("input", () => {
    const sess = getActiveSession();
    if (sess && !sess.isOpen) {
      sess.tcpClientHost = el.inpTcpClientHost.value.trim();
      renderSessionTabs();
    }
  });
  el.inpTcpClientPort.addEventListener("input", () => {
    const sess = getActiveSession();
    if (sess && !sess.isOpen) {
      sess.tcpClientPort = parseInt(el.inpTcpClientPort.value, 10) || 8080;
      renderSessionTabs();
    }
  });

  el.inpTcpServerPort.addEventListener("input", () => {
    const sess = getActiveSession();
    if (sess && !sess.isOpen) {
      sess.tcpServerPort = parseInt(el.inpTcpServerPort.value, 10) || 8080;
      renderSessionTabs();
    }
  });
  el.inpTcpServerHost.addEventListener("input", () => {
    const sess = getActiveSession();
    if (sess && !sess.isOpen) {
      sess.tcpServerHost = el.inpTcpServerHost.value.trim();
    }
  });

  el.inpUdpLocalPort.addEventListener("input", () => {
    const sess = getActiveSession();
    if (sess && !sess.isOpen) {
      sess.udpLocalPort = parseInt(el.inpUdpLocalPort.value, 10) || 0;
      renderSessionTabs();
    }
  });

  function syncUdpTargetIfOpen() {
    const sess = getActiveSession();
    if (sess && sess.isOpen && sess.connType === "udp") {
      sess.udpHost = el.inpUdpHost.value.trim() || "127.0.0.1";
      sess.udpPort = parseInt(el.inpUdpPort.value, 10) || 8080;
      const invoke = getTauriInvoke();
      if (invoke) {
        invoke("set_udp_target", {
          sessionId: sess.id,
          remoteHost: sess.udpHost,
          remotePort: sess.udpPort,
        }).catch(console.error);
      }
    }
  }

  el.inpUdpHost.addEventListener("input", () => {
    const sess = getActiveSession();
    if (sess) {
      sess.udpHost = el.inpUdpHost.value.trim();
      syncUdpTargetIfOpen();
    }
  });
  el.inpUdpPort.addEventListener("input", () => {
    const sess = getActiveSession();
    if (sess) {
      sess.udpPort = parseInt(el.inpUdpPort.value, 10) || 8080;
      syncUdpTargetIfOpen();
    }
  });

  function syncBaudMenuHighlight() {
    const val = el.inpBaud.value.trim();
    el.baudMenu.querySelectorAll("button[data-baud]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.baud === val);
    });
  }

  el.btnBaudDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
    const sess = getActiveSession();
    if (sess && sess.isOpen) return;
    syncBaudMenuHighlight();
    el.baudMenu.classList.toggle("hidden");
  });

  el.baudMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-baud]");
    if (!btn) return;
    el.inpBaud.value = btn.dataset.baud;
    const sess = getActiveSession();
    if (sess && !sess.isOpen) {
      sess.baudRate = btn.dataset.baud;
    }
    syncBaudMenuHighlight();
    el.baudMenu.classList.add("hidden");
  });

  el.inpBaud.addEventListener("input", () => {
    const sess = getActiveSession();
    if (sess && !sess.isOpen) {
      sess.baudRate = el.inpBaud.value.trim();
    }
    syncBaudMenuHighlight();
  });

  window.addEventListener("click", (e) => {
    if (el.baudCombo && !el.baudCombo.contains(e.target)) {
      el.baudMenu.classList.add("hidden");
    }
    if (el.scpiCombo && !el.scpiCombo.contains(e.target)) {
      el.scpiMenu.classList.add("hidden");
    }
  });

  el.rxModeGroup.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    setRxMode(btn.dataset.mode);
  });

  function setRxMode(mode) {
    const sess = getActiveSession();
    if (!sess) return;
    sess.rxMode = mode;
    el.rxModeGroup.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    renderRxView(sess, true);
  }

  el.chkFrameBreak.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    sess.frameBreakEnabled = el.chkFrameBreak.checked;
    recalculateFramesForSession(sess);
    renderRxView(sess, false);
  });

  el.selFrameRule.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    const prevRule = sess.frameRule;
    sess.frameRule = el.selFrameRule.value;
    if (sess.frameRule === "fixed_len" && (!sess.frameMaxLen || sess.frameMaxLen <= 0)) {
      sess.frameMaxLen = 16;
    } else if (prevRule === "fixed_len" && sess.frameRule !== "fixed_len") {
      sess.frameMaxLen = 0;
    }
    updateFrameRuleUi(sess);
    recalculateFramesForSession(sess);
    renderRxView(sess, false);
  });

  el.inpFrameMaxlen.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    const minVal = sess.frameRule === "fixed_len" ? 1 : 0;
    const val = Math.max(minVal, parseInt(el.inpFrameMaxlen.value, 10) || minVal);
    el.inpFrameMaxlen.value = val;
    sess.frameMaxLen = val;
    recalculateFramesForSession(sess);
    renderRxView(sess, false);
  });

  el.inpFrameDelim.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    const { bytes } = parseHexInput(el.inpFrameDelim.value);
    sess.frameDelimHex = bytesToHexString(bytes, false) || "0D 0A";
    el.inpFrameDelim.value = sess.frameDelimHex;
    recalculateFramesForSession(sess);
    renderRxView(sess, false);
  });

  el.selFrameLayout.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    sess.frameLayout = el.selFrameLayout.value;
    rebuildRowSlicesForSession(sess);
    renderRxView(sess, false);
  });

  el.chkShowTimestamp.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    sess.showTimestamp = el.chkShowTimestamp.checked;
    el.rxViewport.classList.toggle("show-ts", sess.showTimestamp);
    renderRxView(sess, false);
  });

  el.chkShowTxInline.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    sess.showTxInline = el.chkShowTxInline.checked;
    recalculateFramesForSession(sess);
    renderRxView(sess, false);
  });

  el.inpFrameTimeout.addEventListener("change", () => {
    const sess = getActiveSession();
    if (!sess) return;
    const val = Math.max(1, parseInt(el.inpFrameTimeout.value, 10) || 20);
    el.inpFrameTimeout.value = val;
    sess.frameTimeoutMs = val;
    recalculateFramesForSession(sess);
    renderRxView(sess, false);
  });

  el.txTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const sess = getActiveSession();
      if (!sess) return;
      sess.txTab = tab.dataset.txtab;
      el.txTabs.forEach((t) => t.classList.toggle("active", t === tab));
      el.txTabEditor.classList.toggle("hidden", sess.txTab !== "editor");
      el.txTabDatalist.classList.toggle("hidden", sess.txTab !== "datalist");
    });
  });

  el.btnScpiMenu.addEventListener("click", (e) => {
    e.stopPropagation();
    if (el.baudMenu) el.baudMenu.classList.add("hidden");
    el.scpiMenu.classList.toggle("hidden");
  });

  el.scpiMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-scpi]");
    if (!btn) return;
    const scpiCmd = btn.dataset.scpi;
    const sess = getActiveSession();
    if (sess) {
      setTxEditorBytesForSession(sess, utf8TextToBytes(scpiCmd));
      el.chkTxCrlf.checked = true;
      sess.txCrlf = true;
      setSessionStatus(sess, `已填入 SCPI 指令: ${scpiCmd} (已自動勾選附加 \\r\\n)`);
    }
    el.scpiMenu.classList.add("hidden");
  });

  el.btnLoadScpiTemplate.addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess) return;
    const scpiTemplates = [
      { enabled: true, name: "查詢設備型號 (IDN)", format: "ASCII", payload: "*IDN?\\r\\n" },
      { enabled: true, name: "清除錯誤暫存器 (CLS)", format: "ASCII", payload: "*CLS\\r\\n" },
      { enabled: true, name: "查詢系統錯誤 (ERR)", format: "ASCII", payload: ":SYST:ERR?\\r\\n" },
      { enabled: true, name: "量測即時電壓 (Volt)", format: "ASCII", payload: ":MEAS:VOLT?\\r\\n" },
      { enabled: true, name: "量測即時電流 (Curr)", format: "ASCII", payload: ":MEAS:CURR?\\r\\n" },
      { enabled: false, name: "量測即時功率 (Power)", format: "ASCII", payload: ":MEAS:POW?\\r\\n" },
      { enabled: false, name: "查詢輸出狀態 (Output)", format: "ASCII", payload: ":OUTP?\\r\\n" },
      { enabled: false, name: "設備復位 (Reset)", format: "ASCII", payload: "*RST\\r\\n" },
    ];

    if (sess.datalist && sess.datalist.length > 0) {
      const confirmReplace = confirm("是否載入標準 SCPI 儀器指令範本？\n\n點擊「確定」將替換為 SCPI 標準範本；\n點擊「取消」則將 SCPI 範本追加至清單後方。");
      if (confirmReplace) {
        sess.datalist = scpiTemplates;
      } else {
        sess.datalist.push(...scpiTemplates);
      }
    } else {
      sess.datalist = scpiTemplates;
    }

    renderDataList(sess);
    setSessionStatus(sess, `已載入常用 SCPI 儀器指令範本至快捷發送列表`);
  });

  function parseExCommandIni(text) {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (i === 0 && trimmed === "Serial Assistant ExCommand") continue;

      const firstComma = rawLine.indexOf(",");
      if (firstComma === -1) continue;
      const secondComma = rawLine.indexOf(",", firstComma + 1);
      if (secondComma === -1) continue;

      const isHex = rawLine.slice(0, firstComma).trim().toLowerCase() === "true";
      const addNewline = rawLine.slice(firstComma + 1, secondComma).trim().toLowerCase() === "true";
      const rest = rawLine.slice(secondComma + 1);

      const notesMarker = "((:Notes:))";
      const notesIdx = rest.indexOf(notesMarker);
      let payload = notesIdx >= 0 ? rest.slice(0, notesIdx) : rest;
      const note = notesIdx >= 0 ? rest.slice(notesIdx + notesMarker.length).trim() : "";

      // Skip completely empty placeholder rows (e.g. "False,False,")
      if (payload.trim().length === 0 && note.length === 0) continue;

      const format = isHex ? "HEX" : "ASCII";
      if (format === "HEX") {
        payload = payload.trim();
        if (addNewline && payload.length > 0 && !/0d\s+0a$/i.test(payload)) {
          payload = `${payload} 0D 0A`;
        }
      } else {
        if (addNewline && payload.length > 0 && !payload.endsWith("\\r\\n") && !payload.endsWith("\\n")) {
          payload = `${payload}\\r\\n`;
        }
      }

      rows.push({
        enabled: payload.trim().length > 0,
        name: note,
        format,
        payload,
      });
    }
    return rows;
  }

  function serializeExCommandIni(rows) {
    const lines = ["Serial Assistant ExCommand"];
    for (const row of rows || []) {
      const isHex = row.format === "HEX";
      let payload = row.payload ?? "";
      let addNewline = false;

      if (isHex) {
        payload = payload.trim();
      } else if (payload.endsWith("\\r\\n")) {
        addNewline = true;
        payload = payload.slice(0, -4);
      }

      const notePart = row.name && row.name.trim().length > 0 ? `((:Notes:))${row.name.trim()}` : "";
      lines.push(`${isHex ? "True" : "False"},${addNewline ? "True" : "False"},${payload}${notePart}`);
    }
    return lines.join("\r\n") + "\r\n";
  }

  el.btnImportDatalist.addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess) return;
    el.inpImportDatalist.value = "";
    el.inpImportDatalist.click();
  });

  el.inpImportDatalist.addEventListener("change", async (e) => {
    const sess = getActiveSession();
    const file = e.target.files && e.target.files[0];
    if (!sess || !file) return;
    try {
      const text = await file.text();
      const imported = parseExCommandIni(text);
      if (imported.length === 0) {
        setSessionStatus(sess, `匯入失敗："${file.name}" 中沒有可解析的指令資料`);
        return;
      }
      sess.datalist = imported;
      sess.datalistCursor = 0;
      renderDataList(sess);
      setSessionStatus(sess, `已從 "${file.name}" 匯入 ${imported.length} 筆快捷發送指令`);
    } catch (err) {
      setSessionStatus(sess, `匯入失敗：${err && err.message ? err.message : err}`);
    }
  });

  el.btnExportDatalist.addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess || !sess.datalist || sess.datalist.length === 0) {
      alert("目前快捷發送清單沒有指令可匯出。");
      return;
    }
    const iniText = serializeExCommandIni(sess.datalist);
    const blob = new Blob([iniText], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `accessport_commands_${Date.now()}.ini`;
    a.click();
    setSessionStatus(sess, `已匯出 ${sess.datalist.length} 筆快捷發送指令 (.ini)`);
  });

  el.btnCopyRxHex.addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess) return;
    navigator.clipboard.writeText(bytesToHexString(sess.rxBytes, false));
    setSessionStatus(sess, "已複製接收區十六進位內容至剪貼簿");
  });

  function exportRxLogWithTimestamp(sess) {
    if (!sess) return;
    const hasFixed = sess.fixedMap && sess.fixedMap.size > 0;
    const hasFrames = sess.rxFrames && sess.rxFrames.length > 0;
    const hasPackets = sess.packets && sess.packets.length > 0;
    if (!hasFixed && !hasFrames && !hasPackets) {
      setSessionStatus(sess, "目前接收區無數據可儲存");
      return;
    }

    const lines = [];
    if (sess.rxMode === "fixed" && hasFixed) {
      lines.push(`# PortAssist Fixed Table - ${getConnSummary(sess)} - Exported at ${new Date().toLocaleString()}`);
      lines.push("# ID         | Type | DLC | Data (Hex)               | ASCII    | Count | Cycle (ms) | Time");
      lines.push("");
      const sorted = Array.from(sess.fixedMap.values()).sort((a, b) => (a.rawId ?? 0) - (b.rawId ?? 0));
      for (const item of sorted) {
        const hexStr = bytesToHexString(item.data, false);
        const asciiStr = item.data.map(toPrintableAscii).join("");
        const cycStr = item.cycleMs > 0 ? item.cycleMs.toFixed(1) : "-";
        lines.push(
          `${item.idStr.padEnd(10)} | ${item.typeStr.padEnd(4)} | ${String(item.dlc).padEnd(3)} | ${hexStr.padEnd(24)} | ${asciiStr.padEnd(8)} | ${String(item.count).padStart(5)} | ${cycStr.padStart(10)} | ${item.timeStr}`
        );
      }
    } else {
      lines.push(`# PortAssist Log - ${getConnSummary(sess)} - Exported at ${new Date().toLocaleString()}`);
      lines.push("# Format: [Time] [Dir] (Length) Hex | ASCII");
      lines.push("");

      if (hasFrames) {
        for (let i = 0; i < sess.rxFrames.length; i++) {
          const f = sess.rxFrames[i];
          const slice = sess.viewBytes.slice(f.startIdx, f.startIdx + f.length);
          const hexStr = bytesToHexString(slice, false);
          const asciiStr = slice.map(toPrintableAscii).join("");
          const dirTag = (f.dir || "RX").padEnd(2, " ");
          const lenStr = String(f.length).padStart(3, " ");
          const pktMeta = sess.packets[i] && sess.packets[i].canMeta ? `[${sess.packets[i].canMeta}] ` : "";
          lines.push(`[${f.timeStr}] [${dirTag}] (${lenStr} B) ${pktMeta}${hexStr}  | ${asciiStr}`);
        }
      } else {
        for (let i = 0; i < sess.packets.length; i++) {
          const p = sess.packets[i];
          const bytes = p.previewBytes || [];
          const hexStr = bytesToHexString(bytes, false);
          const asciiStr = bytes.map(toPrintableAscii).join("");
          const dirTag = (p.dir || "RX").padEnd(2, " ");
          const lenStr = String(p.byteLength ?? bytes.length).padStart(3, " ");
          const canTag = p.canMeta ? `[${p.canMeta}] ` : "";
          lines.push(`[${p.time}] [${dirTag}] (${lenStr} B) ${canTag}${hexStr}  | ${asciiStr}`);
        }
      }
    }

    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    const safeName = getConnSummary(sess).replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `accessport_${safeName}_${stamp}.txt`;

    const blob = new Blob([lines.join("\r\n") + "\r\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSessionStatus(sess, `已儲存接收日誌 "${fileName}" (${hasFrames ? sess.rxFrames.length : sess.packets.length} 筆)`);
  }

  if (el.btnSaveRxLog) {
    el.btnSaveRxLog.addEventListener("click", () => {
      exportRxLogWithTimestamp(getActiveSession());
    });
  }

  el.btnCopyRxText.addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess) return;
    navigator.clipboard.writeText(bytesToUtf8Text(sess.rxBytes));
    setSessionStatus(sess, "已複製接收區文字內容至剪貼簿");
  });

  document.getElementById("menu-new-session").addEventListener("click", addNewSession);
  document.getElementById("menu-close-session").addEventListener("click", () => {
    const sess = getActiveSession();
    if (sess) closeSessionTab(sess.id);
  });
  document.querySelectorAll("[data-rx-mode]").forEach((btn) => {
    btn.addEventListener("click", () => setRxMode(btn.dataset.rxMode));
  });
  document.getElementById("menu-toggle-packets").addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess) return;
    setRxMode(sess.rxMode === "packets" ? "dual" : "packets");
  });
  document.getElementById("menu-toggle-port").addEventListener("click", togglePortForActiveSession);
  document.getElementById("menu-send-now").addEventListener("click", () => {
    triggerSessionSend(getActiveSession());
  });
  document.getElementById("menu-clear-all").addEventListener("click", () => {
    clearRx();
    clearTx();
  });
  document.getElementById("menu-reset-counters").addEventListener("click", resetCounters);
  document.getElementById("menu-about").addEventListener("click", () => {
    alert(
      "PortAssist\n\n" +
      "跨平台串口 (RS232/422/485) + TCP/UDP + PCAN 綜合通訊調試助手。\n" +
      "核心架構：Rust (serialport / socket / libloading PCAN-Basic) + Tauri 2 虛擬捲動引擎\n" +
      "支援高速大數據量零延遲渲染、多通訊分頁、自訂波特率、超時斷幀、定時發送與毫秒時間戳記。"
    );
  });

  document.getElementById("menu-save-rx-txt").addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess || sess.rxBytes.length === 0) {
      alert("目前分頁接收區無數據可匯出。");
      return;
    }
    const lines = ["Offset    00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F  ASCII", "-".repeat(76)];
    for (let i = 0; i < sess.rxBytes.length; i += 16) {
      const slice = sess.rxBytes.slice(i, i + 16);
      const leftHex = slice.slice(0, 8).map(toHex2).join(" ").padEnd(23, " ");
      const rightHex = slice.slice(8, 16).map(toHex2).join(" ").padEnd(23, " ");
      const ascii = slice.map(toPrintableAscii).join("");
      lines.push(`${toHex8(i)}  ${leftHex}  ${rightHex}  ${ascii}`);
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `accessport_${sess.portName}_rx_${Date.now()}.txt`;
    a.click();
  });

  document.getElementById("menu-save-rx-bin").addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess || sess.rxBytes.length === 0) {
      alert("目前分頁接收區無數據可匯出。");
      return;
    }
    const blob = new Blob([new Uint8Array(sess.rxBytes)], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `accessport_${sess.portName}_rx_${Date.now()}.bin`;
    a.click();
  });

  document.getElementById("menu-load-tx").addEventListener("click", () => {
    const sess = getActiveSession();
    if (!sess) return;
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      setTxEditorBytesForSession(sess, new Uint8Array(buf));
      setSessionStatus(sess, `已載入檔案 "${file.name}" (${buf.byteLength} Bytes) 至發送區`);
    };
    input.click();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "F2") {
      e.preventDefault();
      togglePortForActiveSession();
    } else if (e.key === "F5") {
      e.preventDefault();
      triggerSessionSend(getActiveSession());
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      triggerSessionSend(getActiveSession());
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
      e.preventDefault();
      addNewSession();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
      e.preventDefault();
      const sess = getActiveSession();
      if (sess && sessions.length > 1) {
        closeSessionTab(sess.id);
      }
    }
  });

  async function refreshPcanChannels() {
    const invoke = getTauriInvoke();
    if (!invoke || !el.selPcanChannel) return;
    const prev = el.selPcanChannel.value;
    try {
      const channels = await invoke("list_pcan_channels");
      if (Array.isArray(channels) && channels.length > 0) {
        el.selPcanChannel.innerHTML = "";
        channels.forEach((ch) => {
          const opt = document.createElement("option");
          opt.value = ch.name;
          opt.textContent = ch.label;
          el.selPcanChannel.appendChild(opt);
        });
        if (channels.some((c) => c.name === prev)) {
          el.selPcanChannel.value = prev;
        }
      }
    } catch (err) {
      const sess = getActiveSession();
      if (sess) setSessionStatus(sess, String(err));
    }
  }

  if (el.btnRefreshPcan) {
    el.btnRefreshPcan.addEventListener("click", refreshPcanChannels);
  }

  function onReceivePcanBatchForSession(sessionId, batchNowMs, frames) {
    const sess = getSessionById(sessionId);
    if (!sess || !frames || frames.length === 0) return;

    const nowWallStr = formatTimestamp();
    const prevLatestFrame = sess.rxFrames.length > 0 ? sess.rxFrames[sess.rxFrames.length - 1] : null;
    const wasLatestClosed = prevLatestFrame ? Boolean(prevLatestFrame.closed) : true;
    const prevLatestRowCount = sess.rowSlices.length;

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const dataBytes = Array.isArray(f.data) ? f.data : [];
      const idHex = f.extended
        ? f.id.toString(16).toUpperCase().padStart(8, "0")
        : f.id.toString(16).toUpperCase().padStart(3, "0");
      const kindTag = f.rtr ? "RTR" : f.extended ? "Ext" : "Std";

      const chunk = {
        perfMs: f.perfMs ?? batchNowMs,
        timeStr: nowWallStr,
        dir: "RX",
        bytes: dataBytes,
        canMeta: `ID:0x${idHex} ${kindTag} DLC:${f.dlc}`,
      };
      if (dataBytes.length > 0) {
        sess.rxRawChunks.push(chunk);
        appendChunkIncremental(sess, chunk);
        if (sess.rxFrames.length > 0) {
          sess.rxFrames[sess.rxFrames.length - 1].closed = true;
        }
      } else {
        sess.rxPktCount += 1;
        sess.packets.push({
          time: nowWallStr,
          dir: "RX",
          previewBytes: [],
          byteLength: 0,
          lastPerfMs: chunk.perfMs,
          closed: true,
          canMeta: chunk.canMeta,
        });
      }
      if (sess.packets.length > 0) {
        sess.packets[sess.packets.length - 1].canMeta = chunk.canMeta;
      }

      // Maintain PCAN Fixed In-Place Map (PCAN-View Receive List)
      if (!sess.fixedMap) sess.fixedMap = new Map();
      const fixedKey = `${f.extended ? "E" : "S"}_${idHex}_${f.rtr ? "R" : "D"}`;
      let fixedItem = sess.fixedMap.get(fixedKey);
      const nowPerf = f.perfMs ?? batchNowMs;
      if (!fixedItem) {
        fixedItem = {
          key: fixedKey,
          idStr: `0x${idHex}`,
          rawId: f.id,
          extended: f.extended,
          rtr: f.rtr,
          typeStr: kindTag,
          dlc: f.dlc,
          data: [...dataBytes],
          prevData: [],
          count: 1,
          lastPerfMs: nowPerf,
          cycleMs: 0,
          timeStr: nowWallStr,
        };
        sess.fixedMap.set(fixedKey, fixedItem);
      } else {
        fixedItem.count += 1;
        fixedItem.cycleMs = Math.max(0, nowPerf - fixedItem.lastPerfMs);
        fixedItem.lastPerfMs = nowPerf;
        fixedItem.timeStr = nowWallStr;
        fixedItem.dlc = f.dlc;
        fixedItem.prevData = fixedItem.data;
        fixedItem.data = [...dataBytes];
      }
    }

    if (sess.id === activeSessionId) {
      scheduleActiveRender(true);
    }
  }

  if (el.btnRxPause) {
    el.btnRxPause.addEventListener("click", () => {
      const sess = getActiveSession();
      if (!sess) return;
      sess.rxPaused = !sess.rxPaused;
      updateRxPauseUi(sess);
      if (sess.rxPaused) {
        setSessionStatus(sess, "已暫停接收畫面渲染（背景持續接收中）");
      } else {
        setSessionStatus(sess, "已恢復接收畫面渲染");
        scheduleActiveRender(true);
      }
    });
  }

  // ==================== THEME (LIGHT / DARK) ====================
  function applyTheme(theme) {
    const isDark = theme === "dark";
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    if (el.btnThemeToggle) {
      el.btnThemeToggle.textContent = isDark ? "☀️ 明亮" : "🌙 深色";
    }
    try {
      localStorage.setItem("accessport_theme", isDark ? "dark" : "light");
    } catch (_) {}
  }

  let savedTheme = "light";
  try {
    savedTheme = localStorage.getItem("accessport_theme") || "light";
  } catch (_) {}
  applyTheme(savedTheme);

  if (el.btnThemeToggle) {
    el.btnThemeToggle.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      applyTheme(current === "dark" ? "light" : "dark");
    });
  }

  // ==================== FONT SIZE CUSTOMIZATION ====================
  function applyFontSize(sizePx) {
    const size = Math.max(12, Math.min(16, parseInt(sizePx, 10) || 12));
    const monoSize = size + 0.5;
    ROW_HEIGHT = Math.round(size * 1.65);
    currentHbWidth = Math.max(22, Math.round(size * 1.95));
    currentAbWidth = Math.max(8, Math.round(size * 0.75));

    const root = document.documentElement;
    root.style.setProperty("--ui-font-size", `${size}px`);
    root.style.setProperty("--mono-font-size", `${monoSize}px`);
    root.style.setProperty("--rx-row-height", `${ROW_HEIGHT}px`);
    root.style.setProperty("--hb-width", `${currentHbWidth}px`);
    root.style.setProperty("--ab-width", `${currentAbWidth}px`);

    if (el.menuFontBtns) {
      el.menuFontBtns.forEach((btn) => {
        const bSize = parseInt(btn.dataset.fontSize, 10);
        const isActive = bSize === size;
        btn.classList.toggle("active", isActive);
        const baseText = btn.textContent.replace(/^✓\s*/, "");
        btn.textContent = isActive ? `✓ ${baseText}` : baseText;
      });
    }

    try {
      localStorage.setItem("accessport_font_size", String(size));
    } catch (_) {}

    const sess = getActiveSession();
    if (sess) {
      renderRxView(sess, false);
    }
  }

  let savedFontSize = 12;
  try {
    savedFontSize = parseInt(localStorage.getItem("accessport_font_size"), 10) || 12;
  } catch (_) {}
  applyFontSize(savedFontSize);

  if (el.menuFontBtns) {
    el.menuFontBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        applyFontSize(btn.dataset.fontSize);
      });
    });
  }

  // ==================== TAURI BACKEND EVENT LISTENERS ====================
  async function initBackendListeners() {
    const listen = getTauriListen();
    if (!listen) return;

    await listen("serial-rx-batch", (event) => {
      const p = event && event.payload;
      if (p && p.sessionId && Array.isArray(p.chunks)) {
        onReceiveBatchForSession(p.sessionId, p.batchNowMs, p.chunks);
      }
    });

    await listen("pcan-rx-batch", (event) => {
      const p = event && event.payload;
      if (p && p.sessionId && Array.isArray(p.frames)) {
        onReceivePcanBatchForSession(p.sessionId, p.batchNowMs, p.frames);
      }
    });

    await listen("serial-modem-status", (event) => {
      const p = event && event.payload;
      if (p && p.sessionId) {
        const sess = getSessionById(p.sessionId);
        if (!sess) return;
        sess.cts = !!p.cts;
        sess.dsr = !!p.dsr;
        sess.cd = !!p.cd;
        sess.ri = !!p.ri;
        if (sess.id === activeSessionId) {
          updateModemLeds(sess);
        }
      }
    });

    await listen("net-server-status", (event) => {
      const p = event && event.payload;
      if (p && p.sessionId) {
        const sess = getSessionById(p.sessionId);
        if (sess) {
          sess.tcpServerClients = p.clientCount || 0;
          if (sess.id === activeSessionId) {
            el.netServerClientsPill.textContent = `${sess.tcpServerClients} 客戶端`;
          }
          if (p.msg) {
            setSessionStatus(sess, p.msg);
          }
        }
      }
    });

    await listen("serial-error", (event) => {
      const p = event && event.payload;
      if (p && p.sessionId) {
        const sess = getSessionById(p.sessionId);
        if (sess) {
          setSessionStatus(sess, `通訊錯誤: ${p.error}`);
        }
      }
    });

    await listen("external-tx", (event) => {
      const p = event && event.payload;
      if (p && Array.isArray(p.data)) {
        recordExternalTx(p.sessionId, p.data);
      }
    });

    await listen("external-pcan-tx", (event) => {
      const p = event && event.payload;
      if (p && p.frame) {
        recordExternalPcanTx(p.sessionId, p.frame);
      }
    });

    await listen("mcp-session-opened", (event) => {
      const p = event && event.payload;
      if (p) handleMcpSessionOpened(p);
    });

    await listen("mcp-session-closed", (event) => {
      const p = event && event.payload;
      if (p) handleMcpSessionClosed(p);
    });
  }

  function recordExternalTx(sessionId, bytes) {
    const sess = getSessionById(sessionId) || (sessions.length > 0 ? sessions[0] : null);
    if (!sess) return;
    sess.txByteCount += bytes.length;
    sess.txPktCount += 1;
    const txChunk = {
      perfMs: performance.now(),
      timeStr: formatTimestamp(),
      dir: "TX",
      bytes: bytes,
    };
    sess.rxRawChunks.push(txChunk);
    appendChunkIncremental(sess, txChunk);
    if (sess.id === activeSessionId) {
      scheduleActiveRender(true);
    }
    setSessionStatus(sess, `[MCP] 已發送 ${bytes.length} Bytes`);
  }

  function recordExternalPcanTx(sessionId, frame) {
    const sess = getSessionById(sessionId) || (sessions.length > 0 ? sessions[0] : null);
    if (!sess) return;
    const bytes = Array.isArray(frame.data) ? frame.data : [];
    sess.txByteCount += bytes.length;
    sess.txPktCount += 1;
    const idHex = frame.extended
      ? frame.id.toString(16).toUpperCase().padStart(8, "0")
      : frame.id.toString(16).toUpperCase().padStart(3, "0");
    const kindTag = frame.rtr ? "RTR" : frame.extended ? "Ext" : "Std";
    const canMeta = `ID:0x${idHex} ${kindTag} DLC:${frame.dlc ?? bytes.length}`;

    const txChunk = {
      perfMs: performance.now(),
      timeStr: formatTimestamp(),
      dir: "TX",
      bytes: bytes,
      canMeta: canMeta,
    };
    sess.rxRawChunks.push(txChunk);
    appendChunkIncremental(sess, txChunk);
    if (sess.rxFrames.length > 0) {
      sess.rxFrames[sess.rxFrames.length - 1].closed = true;
      sess.rxFrames[sess.rxFrames.length - 1].canMeta = canMeta;
    }
    if (sess.packets.length > 0) {
      sess.packets[sess.packets.length - 1].canMeta = canMeta;
    }
    if (sess.id === activeSessionId) {
      scheduleActiveRender(true);
    }
    setSessionStatus(sess, `[MCP] 已發送 CAN 幀 ${idHex} (${kindTag})`);
  }

  function handleMcpSessionOpened(p) {
    if (!p) return;
    const sess = getSessionById(p.sessionId) || (sessions.length > 0 ? sessions[0] : null);
    if (!sess) return;
    sess.isOpen = true;
    sess.portName = p.portName || sess.portName;
    if (p.connType) sess.connType = p.connType;
    if (p.baudRate) {
      if (p.connType === "pcan") sess.pcanBaud = p.baudRate;
      else sess.baudRate = p.baudRate;
    }
    if (sess.id === activeSessionId) {
      syncUiForActiveSession();
    }
    setSessionStatus(sess, `[MCP] 已連線 ${sess.portName}`);
  }

  function handleMcpSessionClosed(p) {
    if (!p) return;
    const sess = getSessionById(p.sessionId) || (sessions.length > 0 ? sessions[0] : null);
    if (!sess) return;
    sess.isOpen = false;
    if (sess.id === activeSessionId) {
      syncUiForActiveSession();
    }
    setSessionStatus(sess, `[MCP] 已中斷連線`);
  }

  // ==================== DETACH TAB TO NEW WINDOW ====================
  function serializeSessionForDetach(sess) {
    return JSON.stringify({
      id: sess.id,
      seq: sess.seq,
      customTitle: sess.customTitle,
      isOpen: sess.isOpen,
      connType: sess.connType,
      portName: sess.portName,
      baudRate: sess.baudRate,
      parity: sess.parity,
      dataBits: sess.dataBits,
      stopBits: sess.stopBits,
      flowControl: sess.flowControl,
      tcpClientHost: sess.tcpClientHost,
      tcpClientPort: sess.tcpClientPort,
      tcpServerHost: sess.tcpServerHost,
      tcpServerPort: sess.tcpServerPort,
      tcpServerClients: sess.tcpServerClients,
      udpLocalPort: sess.udpLocalPort,
      udpHost: sess.udpHost,
      udpPort: sess.udpPort,
      pcanChannel: sess.pcanChannel,
      pcanBaud: sess.pcanBaud,
      canTxId: sess.canTxId,
      canTxType: sess.canTxType,
      rxMode: sess.rxMode,
      txTab: sess.txTab,
      rxBytes: sess.rxBytes,
      viewBytes: sess.viewBytes,
      rxRawChunks: sess.rxRawChunks,
      rxByteFrameIds: sess.rxByteFrameIds,
      rxFrames: sess.rxFrames.map((f) => ({ ...f })),
      frameBreakEnabled: sess.frameBreakEnabled,
      frameRule: sess.frameRule,
      frameTimeoutMs: sess.frameTimeoutMs,
      frameMaxLen: sess.frameMaxLen,
      frameDelimHex: sess.frameDelimHex,
      frameLayout: sess.frameLayout,
      showTimestamp: sess.showTimestamp,
      showTxInline: sess.showTxInline,
      rxPaused: sess.rxPaused,
      txBytes: sess.txBytes,
      txHexText: sess.txHexText,
      txAsciiText: sess.txAsciiText,
      txCrlf: sess.txCrlf,
      packets: sess.packets,
      rxPktCount: sess.rxPktCount,
      txByteCount: sess.txByteCount,
      txPktCount: sess.txPktCount,
      datalist: sess.datalist,
      datalistCursor: sess.datalistCursor,
      dtr: sess.dtr,
      rts: sess.rts,
      cts: sess.cts,
      dsr: sess.dsr,
      cd: sess.cd,
      ri: sess.ri,
      statusText: sess.statusText,
      autoSendInterval: sess.autoSendInterval,
      autoSendMaxCount: sess.autoSendMaxCount,
    });
  }

  async function detachSessionToWindow(sess, screenX, screenY) {
    if (!sess || sessions.length <= 1) return;
    const invoke = getTauriInvoke();
    if (!invoke) return;

    if (sess.id === activeSessionId) {
      saveActiveUiToSession();
    }
    if (sess.autoSendEnabled) {
      stopAutoSendForSession(sess);
    }

    const label = `win_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const title = `PortAssist - ${formatSessionTabTitle(sess)}`;
    const payloadJson = serializeSessionForDetach(sess);

    try {
      await invoke("detach_tab_window", {
        label,
        title,
        payloadJson,
        x: typeof screenX === "number" ? screenX : null,
        y: typeof screenY === "number" ? screenY : null,
      });

      const idx = sessions.findIndex((s) => s.id === sess.id);
      if (idx !== -1) {
        sessions.splice(idx, 1);
        if (sess.id === activeSessionId && sessions.length > 0) {
          const nextSess = sessions[Math.min(idx, sessions.length - 1)];
          activeSessionId = nextSess.id;
          syncSessionToDom(nextSess);
        }
        renderSessionTabs();
      }
    } catch (err) {
      setSessionStatus(sess, `獨立視窗開啟失敗: ${err}`);
    }
  }

  // ==================== INITIALIZATION ====================
  async function init() {
    await refreshPorts();
    refreshPcanChannels();

    const detachedKey = new URLSearchParams(window.location.search).get("detached");
    const invoke = getTauriInvoke();
    let restoredSession = null;

    if (detachedKey && invoke) {
      try {
        const json = await invoke("take_detached_session", { key: detachedKey });
        if (json) {
          const parsed = JSON.parse(json);
          const base = createSessionObject(parsed.portName || "LOOPBACK");
          restoredSession = Object.assign(base, parsed, {
            rowSlices: [],
            autoSendEnabled: false,
            autoSendTimer: null,
          });
          rebuildRowSlicesForSession(restoredSession);
        }
      } catch (_) {}
    }

    const firstSession =
      restoredSession ||
      createSessionObject(availablePortsCache.length > 0 ? availablePortsCache[0].name : "LOOPBACK");
    sessions.push(firstSession);
    activeSessionId = firstSession.id;

    renderSessionTabs();
    syncSessionToDom(firstSession);
    await initBackendListeners();
  }

  init();
})();
