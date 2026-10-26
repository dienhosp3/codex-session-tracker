#!/usr/bin/env python3
"""Generate the bundled Vietnamese quota voice clips.

The clips intentionally contain a complete sentence instead of isolated
digits.  Google Translate's Vietnamese voice can misread a one-word clip such
as ``ba`` or ``bảy`` as letter names; sentence context keeps the pronunciation
correct.  The generated files are ordinary PCM WAV files and are played
locally by the extension, so the tracker never calls Windows speech synthesis.
"""

from __future__ import annotations

import argparse
import pathlib
import subprocess
import tempfile
import urllib.parse
import urllib.request


ONES = ("không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín")


def vietnamese_number(value: int) -> str:
    if value < 10:
        return ONES[value]
    if value == 100:
        return "một trăm"
    tens, unit = divmod(value, 10)
    if tens == 1:
        if unit == 0:
            return "mười"
        return "mười " + ("lăm" if unit == 5 else ONES[unit])
    result = ONES[tens] + " mươi"
    if unit:
        result += " " + ("mốt" if unit == 1 else "tư" if unit == 4 else "lăm" if unit == 5 else ONES[unit])
    return result


def fetch_mp3(text: str) -> bytes:
    query = urllib.parse.urlencode({"ie": "UTF-8", "client": "tw-ob", "tl": "vi", "q": text})
    request = urllib.request.Request(
        "https://translate.google.com/translate_tts?" + query,
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read()
    if not data.startswith(b"ID3") and not (len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0):
        raise RuntimeError(f"TTS response for {text!r} is not an MP3")
    return data


def convert_to_wav(ffmpeg: str, mp3: pathlib.Path, wav: pathlib.Path) -> None:
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", str(mp3), "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1", str(wav)],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / "media" / "usage_voice")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    phrases = {"large_prefix": "quota thay đổi mạnh."}
    phrases.update({f"percent_{value}": f"quota năm giờ còn {vietnamese_number(value)} phần trăm." for value in range(101)})
    with tempfile.TemporaryDirectory(prefix="codex-usage-voice-") as temporary:
        temp = pathlib.Path(temporary)
        for name, phrase in phrases.items():
            target = args.output / f"{name}.wav"
            if target.exists() and not args.force:
                continue
            mp3 = temp / f"{name}.mp3"
            print(f"{name}: {phrase}")
            mp3.write_bytes(fetch_mp3(phrase))
            convert_to_wav(args.ffmpeg, mp3, target)


if __name__ == "__main__":
    main()
