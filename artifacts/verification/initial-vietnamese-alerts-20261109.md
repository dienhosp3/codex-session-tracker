# Approved initial Vietnamese alerts — 0.12.38

Applied exactly the two actions in the user's reviewed JSON:

- `attention_approval_initial`: **Codex đang chờ duyệt thao tác**
- `attention_input_initial`: **Codex đang chờ câu trả lời của bạn**

Generated only `media/attention_voice/approval_initial.wav` and
`media/attention_voice/input_initial.wav`, using the project's existing Vietnamese
voice generator with `--only approval_initial input_initial`. The catalog records
the exact approved text. Runtime playback uses bundled PCM in memory, with no TTS
service, network request or temporary file at playback time.

The default initial waiting notification now speaks the corresponding sentence.
Simultaneous new states use the two existing new clips in order; a later new
waiting kind announces only that kind. Existing reminder timing, quota speech and
MP3 error behavior remain unchanged. An explicitly configured custom waiting MP3
is still respected. Default preview plays both approved initial phrases.

Verification:

- All 349 Node tests passed, covering exact phrases, clip selection, combined
  PCM composition, new-state-only announcements, offline player dispatch,
  missing-asset errors, custom MP3 precedence, preview and unchanged reminders.
- Real Windows SoundPlayer successfully played each new clip from memory through
  the extension's actual playback function. It returned `bundled-wav` and the
  expected byte count for each. The native smoke test passed.
- FFprobe verified PCM 16-bit, mono, 22050 Hz. Durations are approximately
  2.592 seconds (approval) and 2.784 seconds (input).
- SHA-256 comparison against the baseline taken before generation confirmed all
  **199 pre-existing audio files are byte-for-byte unchanged**: the 95 previous
  attention WAVs, 102 quota WAVs and both error MP3s. Only two WAVs were added.
- Approval clip SHA-256: `ef511e054b39ab3b7d814730e2dd1166adfbada6e94dfef85fa4da8614d61f27`.
- Input clip SHA-256: `df174e5b0043f6bf809c16dd967ee086e73c7d41538866435ae5525f358b9033`.
- JavaScript syntax and git diff --check passed. Packaging requires both new WAV
  entries and verifies packaged contents against source/runtime hashes.
  All 272 entries passed; VSIX SHA-256:
  `f46121a4df2f713819ef8f0ab85a2abda3dfeb36acc2f4460709277ea1e3dcdf`.
- Generation, tests and packaging use the shared ACL helper with the ordinary
  LEGION\SP3 token. Access probes and cleanup are enforced by the runners.
  Zero scratch run directories remain after packaging.
- No live chat/model call, extension installation, publish or push was performed.

[Runtime provenance](../checkpoints/initial-vietnamese-alerts-0.12.38-20261109.json).
