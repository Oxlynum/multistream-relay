"""
bpm_inject.py — HEVC Broadcast Performance Metrics (BPM) SEI injector for
Twitch Enhanced Broadcasting passthrough.

Twitch's Enhanced Broadcasting ingest requires Broadcast Performance Metrics
(BPM) SEI messages on every IDR access unit — it's one of the two mandatory
features (the other is the GetClientConfiguration call, handled in
supervisor.py). OBS inserts these from its encoder; a raw `-c copy` passthrough
of hardware-encoder HEVC (Apple VideoToolbox, NVENC, AMF, …) has none, so Twitch accepts the connection, receives
a few seconds, then disconnects ("Broadcast performance metrics do not precede
every IDR on every track").

This injector sits in the middle of the Twitch eRTMP pipeline as an MPEG-TS
filter: it demuxes the HEVC + AAC feed (libav handles all container timing / A-V
sync), appends the three BPM SEI NALs (TS, SM, ERM) to each video keyframe access
unit at the bitstream level — no re-encode, no quality loss — and re-emits
MPEG-TS. The proven jellyfin-ffmpeg handles the network I/O on either side:

  ffmpeg -i srt://… -c copy -f mpegts pipe:1 \
    | python3 bpm_inject.py \
    | ffmpeg -i pipe:0 -c copy -f flv rtmps://…ingest…   (Enhanced-RTMP HEVC)

Keeping ffmpeg on both ends means PyAV only ever touches pipe + mpegts (universally
supported), avoiding any dependency on the PyAV wheel bundling libsrt / rtmps.

Byte layout matches OBS's reference implementation (shared/bpm/bpm.c):
suffix SEI (HEVC NAL type 40), user_data_unregistered (payloadType 5), the three
documented UUIDs, RFC3339 timestamps, and the SM/ERM frame counters. Counters are
0 — explicitly valid per the IVS spec ("counters set to 0 in the first segment")
and sufficient for ingest admission, which checks BPM *presence* before each IDR.

Usage:
  python3 bpm_inject.py                       # stdin (mpegts) -> stdout (mpegts)
  python3 bpm_inject.py <in_url> <out_url>     # direct, output FLV (testing)
"""

from __future__ import annotations

import sys
import time

import av

# ---- BPM SEI constants (from OBS shared/bpm/bpm-internal.h) ----------------
BPM_TS_UUID = bytes([0x0a, 0xec, 0xff, 0xe7, 0x52, 0x72, 0x4e, 0x2f,
                     0xa6, 0x2f, 0xd1, 0x9c, 0xd6, 0x1a, 0x93, 0xb5])
BPM_SM_UUID = bytes([0xca, 0x60, 0xe7, 0x1c, 0x6a, 0x8b, 0x43, 0x88,
                     0xa3, 0x77, 0x15, 0x1d, 0xf7, 0xbf, 0x8a, 0xc2])
BPM_ERM_UUID = bytes([0xf1, 0xfb, 0xc1, 0xd5, 0x10, 0x1e, 0x4f, 0xb5,
                      0xa6, 0x1e, 0xb8, 0xce, 0x3c, 0x07, 0xb8, 0xc0])

BPM_TS_RFC3339 = 1       # timestamp type: RFC3339 string
BPM_TS_EVENT_CTS = 1     # composition time event
BPM_TS_EVENT_PIR = 4     # packet interleave request event

# HEVC suffix SEI NAL: forbidden_zero(0) nal_type(40) layer_id(0) tid_plus1(1).
# byte0 = (40 << 1) = 0x50, byte1 = 0x01. Matches OBS (suffix_sei_nal_type=40).
HEVC_SEI_NAL_HEADER = bytes([0x50, 0x01])
START_CODE_3 = b"\x00\x00\x01"

# HEVC IRAP (keyframe) VCL NAL types: BLA/IDR/CRA span 16..23. We detect these by
# parsing the bitstream rather than trusting the container keyframe flag, which is
# not reliably set after an `-c copy` mpegts re-mux feeding PyAV.
HEVC_IRAP_MIN = 16
HEVC_IRAP_MAX = 23


def _rfc3339_now() -> bytes:
    """RFC3339 UTC with millisecond precision, e.g. 2026-06-27T08:00:00.123Z.
    Written WITH a trailing null byte, exactly as OBS does (strlen + 1)."""
    t = time.time()
    ms = int((t - int(t)) * 1000)
    s = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{ms:03d}Z"
    return s.encode("ascii") + b"\x00"


def _u32be(n: int) -> bytes:
    return (n & 0xFFFFFFFF).to_bytes(4, "big")


def _bpm_ts_payload(ts: bytes) -> bytes:
    """BPM Timestamp SEI payload (after the UUID). Two timestamps: CTS + PIR."""
    out = bytearray()
    out.append((2 - 1) & 0x0F)             # num_timestamps_minus1
    out.append(BPM_TS_RFC3339); out.append(BPM_TS_EVENT_CTS); out += ts
    out.append(BPM_TS_RFC3339); out.append(BPM_TS_EVENT_PIR); out += ts
    return bytes(out)


