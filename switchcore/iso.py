"""ISO 8583 codec (pyiso8583, spec default_ascii) + TCP framing + virtual clock."""
from __future__ import annotations
import socket
import struct
from datetime import datetime, timedelta, timezone

import iso8583
from iso8583.specs import default_ascii as SPEC

from shared.schemas import Step

BASE_TIME = datetime(2026, 9, 27, 12, 0, 0, tzinfo=timezone.utc)
ENTRY = {"chip": "051", "swipe": "021", "online": "010"}


def build_request(step: Step, expiry_yymm: str = "2912") -> tuple[bytes, dict[str, str]]:
    t = BASE_TIME + timedelta(seconds=step.at_offset_s)
    f = {
        "t": step.mti,
        "2": step.pan,
        "3": "200000" if step.mti == "0400" else "000000",
        "4": f"{step.amount_cents:012d}",
        "7": t.strftime("%m%d%H%M%S"),
        "11": step.stan,
        "14": expiry_yymm,
        "18": step.mcc,
        "22": ENTRY[step.entry_mode],
        "41": "SWPROOF1",
        "48": f"PIN={'OK' if step.pin_ok else 'BAD'};GLITCH={int(step.force_glitch)}",
        "49": "840",
    }
    if step.mti == "0400":
        f["37"] = (step.original_stan or "").zfill(12)
    return encode(f), f


def encode(fields: dict[str, str]) -> bytes:
    raw, _ = iso8583.encode(dict(fields), SPEC)
    return bytes(raw)


def parse(raw: bytes) -> dict[str, str]:
    doc, _ = iso8583.decode(bytearray(raw), SPEC)
    doc.pop("p", None)
    return doc


def build_response(req: dict[str, str], code: str) -> bytes:
    f = {k: v for k, v in req.items() if k != "p"}
    f["t"] = req["t"][:2] + str(int(req["t"][2]) + 1) + req["t"][3]   # 0200 -> 0210
    f["39"] = code
    return encode(f)


def txn_time(fields: dict[str, str]) -> datetime:
    """Field 7 (MMDDhhmmss) back to a datetime; year comes from the virtual clock."""
    return datetime.strptime(f"{BASE_TIME.year}{fields['7']}", "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def frame(raw: bytes) -> bytes:
    return struct.pack(">H", len(raw)) + raw


def _recv_all(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("socket closed mid-frame")
        buf += chunk
    return buf


def read_frame(sock: socket.socket) -> bytes:
    (n,) = struct.unpack(">H", _recv_all(sock, 2))
    return _recv_all(sock, n)
