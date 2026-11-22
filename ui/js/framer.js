(function (global) {
  const codec =
    (global.PortAssist && global.PortAssist.codec) ||
    (typeof require !== "undefined" ? require("./codec") : null);

  const MAX_SINGLE_ROW_COLS = 512;

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

  function deriveFixedFrameIdentity(dir, frameBytes) {
    const prefix = dir || "RX";
    if (!frameBytes || frameBytes.length === 0) {
      return { key: `${prefix}_EMPTY`, idStr: `[${prefix}]`, rawId: prefix === "TX" ? 1 : 0 };
    }

    const sampleLen = Math.min(frameBytes.length, 32);
    let printableCount = 0;
    for (let i = 0; i < sampleLen; i++) {
      const b = frameBytes[i];
      if ((b >= 0x20 && b <= 0x7e) || b === 0x0d || b === 0x0a || b === 0x09) {
        printableCount++;
      }
    }

    if (printableCount === sampleLen && frameBytes.length >= 2) {
      const text = codec.bytesToUtf8Text(frameBytes.slice(0, 24)).trim();
      const tokenMatch = text.match(/^([A-Za-z0-9_+*?#-]{1,12})/);
      if (tokenMatch) {
        const tag = tokenMatch[1];
        let hash = 0;
        for (let i = 0; i < tag.length; i++) {
          hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
        }
        return {
          key: `${prefix}_ASC_${tag}`,
          idStr: `${prefix} ${tag}`,
          rawId: (prefix === "TX" ? 0x20000000 : 0x10000000) + (hash & 0xfffffff),
        };
      }
    }

    const hdrBytes = frameBytes.slice(0, Math.min(2, frameBytes.length));
    const hdrHex = hdrBytes.map(codec.toHex2).join(" ");
    const numericHdr = hdrBytes.length >= 2 ? (hdrBytes[0] << 8) | hdrBytes[1] : hdrBytes[0];
    return {
      key: `${prefix}_HEX_${hdrHex}`,
      idStr: `${prefix} ${hdrHex}`,
      rawId: (prefix === "TX" ? 0x10000 : 0) + numericHdr,
    };
  }

  function upsertFixedMapForFrame(sess, dir, frameBytes, timeStr, perfMs, frameRef) {
    if (!sess || sess.connType === "pcan") return;
    if (!sess.fixedMap) sess.fixedMap = new Map();

    const { key, idStr, rawId } = deriveFixedFrameIdentity(dir, frameBytes);
    const nowPerf = perfMs || (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
    const dataSlice = frameBytes.slice(0, 32);

    if (frameRef && frameRef._fixedKey && frameRef._fixedKey !== key) {
      const prevEntry = sess.fixedMap.get(frameRef._fixedKey);
      if (prevEntry && prevEntry.count <= 1) {
        sess.fixedMap.delete(frameRef._fixedKey);
      }
      frameRef._fixedKey = null;
    }

    const isSameOpenFrame = Boolean(frameRef && frameRef._fixedKey === key);
    let item = sess.fixedMap.get(key);

    if (!item) {
      sess.fixedMap.set(key, {
        key,
        idStr,
        rawId,
        extended: false,
        rtr: false,
        typeStr: (sess.connType || "COM").toUpperCase(),
        dlc: frameBytes.length,
        data: dataSlice,
        prevData: [],
        count: 1,
        lastPerfMs: nowPerf,
        cycleMs: 0,
        timeStr,
      });
    } else if (isSameOpenFrame) {
      item.dlc = frameBytes.length;
      item.data = dataSlice;
      item.timeStr = timeStr;
      item.lastPerfMs = nowPerf;
    } else {
      item.count += 1;
      item.cycleMs = Math.max(0, nowPerf - item.lastPerfMs);
      item.lastPerfMs = nowPerf;
      item.timeStr = timeStr;
      item.dlc = frameBytes.length;
      item.prevData = item.data;
      item.data = dataSlice;
    }

    if (frameRef) {
      frameRef._fixedKey = key;
    }
  }

  function appendChunkIncremental(sess, chunk) {
    const len = chunk.bytes.length;
    if (len === 0) return;
    const dir = chunk.dir || "RX";

    if (dir === "TX") {
      sess.packets.push({
        time: chunk.timeStr,
        dir: "TX",
        previewBytes: chunk.bytes.length > 256 ? chunk.bytes.slice(0, 256) : chunk.bytes.slice(),
        byteLength: len,
        lastPerfMs: chunk.perfMs,
        closed: true,
      });

      if (!sess.showTxInline) return;
      upsertFixedMapForFrame(sess, "TX", chunk.bytes, chunk.timeStr, chunk.perfMs, null);

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
        ? codec.parseHexInput(sess.frameDelimHex || "").bytes
        : [];
    const delimLen = delimBytes.length;

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

    const baud = Math.max(300, parseInt(sess.baudRate, 10) || 115200);
    const msPerByte = 10000 / baud;
    const getFrameTimeAtOffset = (byteIdxInChunk) => {
      if (byteIdxInChunk <= 0 || typeof chunk.wallMs !== "number") {
        return chunk.timeStr;
      }
      return codec.formatDateToTimeStr(new Date(Math.round(chunk.wallMs + byteIdxInChunk * msPerByte)));
    };

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
        const frameSlice = sess.viewBytes.slice(curFrame.startIdx, curFrame.startIdx + curFrame.length);
        upsertFixedMapForFrame(sess, "RX", frameSlice, curFrame.timeStr, curFrame.lastPerfMs, curFrame);
        offset = endOffset;
      }
      return;
    }

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

      if (maxLen > 0 && curFrame.length >= maxLen) {
        curFrame.closed = true;
        if (curPkt) curPkt.closed = true;
      } else if (delimLen > 0 && curFrame.length >= delimLen) {
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
      const frameSlice = sess.viewBytes.slice(frame.startIdx, frame.startIdx + frame.length);
      upsertFixedMapForFrame(sess, "RX", frameSlice, frame.timeStr, frame.lastPerfMs, frame);
    }
  }

  function recalculateFramesState(sess) {
    if (!sess) return;
    sess.viewBytes = [];
    sess.rxByteFrameIds = [];
    sess.rxFrames = [];
    sess.rowSlices = [];
    sess.packets = [];
    sess.rxPktCount = 0;
    if (sess.connType !== "pcan") {
      sess.fixedMap = new Map();
    }
    sess.maxCols = sess.frameLayout === "continuous_32" ? 32 : 16;

    for (let i = 0; i < sess.rxRawChunks.length; i++) {
      appendChunkIncremental(sess, sess.rxRawChunks[i]);
    }
    rebuildRowSlicesForSession(sess);
  }

  const api = {
    MAX_SINGLE_ROW_COLS,
    rebuildRowSlicesForSession,
    incrementalUpdateRowsForFrame,
    appendChunkIncremental,
    recalculateFramesState,
  };

  global.PortAssist = global.PortAssist || {};
  global.PortAssist.framer = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
