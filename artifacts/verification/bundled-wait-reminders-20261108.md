# Bundled Vietnamese waiting reminders — 0.12.32

Periodic waiting alerts now speak the elapsed time in Vietnamese: “Đã 5 phút
chưa xác nhận” or “Đã 5 phút chưa có câu trả lời”, then 10, 15 minutes and onward.
Each waiting kind retains its original start time; audio playback and failed
deliveries do not reset elapsed duration. Resolving the wait clears its timer.

The extension ships 95 prerecorded PCM WAV assets (about 7.9 MB), including
48 complete sentences for the common five-minute milestones through 120
minutes. Longer and delayed waits compose the shipped number phrases. The
phrase index is `media/attention_voice/phrases.json`. Generation uses the same
Vietnamese recording source as the existing quota assets. Runtime playback
uses only bundled WAV bytes piped into a hidden player; it does not synthesize
speech, require Microsoft An, access a speech service or create scratch files.

Validation:

- 327 Node tests passed, including the extension's initial beep versus speech
  dispatch, cumulative 5/10/15-minute wording, separate waiting kinds, clearing,
  audio failures, packaged audio selection and large elapsed values.
- Actual Windows playback passed for 5-minute approval, 10-minute input,
  15-minute approval and 125-minute input. WAV data was composed and played
  entirely in memory; the player acknowledged the bundled audio source.
- Generation and tests used the ordinary LEGION\SP3 token and the shared ACL
  helper. Their owned scratch was removed after completion.
- VSIX 0.12.32 contains 265 entries, all matched against source and the existing
  runtime hash. SHA-256:
  `e6451d3b6bbb8333946142e7186ebdb1b46d310d57737250980b3c65066b9e53`.
- Installed in VS Code and verified source, manifest, all 95 WAV files and
  installed asset lookup. Owned scratch remaining after install: zero.

[Runtime provenance](../checkpoints/bundled-wait-reminders-0.12.32-20261108.json).
