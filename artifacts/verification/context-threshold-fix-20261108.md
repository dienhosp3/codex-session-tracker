# Context threshold fix 0.12.29

Changing the configured threshold now updates enabled existing watches as well
as the default for new chats. Explicitly saving the same default also applies it
to existing watches that retained an older threshold. Individual watched chats
remain editable through their threshold field and Save/Enter.

Reproduced the previous Save failure in real Edge: a background full-state
refresh followed by input blur replaced the Save button before pointer-up.
The fix preserves edits per chat, defers rendering during button presses, and
acknowledges successful persistence before displaying the saved percentage.

- 313 Node tests passed, including changing an enabled watch, global changes,
  applying the existing default again, and restoring saved thresholds.
- Real Edge regression passed at widths 1000/520/320: existing 80% watch changed
  to 85%, delayed Save click during polling, saved-value refresh, Enter to save,
  and acknowledgement. Zero page errors.
- VSIX: 166 entries; required files, source bytes and existing runtime digest
  verified. SHA-256: `6a9fb1ae802407cda0f0086fdd5e7bf0d4c925fc86edf7d0ca063907f26ce629`.
- ACL/probes ran as ordinary LEGION\SP3; owned test/build/install scratch cleaned.

Provenance: [checkpoint](../checkpoints/context-threshold-fix-0.12.29-20261108.json).
