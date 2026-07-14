# Whisper to your file system — launch copy (draft)

Marketing copy for the desktop-widget + Whisper-mode launch (W4). Draft for
the site and release announcement; trim per surface.

## One-liner

**Whisper to your file system.** Lighthouse puts a private AI search bar one
keystroke away — ask anything about your own files, get a grounded answer with
citations, never leave what you're doing.

## Hero

A floating search bar that lives on your desktop. Tap **Ctrl + Super + Shift**
and Lighthouse appears over whatever you're working on. Ask a question — the
answer streams right there, cited to your own documents. Press it again and
it's gone. Your files never leave your machine.

If you've used Wispr Flow to talk to your computer, this is the same reflex,
pointed at everything you've ever saved.

## How it works (three beats)

1. **Summon.** One chord from anywhere — no window to find, no app to switch
   to. Prefer a classic window? Lighthouse runs that way too; the bar is still
   a keystroke away.
2. **Ask.** Type a question. Lighthouse searches only the files you've made
   visible to it and answers inline, with citation chips that open the source.
3. **Stay.** The answer freezes on your desktop while you keep reading your
   document. Dismiss when you're done — or hand it to the full app for the big
   canvas.

## What makes it different

- **Local-first and private.** Your vault stays on your disk. The local model
  runs on your machine; nothing is uploaded to answer a question.
- **You choose what it sees.** Every file has a visibility toggle. Select all,
  or curate file by file — the AI only reads what you've included.
- **It's genuinely fast.** Rewritten in Rust: a ten-thousand-file vault indexes
  in under a second and answers instantly, without pinning your CPU.
- **Two ways to live on your desktop.** Classic window, or the experimental
  widget where the search bar *is* the app and the window waits in the tray.

## Whisper mode (the pitch line)

Most search boxes make you go to them. Whisper mode brings the search box to
you: a modifier-only tap — hold **Ctrl + Super + Shift**, no letter key — and
the bar is there. It's opt-in, it's per-platform native (a keyboard hook on
Windows, an event monitor on macOS, raw input on X11), and it never eats a
keystroke it shouldn't.

## Availability line

Free trial. Windows, macOS, and Linux. Download at **lhvault.app**.

*(Unsigned builds today — SmartScreen/Gatekeeper may warn on first launch;
the signing pipeline is wired and awaits certificates — docs/signing.md.
Once signed, in-app updates are one click and cryptographically verified;
until then the update notice links to the releases page.)*
