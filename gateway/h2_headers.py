"""Decode only HPACK metadata; never export credentials or raw header blocks."""
import hpack

PREFACE = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
SAFE = {":method", ":status", "content-type", "content-length", "content-encoding", "accept", "user-agent"}


class HeaderDecoder:
    def __init__(self):
        self.connections = {}

    def close(self, key):
        self.connections.pop(key, None)

    def feed(self, event, data):
        key = event["connectionId"]
        if key not in self.connections:
            if len(self.connections) >= 256:
                self.connections.pop(next(iter(self.connections)))
            self.connections[key] = {"h2": False, "out": self.stream(), "in": self.stream()}
        conn = self.connections[key]
        direction = event["direction"]
        stream = conn[direction]
        if stream["disabled"]:
            return []
        stream["buffer"] += data
        if not conn["h2"]:
            if direction == "out" and len(stream["buffer"]) < len(PREFACE) and PREFACE.startswith(stream["buffer"]):
                return []
            if direction == "out" and stream["buffer"].startswith(PREFACE):
                conn["h2"] = True
                stream["buffer"] = stream["buffer"][len(PREFACE):]
            else:
                # Do not retain HTTP/1 headers or unsynchronized plaintext.
                stream["buffer"] = b""
                return []
        output = []
        while len(stream["buffer"]) >= 9:
            frame = stream["buffer"]
            length = int.from_bytes(frame[:3], "big")
            if length > 1024 * 1024:
                stream["disabled"] = True
                stream["buffer"] = b""
                return output
            if len(frame) < length + 9:
                return output
            kind, flags = frame[3], frame[4]
            sid = int.from_bytes(frame[5:9], "big") & 0x7fffffff
            payload = frame[9:9 + length]
            stream["buffer"] = frame[9 + length:]
            if kind == 4 and not flags & 1 and len(payload) % 6 == 0:
                peer = conn["in" if direction == "out" else "out"]
                for index in range(0, len(payload), 6):
                    setting = int.from_bytes(payload[index:index + 2], "big")
                    size = int.from_bytes(payload[index + 2:index + 6], "big")
                    if setting == 1:
                        peer["decoder"].max_allowed_table_size = min(size, 65536)
            if kind not in (1, 9):
                continue
            if kind == 1:
                offset = 1 if flags & 8 else 0
                padding = payload[0] if flags & 8 and payload else 0
                offset += 5 if flags & 32 else 0
                if offset + padding > len(payload):
                    stream["disabled"] = True
                    return output
                payload = payload[offset:len(payload) - padding if padding else len(payload)]
                if stream["pending"] is not None:
                    stream["disabled"] = True
                    return output
                stream["pending"] = sid
                stream["headers"] = b""
            elif stream["pending"] != sid:
                stream["disabled"] = True
                return output
            stream["headers"] += payload
            if len(stream["headers"]) > 65536:
                stream["disabled"] = True
                return output
            if not flags & 4:
                continue
            try:
                values = stream["decoder"].decode(stream["headers"])
                headers = {}
                for name, value in values:
                    if name == ":path":
                        headers[name] = value.split("?", 1)[0]
                    elif name == ":authority":
                        headers[name] = value
                    elif name in SAFE:
                        headers[name] = value
                    else:
                        headers[name] = "[REDACTED]"
                output.append({"type": "h2_headers", "direction": direction, "connectionId": key,
                               "streamId": sid, "headers": headers, "at": event["at"]})
            except Exception:
                # Mid-connection attach can lack the HPACK dynamic table.
                output.append({"type": "h2_headers_unavailable", "connectionId": key,
                               "direction": direction, "streamId": sid, "at": event["at"]})
                stream["disabled"] = True
            stream["pending"] = None
            stream["headers"] = b""
        return output

    @staticmethod
    def stream():
        return {"buffer": b"", "headers": b"", "pending": None,
                "decoder": hpack.Decoder(max_header_list_size=65536), "disabled": False}
