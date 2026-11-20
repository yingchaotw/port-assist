(function (global) {
  const codec =
    (global.PortAssist && global.PortAssist.codec) ||
    (typeof require !== "undefined" ? require("./codec") : null);

  function createSessionState(seq, preferredPort) {
    const id = `session-${seq}`;
    const initialBytes = codec.utf8TextToBytes("AT+GMR\r\n");

    return {
      id,
      seq,
      customTitle: "",
      isOpen: false,
      connType: "serial", // 'serial' | 'tcp_client' | 'tcp_server' | 'udp' | 'pcan'
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

      rxMode: "dual", // 'dual' | 'hex' | 'text' | 'packets' | 'fixed'
      txTab: "editor", // 'editor' | 'datalist'
      rxBytes: [],
      viewBytes: [],
      rxRawChunks: [],
      rxByteFrameIds: [],
      rxFrames: [],
      rowSlices: [],
      maxCols: 16,

      frameBreakEnabled: true,
      frameRule: "timeout_maxlen", // 'timeout_maxlen' | 'delimiter' | 'fixed_len'
      frameTimeoutMs: 20,
      frameMaxLen: 0,
      frameDelimHex: "0D 0A",
      frameLayout: "frame_single", // 'frame_single' | 'continuous_16' | 'continuous_32' | 'frame_wrap16'
      showTimestamp: true,
      showTxInline: true,
      rxPaused: false,

      txBytes: initialBytes,
      txHexText: codec.bytesToHexString(initialBytes, true),
      txAsciiText: codec.bytesToUtf8Text(initialBytes),
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
      statusText: sess.statusText,
      dtr: sess.dtr,
      rts: sess.rts,
      cts: sess.cts,
      dsr: sess.dsr,
      cd: sess.cd,
      ri: sess.ri,
      autoSendInterval: sess.autoSendInterval,
      autoSendMaxCount: sess.autoSendMaxCount,
    });
  }

  const api = {
    createSessionState,
    serializeSessionForDetach,
  };

  global.PortAssist = global.PortAssist || {};
  global.PortAssist.sessionModel = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
