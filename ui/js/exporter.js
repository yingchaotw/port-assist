(function (global) {
  const codec =
    (global.PortAssist && global.PortAssist.codec) ||
    (typeof require !== "undefined" ? require("./codec") : null);

  function buildRxLogExport(sess, connSummary) {
    if (!sess) return null;
    const hasFixed = sess.fixedMap && sess.fixedMap.size > 0;
    const hasFrames = sess.rxFrames && sess.rxFrames.length > 0;
    const hasPackets = sess.packets && sess.packets.length > 0;
    if (!hasFixed && !hasFrames && !hasPackets) {
      return null;
    }

    const summary = connSummary || sess.portName || "PortAssist";
    const lines = [];
    if (sess.rxMode === "fixed" && hasFixed) {
      lines.push(
        `# PortAssist Fixed Table - ${summary} - Exported at ${new Date().toLocaleString()}`
      );
      lines.push(
        "# ID         | Type | DLC | Data (Hex)               | ASCII    | Count | Cycle (ms) | Time"
      );
      lines.push("");
      const sorted = Array.from(sess.fixedMap.values()).sort(
        (a, b) => (a.rawId ?? 0) - (b.rawId ?? 0)
      );
      for (const item of sorted) {
        const hexStr = codec.bytesToHexString(item.data, false);
        const asciiStr = item.data.map(codec.toPrintableAscii).join("");
        const cycStr = item.cycleMs > 0 ? item.cycleMs.toFixed(1) : "-";
        lines.push(
          `${item.idStr.padEnd(10)} | ${item.typeStr.padEnd(4)} | ${String(item.dlc).padEnd(3)} | ${hexStr.padEnd(24)} | ${asciiStr.padEnd(8)} | ${String(item.count).padStart(5)} | ${cycStr.padStart(10)} | ${item.timeStr}`
        );
      }
    } else {
      lines.push(`# PortAssist Log - ${summary} - Exported at ${new Date().toLocaleString()}`);
      lines.push("# Format: [Time] [Dir] (Length) Hex | ASCII");
      lines.push("");

      if (hasFrames) {
        for (let i = 0; i < sess.rxFrames.length; i++) {
          const f = sess.rxFrames[i];
          const slice = sess.viewBytes.slice(f.startIdx, f.startIdx + f.length);
          const hexStr = codec.bytesToHexString(slice, false);
          const asciiStr = slice.map(codec.toPrintableAscii).join("");
          const dirTag = (f.dir || "RX").padEnd(2, " ");
          const lenStr = String(f.length).padStart(3, " ");
          const pktMeta =
            sess.packets[i] && sess.packets[i].canMeta ? `[${sess.packets[i].canMeta}] ` : "";
          lines.push(
            `[${f.timeStr}] [${dirTag}] (${lenStr} B) ${pktMeta}${hexStr}  | ${asciiStr}`
          );
        }
      } else {
        for (let i = 0; i < sess.packets.length; i++) {
          const p = sess.packets[i];
          const bytes = p.previewBytes || [];
          const hexStr = codec.bytesToHexString(bytes, false);
          const asciiStr = bytes.map(codec.toPrintableAscii).join("");
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
    const safeName = summary.replace(/[^a-zA-Z0-9_-]/g, "_");
    return {
      content: lines.join("\r\n"),
      fileName: `accessport_${safeName}_${stamp}.txt`,
    };
  }

  const api = {
    buildRxLogExport,
  };

  global.PortAssist = global.PortAssist || {};
  global.PortAssist.exporter = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