def _bpm_sm_payload(ts: bytes) -> bytes:
    """BPM Session Metrics SEI payload (after the UUID). 4 counters, all 0."""
    out = bytearray()
    out.append((1 - 1) & 0x0F)             # num_timestamps_minus1
    out.append(BPM_TS_RFC3339); out.append(BPM_TS_EVENT_PIR); out += ts
    out.append((4 - 1) & 0x0F)             # num_counters_minus1
    for tag in (1, 2, 3, 4):               # rendered, lagged, dropped, output
        out.append(tag); out += _u32be(0)
    return bytes(out)


def _bpm_erm_payload(ts: bytes) -> bytes:
    """BPM Encoded Rendition Metrics SEI payload (after the UUID). 3 counters, 0."""
    out = bytearray()
    out.append((1 - 1) & 0x0F)             # num_timestamps_minus1
    out.append(BPM_TS_RFC3339); out.append(BPM_TS_EVENT_PIR); out += ts
    out.append((3 - 1) & 0x0F)             # num_counters_minus1
    for tag in (1, 2, 3):                  # input, skipped, output
        out.append(tag); out += _u32be(0)
    return bytes(out)


def _emulation_prevent(rbsp: bytes) -> bytes:
    """Insert emulation-prevention bytes: 0x03 after any 0x0000 followed by a
    byte <= 0x03. Required so payload data can't be mistaken for a start code."""
    out = bytearray()
    zeros = 0
    for b in rbsp:
        if zeros >= 2 and b <= 0x03:
            out.append(0x03)
            zeros = 0
        out.append(b)
        zeros = zeros + 1 if b == 0 else 0
    return bytes(out)


def _build_sei_nal(uuid: bytes, payload: bytes) -> bytes:
    """One HEVC suffix-SEI NAL (Annex-B) carrying a user_data_unregistered
    message: start code + 2-byte NAL header + EPB(payloadType + payloadSize +
    UUID + payload + rbsp trailing)."""
    data = uuid + payload                              # SEI payload = UUID + body
    rbsp = bytearray()
    rbsp.append(5)                                     # payloadType = user_data_unregistered
    size = len(data)
    while size >= 255:                                 # payloadSize (0xFF-extended)
        rbsp.append(0xFF); size -= 255
    rbsp.append(size)
    rbsp += data
    rbsp.append(0x80)                                  # rbsp_trailing_bits
    return START_CODE_3 + HEVC_SEI_NAL_HEADER + _emulation_prevent(bytes(rbsp))


def _bpm_block() -> bytes:
    """The three BPM SEI NALs concatenated, with a freshly stamped timestamp."""
    ts = _rfc3339_now()
    return (_build_sei_nal(BPM_TS_UUID, _bpm_ts_payload(ts))
            + _build_sei_nal(BPM_SM_UUID, _bpm_sm_payload(ts))
            + _build_sei_nal(BPM_ERM_UUID, _bpm_erm_payload(ts)))


def _has_irap(data: bytes) -> bool:
    """True if the access unit contains an HEVC IRAP (keyframe) VCL NAL. Scans
    Annex-B start codes with bytes.find (fast), checking nal_unit_type 16..23."""
    pos = data.find(b"\x00\x00\x01")
    while pos != -1 and pos + 3 < len(data):
        nt = (data[pos + 3] >> 1) & 0x3F
        if HEVC_IRAP_MIN <= nt <= HEVC_IRAP_MAX:
            return True
        pos = data.find(b"\x00\x00\x01", pos + 3)
    return False


def inject(data: bytes) -> bytes:
    """Append the BPM SEI block to a keyframe access unit. Suffix SEI (type 40)
    must follow the VCL NALs, so appending at the end of the AU is correct."""
    return data + _bpm_block()


def run(src, dst, out_format: str) -> int:
    inp = av.open(src)
    out = av.open(dst, "w", format=out_format)

    smap = {}
    for s in inp.streams:
        if s.type in ("video", "audio"):
            smap[s.index] = out.add_stream_from_template(s)

    vid = inp.streams.video[0].index if inp.streams.video else None

    injected = 0
    vframes = 0
    for pkt in inp.demux():
        if pkt.dts is None or pkt.stream.index not in smap:
            continue
        ostream = smap[pkt.stream.index]

        is_key = pkt.stream.index == vid and (pkt.is_keyframe or _has_irap(bytes(pkt)))
        if pkt.stream.index == vid:
            vframes += 1

        if is_key:
            new = av.Packet(inject(bytes(pkt)))
            new.pts = pkt.pts
            new.dts = pkt.dts
            new.time_base = pkt.time_base
            new.duration = pkt.duration
            new.stream = ostream
            # Preserve the keyframe flag so the muxer marks the frame type.
            new.is_keyframe = True
            out.mux(new)
            injected += 1
            if injected <= 3 or injected % 30 == 0:
                print(f"[bpm] injected BPM SEI into {injected} keyframes "
                      f"({vframes} video frames seen)", file=sys.stderr, flush=True)
        else:
            pkt.stream = ostream
            out.mux(pkt)

    out.close()
    inp.close()
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 1:
        # Pipeline mode: mpegts on stdin -> inject -> mpegts on stdout.
        sys.exit(run(sys.stdin.buffer, sys.stdout.buffer, "mpegts"))
    if len(sys.argv) == 3:
        # Direct mode (testing): read a URL/file, write FLV.
        sys.exit(run(sys.argv[1], sys.argv[2], "flv"))
    print("usage: bpm_inject.py [<input_url> <output_url>]", file=sys.stderr)
    sys.exit(2)
