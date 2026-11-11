"""Generate bundled, complete Vietnamese reminders; runtime playback is offline."""
import argparse
import concurrent.futures
import json
import pathlib
import subprocess
import urllib.parse
import urllib.request

ONES = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín']

def number(n):
    if n < 10:
        return ONES[n]
    if n < 20:
        return 'mười' + (' ' + ('lăm' if n == 15 else ONES[n % 10]) if n % 10 else '')
    if n >= 100:
        return ONES[n // 100] + ' trăm' + (' ' + ('linh ' if n % 100 < 10 else '') + number(n % 100) if n % 100 else '')
    return ONES[n // 10] + ' mươi' + (' ' + ('mốt' if n % 10 == 1 else 'lăm' if n % 10 == 5 else ONES[n % 10]) if n % 10 else '')

def phrases():
    result = {
        'approval_initial': 'Codex đang chờ duyệt thao tác',
        'input_initial': 'Codex đang chờ câu trả lời của bạn',
        'plan_ready': 'Đã lập xong kế hoạch. Có triển khai luôn không?',
        'chat_completed': 'Codex đã hoàn tất tác vụ',
        'chat_failed': 'Codex đã dừng do lỗi',
    }
    for minutes in range(5, 121, 5):
        for kind, ending in [('approval', 'chưa xác nhận'), ('input', 'chưa có câu trả lời')]:
            result[f'{kind}_{minutes}'] = f'Đã {number(minutes)} phút {ending}.'
    # Numeric text for single digits avoids the letter-name interpretation of
    # isolated Vietnamese words such as "ba". Usual 5/10/15/... reminders above
    # always use the complete sentence, never assembled digit recordings.
    result.update({f'number_{n}': str(n) if n < 10 else number(n) for n in range(20)})
    result.update({f'hundreds_{n}': ONES[n] + ' trăm' for n in range(10)})
    result.update({f'tens_{n}': number(n * 10) for n in range(2, 10)})
    result.update(elapsed='Đã', approval_suffix='phút chưa xác nhận.', input_suffix='phút chưa có câu trả lời.',
                  link='linh', one_after_tens='mốt', five_after_tens='lăm', thousand='nghìn', million='triệu', billion='tỷ')
    return result

def generate(item, scratch, output, ffmpeg):
    name, text = item
    target = output / (name + '.wav')
    if target.exists():
        return
    query = urllib.parse.urlencode({'ie': 'UTF-8', 'client': 'tw-ob', 'tl': 'vi', 'q': text})
    request = urllib.request.Request('https://translate.google.com/translate_tts?' + query, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read()
    if not data.startswith(b'ID3') and not (len(data) > 1 and data[0] == 255 and data[1] & 224 == 224):
        raise RuntimeError('Invalid MP3 for ' + name)
    mp3 = scratch / (name + '.mp3')
    try:
        mp3.write_bytes(data)
        subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', str(mp3), '-acodec', 'pcm_s16le', '-ar', '22050', '-ac', '1', str(target)], check=True)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    finally:
        mp3.unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scratch', required=True, type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / 'media' / 'attention_voice')
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--only', nargs='+', choices=list(phrases()), help='Generate only the named clips; keep all other assets untouched.')
    args = parser.parse_args()
    if not args.scratch.is_dir() or 'AHUST-Work' not in args.scratch.parts:
        raise RuntimeError('Use the ACL-verified scratch supplied by scripts/scratch.ps1')
    args.output.mkdir(parents=True, exist_ok=True)
    values = phrases()
    selected = {name: values[name] for name in args.only} if args.only else values
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        for _ in executor.map(lambda item: generate(item, args.scratch, args.output, args.ffmpeg), selected.items()):
            pass
    (args.output / 'phrases.json').write_text(json.dumps(values, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Generated/verified {len(selected)} selected clips; catalog contains {len(values)} clips.')

if __name__ == '__main__':
    main()
