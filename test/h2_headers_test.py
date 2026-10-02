import pathlib
import sys
import unittest

import hpack

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "gateway"))
from h2_headers import HeaderDecoder, PREFACE


def frame(kind, flags, sid, payload):
    return len(payload).to_bytes(3, "big") + bytes([kind, flags]) + sid.to_bytes(4, "big") + payload


class HeaderTests(unittest.TestCase):
    def setUp(self):
        self.decoder = HeaderDecoder()
        self.event = {"connectionId": "fixture", "direction": "out", "at": 1}

    def test_fragmented_headers_reveal_endpoint_without_auth(self):
        encoder = hpack.Encoder()
        block = encoder.encode([(":method", "POST"), (":path", "/backend-api/codex/responses?token=secret-query"),
                                (":authority", "localhost"), ("authorization", "Bearer secret-auth"), ("cookie", "secret-cookie")])
        wire = PREFACE + frame(1, 0, 3, block[:5]) + frame(9, 4, 3, block[5:])
        events = []
        for index in range(0, len(wire), 3):
            events.extend(self.decoder.feed(self.event, wire[index:index + 3]))
        self.assertEqual(events[0]["headers"][":path"], "/backend-api/codex/responses")
        self.assertEqual(events[0]["headers"][":method"], "POST")
        self.assertNotIn("secret", str(events))

    def test_dynamic_table_and_response_stream_keep_endpoints_separate(self):
        encoder = hpack.Encoder()
        self.decoder.feed(self.event, PREFACE)
        for sid, endpoint in [(1, "/v1/responses"), (3, "/v1/models"), (5, "/v1/responses")]:
            events = self.decoder.feed(self.event, frame(1, 4, sid, encoder.encode([(":method", "POST"), (":path", endpoint)])))
            self.assertEqual(events[0]["streamId"], sid)
            self.assertEqual(events[0]["headers"][":path"], endpoint)
        inbound = dict(self.event, direction="in")
        response = hpack.Encoder().encode([(":status", "200"), ("content-type", "text/event-stream"), ("set-cookie", "secret")])
        events = self.decoder.feed(inbound, frame(1, 4, 3, response))
        self.assertEqual(events[0]["headers"][":status"], "200")
        self.assertNotIn("secret", str(events))

    def test_missing_dynamic_table_reports_unavailable(self):
        encoder = hpack.Encoder()
        encoder.encode([(":path", "/v1/responses")])
        block = encoder.encode([(":path", "/v1/responses")])
        events = self.decoder.feed(self.event, PREFACE + frame(1, 4, 1, block))
        self.assertEqual(events[0]["type"], "h2_headers_unavailable")


if __name__ == "__main__":
    unittest.main()
