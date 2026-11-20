(function (global) {
  const codec =
    (global.PortAssist && global.PortAssist.codec) ||
    (typeof require !== "undefined" ? require("./codec") : null);
  const framer =
    (global.PortAssist && global.PortAssist.framer) ||
    (typeof require !== "undefined" ? require("./framer") : null);

  function formatCanMeta(frame) {
    const idHex = frame.extended
      ? frame.id.toString(16).toUpperCase().padStart(8, "0")
      : frame.id.toString(16).toUpperCase().padStart(3, "0");
    const kindTag = frame.rtr ? "RTR" : frame.extended ? "Ext" : "Std";
    return {
      idHex,
      kindTag,
      canMeta: `ID:0x${idHex} ${kindTag} DLC:${frame.dlc}`,
    };
  }

  function applyPcanBatchToSession(sess, batchNowMs, frames, timeStr) {
    if (!sess || !frames || frames.length === 0) return;
    const nowWallStr = timeStr || codec.formatTimestamp();

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const dataBytes = Array.isArray(f.data) ? f.data : [];
      const { idHex, kindTag, canMeta } = formatCanMeta(f);

      const chunk = {
        perfMs: f.perfMs ?? batchNowMs,
        timeStr: nowWallStr,
        dir: "RX",
        bytes: dataBytes,
        canMeta,
      };

      if (dataBytes.length > 0) {
        sess.rxRawChunks.push(chunk);
        framer.appendChunkIncremental(sess, chunk);
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
          canMeta,
        });
      }

      if (sess.packets.length > 0) {
        sess.packets[sess.packets.length - 1].canMeta = canMeta;
      }

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
  }

  const api = {
    formatCanMeta,
    applyPcanBatchToSession,
  };

  global.PortAssist = global.PortAssist || {};
  global.PortAssist.canParser = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
